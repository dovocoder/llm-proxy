import { describe, it, expect } from 'vitest';
import { TokenManager } from '../src/auth/token-manager.js';
import type { ProxyConfig } from '../src/types/index.js';

const baseConfig: ProxyConfig = {
  port: 3000,
  globalMaxConcurrent: 10,
  providers: [
    { id: 'p1', name: 'P1', baseUrl: 'https://api.test.com', apiKey: 'k', format: 'openai' },
  ],
  models: [
    { alias: 'gpt-4o', providerId: 'p1', upstreamModel: 'gpt-4o' },
    { alias: 'claude-sonnet', providerId: 'p1', upstreamModel: 'claude-3-5-sonnet' },
    { alias: 'llama-70b', providerId: 'p1', upstreamModel: 'llama-3.3-70b' },
  ],
};

describe('TokenManager', () => {
  it('detects when auth is not configured', () => {
    const tm = new TokenManager(baseConfig);
    expect(tm.authEnabled).toBe(false);
  });

  it('detects when auth is configured via tokens', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{ token: 'tok-1', name: 'client-a' }],
    });
    expect(tm.authEnabled).toBe(true);
  });

  it('detects when auth is configured via legacy authKey', () => {
    const tm = new TokenManager({ ...baseConfig, authKey: 'legacy-key' });
    expect(tm.authEnabled).toBe(true);
  });

  it('authenticates a valid named token', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{ token: 'tok-123', name: 'client-a', maxConcurrent: 3 }],
    });
    const result = tm.authenticate('tok-123');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('client-a');
    expect(result?.maxConcurrent).toBe(3);
  });

  it('returns null for invalid token', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{ token: 'tok-123', name: 'client-a' }],
    });
    expect(tm.authenticate('invalid')).toBeNull();
  });

  it('authenticates via legacy authKey', () => {
    const tm = new TokenManager({ ...baseConfig, authKey: 'legacy-key' });
    const result = tm.authenticate('legacy-key');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('legacy-authKey');
  });

  it('prefers named tokens over legacy authKey', () => {
    const tm = new TokenManager({
      ...baseConfig,
      authKey: 'legacy-key',
      tokens: [{ token: 'tok-123', name: 'client-a', maxConcurrent: 2 }],
    });
    const result = tm.authenticate('tok-123');
    expect(result?.name).toBe('client-a');
    expect(result?.maxConcurrent).toBe(2);
  });

  it('allows access to all models when allowedModels is not set', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{ token: 'tok-1', name: 'client-a' }],
    });
    const token = tm.authenticate('tok-1')!;
    expect(tm.canAccessModel(token, 'gpt-4o')).toBe(true);
    expect(tm.canAccessModel(token, 'claude-sonnet')).toBe(true);
    expect(tm.canAccessModel(token, 'llama-70b')).toBe(true);
  });

  it('restricts model access when allowedModels is set', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{
        token: 'tok-1', name: 'client-a',
        allowedModels: ['gpt-4o', 'claude-sonnet'],
      }],
    });
    const token = tm.authenticate('tok-1')!;
    expect(tm.canAccessModel(token, 'gpt-4o')).toBe(true);
    expect(tm.canAccessModel(token, 'claude-sonnet')).toBe(true);
    expect(tm.canAccessModel(token, 'llama-70b')).toBe(false);
  });

  it('filters visible models based on allowedModels', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{
        token: 'tok-1', name: 'client-a',
        allowedModels: ['gpt-4o'],
      }],
    });
    const token = tm.authenticate('tok-1')!;
    const allModels = ['gpt-4o', 'claude-sonnet', 'llama-70b'];
    const visible = tm.accessibleModels(token, allModels);
    expect(visible).toEqual(['gpt-4o']);
  });

  it('returns all models for legacy authKey token', () => {
    const tm = new TokenManager({ ...baseConfig, authKey: 'legacy-key' });
    const token = tm.authenticate('legacy-key')!;
    const allModels = ['gpt-4o', 'claude-sonnet', 'llama-70b'];
    expect(tm.accessibleModels(token, allModels)).toEqual(allModels);
  });

  it('handles empty allowedModels array as "all models"', () => {
    const tm = new TokenManager({
      ...baseConfig,
      tokens: [{ token: 'tok-1', name: 'client-a', allowedModels: [] }],
    });
    const token = tm.authenticate('tok-1')!;
    expect(tm.canAccessModel(token, 'gpt-4o')).toBe(true);
  });
});
