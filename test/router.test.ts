import { describe, it, expect } from 'vitest';
import { RouterWithProviders, RouteError } from '../src/router/index.js';
import type { ProxyConfig } from '../src/types/index.js';

const mockConfig: ProxyConfig = {
  port: 3000,
  globalMaxConcurrent: 10,
  providers: [
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', format: 'openai' },
    { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-test2', format: 'anthropic' },
  ],
  models: [
    { alias: 'gpt-4o', providerId: 'openai', upstreamModel: 'gpt-4o' },
    { alias: 'claude-sonnet', providerId: 'anthropic', upstreamModel: 'claude-3-5-sonnet-20241022' },
    { alias: 'gpt-4o-mini', providerId: 'openai', upstreamModel: 'gpt-4o-mini', maxConcurrent: 5 },
  ],
};

describe('Router', () => {
  it('resolves a known alias', () => {
    const router = new RouterWithProviders(mockConfig);
    const route = router.resolve('gpt-4o');
    expect(route.provider.id).toBe('openai');
    expect(route.modelRoute.upstreamModel).toBe('gpt-4o');
  });

  it('resolves different providers', () => {
    const router = new RouterWithProviders(mockConfig);
    const route = router.resolve('claude-sonnet');
    expect(route.provider.id).toBe('anthropic');
    expect(route.provider.format).toBe('anthropic');
  });

  it('throws RouteError for unknown alias', () => {
    const router = new RouterWithProviders(mockConfig);
    expect(() => router.resolve('unknown-model')).toThrow(RouteError);
    expect(() => router.resolve('unknown-model')).toThrow(/not found/);
  });

  it('lists all model aliases', () => {
    const router = new RouterWithProviders(mockConfig);
    const models = router.listModels();
    expect(models).toHaveLength(3);
    expect(models).toContain('gpt-4o');
    expect(models).toContain('claude-sonnet');
    expect(models).toContain('gpt-4o-mini');
  });

  it('preserves maxConcurrent from route config', () => {
    const router = new RouterWithProviders(mockConfig);
    const route = router.resolve('gpt-4o-mini');
    expect(route.modelRoute.maxConcurrent).toBe(5);
  });
});
