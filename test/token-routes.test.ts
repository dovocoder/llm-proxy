import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We mock global fetch to simulate upstream providers.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockOpenAIResponse(text: string): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4o',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  };
}

describe('API tokens', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-token-test-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: 0,
      globalMaxConcurrent: 10,
      providers: [
        {
          id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test', format: 'openai',
        },
      ],
      models: [
        { alias: 'gpt-4o', providerId: 'openai', upstreamModel: 'gpt-4o' },
        { alias: 'gpt-4o-mini', providerId: 'openai', upstreamModel: 'gpt-4o-mini' },
        { alias: 'claude-sonnet', providerId: 'openai', upstreamModel: 'claude-3-5-sonnet' },
      ],
      tokens: [
        {
          token: 'tok-full-access',
          name: 'admin',
        },
        {
          token: 'tok-limited',
          name: 'restricted-client',
          maxConcurrent: 2,
          allowedModels: ['gpt-4o', 'gpt-4o-mini'],
        },
        {
          token: 'tok-single-model',
          name: 'single-client',
          allowedModels: ['gpt-4o'],
        },
      ],
    }));

    app = await createServer(configPath);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    mockFetch.mockReset();
  });

  // ─── Authentication ─────────────────────────────────────────────────

  it('returns 401 when no token is provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer invalid-tok' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts valid full-access token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer tok-full-access' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(3);
  });

  // ─── Model filtering in /v1/models ──────────────────────────────────

  it('filters /v1/models by allowedModels', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer tok-limited' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('gpt-4o-mini');
    expect(ids).not.toContain('claude-sonnet');
  });

  it('shows only 1 model for single-model token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer tok-single-model' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('gpt-4o');
  });

  // ─── Model access control in /v1/chat/completions ──────────────────

  it('allows chat completion for allowed model', async () => {
    mockFetch.mockResolvedValueOnce(mockOpenAIResponse('OK'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-limited',
      },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 403 for model not in allowedModels', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-limited',
      },
      payload: {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('forbidden_error');
    expect(body.error.message).toContain('claude-sonnet');
  });

  it('returns 403 for single-model token accessing different model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-single-model',
      },
      payload: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('allows full-access token to use any model', async () => {
    mockFetch.mockResolvedValueOnce(mockOpenAIResponse('OK'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-full-access',
      },
      payload: {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
  });

  // ─── Model access control in /v1/messages ─────────────────────────

  it('returns 403 in /v1/messages for forbidden model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-limited',
      },
      payload: {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  // ─── Per-token concurrency ─────────────────────────────────────────

  it('health endpoint shows token concurrency stats', async () => {
    // Need a token that has been used at least once to create the queue.
    mockFetch.mockResolvedValueOnce(mockOpenAIResponse('OK'));

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok-limited',
      },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer tok-full-access' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.concurrency.tokens).toBeDefined();
    expect(body.concurrency.tokens['restricted-client']).toBeDefined();
  });
});
