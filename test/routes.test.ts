import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We mock global fetch to simulate upstream providers.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('API routes', () => {
  let app: FastifyInstance;
  let configPath: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-test-'));
    configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      port: 0, // Will use ephemeral port
      globalMaxConcurrent: 5,
      providers: [
        {
          id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test', format: 'openai',
        },
        {
          id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-anthropic', format: 'anthropic', apiVersion: '2023-06-01',
        },
      ],
      models: [
        { alias: 'gpt-4o', providerId: 'openai', upstreamModel: 'gpt-4o' },
        { alias: 'claude-sonnet', providerId: 'anthropic', upstreamModel: 'claude-3-5-sonnet-20241022' },
      ],
    }));

    app = (await createServer(configPath)).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    mockFetch.mockReset();
  });

  // ─── GET /v1/models ──────────────────────────────────────────────────

  it('GET /v1/models returns all model aliases', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('claude-sonnet');
  });

  // ─── POST /v1/chat/completions (OpenAI → OpenAI) ────────────────────

  it('POST /v1/chat/completions forwards to OpenAI provider', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        id: 'chatcmpl-001',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe('Hello!');
    expect(body.model).toBe('gpt-4o');

    // Verify fetch was called with correct URL and model.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.model).toBe('gpt-4o'); // upstreamModel
  });

  // ─── POST /v1/chat/completions (OpenAI → Anthropic conversion) ──────

  it('POST /v1/chat/completions converts to Anthropic format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        id: 'msg_001',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi from Claude!' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'claude-sonnet',
        messages: [
          { role: 'system', content: 'Be nice' },
          { role: 'user', content: 'Hello' },
        ],
        max_tokens: 500,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hi from Claude!');
    expect(body.usage.total_tokens).toBe(15);

    // Verify the upstream received Anthropic format.
    const call = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const [, opts] = call;
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.system).toBe('Be nice');
    expect(sentBody.messages[0].content).toBe('Hello');
    expect(opts.headers['x-api-key']).toBe('sk-anthropic');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
  });

  // ─── POST /v1/messages (Anthropic → Anthropic) ──────────────────────

  it('POST /v1/messages forwards to Anthropic provider', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        id: 'msg_002',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Claude!' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'claude-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1024,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content[0].text).toBe('Hello from Claude!');
    expect(body.stop_reason).toBe('end_turn');
  });

  // ─── POST /v1/messages (Anthropic → OpenAI conversion) ─────────────

  it('POST /v1/messages converts to OpenAI format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        id: 'chatcmpl-002',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello from GPT!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1024,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('message');
    expect(body.content[0].text).toBe('Hello from GPT!');
    expect(body.usage.input_tokens).toBe(10);
    expect(body.usage.output_tokens).toBe(5);
  });

  // ─── Error cases ────────────────────────────────────────────────────

  it('returns 404 for unknown model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('not_found_error');
  });

  it('returns 400 for missing model field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: {
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /health returns concurrency stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.concurrency).toBeDefined();
    expect(body.concurrency.globalActive).toBe(0);
  });

  // ─── Auth ───────────────────────────────────────────────────────────

  it('returns 401 when authKey is configured and no token is provided', async () => {
    // Create a separate app with authKey enabled.
    const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
    const authConfigPath = join(dir, 'config.json');
    writeFileSync(authConfigPath, JSON.stringify({
      port: 0,
      authKey: 'secret-key',
      globalMaxConcurrent: 5,
      providers: [
        { id: 'p1', name: 'P1', baseUrl: 'https://api.test.com', apiKey: 'k', format: 'openai' },
      ],
      models: [
        { alias: 'm1', providerId: 'p1', upstreamModel: 'model-1' },
      ],
    }));

    const authApp = (await createServer(authConfigPath)).app;
    await authApp.ready();

    const res = await authApp.inject({
      method: 'GET',
      url: '/v1/models',
    });

    expect(res.statusCode).toBe(401);

    // With correct auth key.
    const res2 = await authApp.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer secret-key' },
    });

    expect(res2.statusCode).toBe(200);
    await authApp.close();
  });
});
