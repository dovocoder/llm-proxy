import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockOpenAIChatResponse(text: string): unknown {
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

function mockAnthropicResponse(text: string): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  };
}

function mockNativeResponsesResponse(text: string): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      id: 'resp_mock',
      object: 'response',
      created_at: 1234567890,
      model: 'gpt-4o',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_mock',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    }),
  };
}

describe('Responses API', () => {
  describe('Fallback to OpenAI chat/completions', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-resp-'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        port: 0,
        globalMaxConcurrent: 10,
        providers: [
          {
            id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test', format: 'openai', supportsResponses: false,
          },
        ],
        models: [
          { alias: 'gpt-4o', providerId: 'openai', upstreamModel: 'gpt-4o' },
        ],
      }));
      app = await createServer(configPath);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      mockFetch.mockReset();
    });

    it('converts Responses request to chat/completions when supportsResponses=false', async () => {
      mockFetch.mockResolvedValueOnce(mockOpenAIChatResponse('Hello from OpenAI!'));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'gpt-4o',
          input: 'Say hello',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('response');
      expect(body.status).toBe('completed');
      expect(body.output[0].content[0].text).toBe('Hello from OpenAI!');
      expect(body.usage.total_tokens).toBe(7);

      // Verify the fetch was called with /chat/completions, not /responses.
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('/chat/completions');
      expect(callUrl).not.toContain('/responses');
    });

    it('converts instructions to system message in fallback', async () => {
      mockFetch.mockResolvedValueOnce(mockOpenAIChatResponse('OK'));

      await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'gpt-4o',
          input: 'What is 2+2?',
          instructions: 'You are a math tutor.',
        },
      });

      const callBody = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
      expect(callBody.messages[0]).toEqual({ role: 'system', content: 'You are a math tutor.' });
      expect(callBody.messages[1]).toEqual({ role: 'user', content: 'What is 2+2?' });
    });

    it('handles array input with multiple messages', async () => {
      mockFetch.mockResolvedValueOnce(mockOpenAIChatResponse('OK'));

      await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'gpt-4o',
          input: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'How are you?' },
          ],
        },
      });

      const callBody = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
      expect(callBody.messages).toHaveLength(3);
      expect(callBody.messages[0].role).toBe('user');
      expect(callBody.messages[2].content).toBe('How are you?');
    });
  });

  describe('Fallback to Anthropic messages', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-resp-anthropic-'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        port: 0,
        globalMaxConcurrent: 10,
        providers: [
          {
            id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1',
            apiKey: 'sk-ant-test', format: 'anthropic', supportsResponses: false,
          },
        ],
        models: [
          { alias: 'claude-sonnet', providerId: 'anthropic', upstreamModel: 'claude-3-5-sonnet-20241022' },
        ],
      }));
      app = await createServer(configPath);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      mockFetch.mockReset();
    });

    it('converts Responses request to Anthropic messages when provider is anthropic', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('Hello from Claude!'));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'claude-sonnet',
          input: 'Say hello',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('response');
      expect(body.output[0].content[0].text).toBe('Hello from Claude!');
      expect(body.usage.input_tokens).toBe(5);
      expect(body.usage.output_tokens).toBe(2);
      expect(body.usage.total_tokens).toBe(7);

      // Verify fetch was called with /messages, not /responses.
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('/messages');
    });

    it('converts instructions to system field for Anthropic', async () => {
      mockFetch.mockResolvedValueOnce(mockAnthropicResponse('OK'));

      await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'claude-sonnet',
          input: 'What is 2+2?',
          instructions: 'You are a math tutor.',
        },
      });

      const callBody = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
      expect(callBody.system).toBe('You are a math tutor.');
    });
  });

  describe('Native Responses support', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-resp-native-'));
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        port: 0,
        globalMaxConcurrent: 10,
        providers: [
          {
            id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test', format: 'openai', supportsResponses: true,
          },
        ],
        models: [
          { alias: 'gpt-4o', providerId: 'openai', upstreamModel: 'gpt-4o' },
        ],
      }));
      app = await createServer(configPath);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      mockFetch.mockReset();
    });

    it('forwards directly to /responses when supportsResponses=true', async () => {
      mockFetch.mockResolvedValueOnce(mockNativeResponsesResponse('Native response!'));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'gpt-4o',
          input: 'Say hello',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('response');
      expect(body.output[0].content[0].text).toBe('Native response!');

      // Verify fetch was called with /responses.
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('/responses');
      expect(callUrl).not.toContain('/chat/completions');
    });
  });

  describe('Validation', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-resp-val-'));
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
        ],
      }));
      app = await createServer(configPath);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 400 when model is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: { input: 'Hello' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when input is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'gpt-4o' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid model name with special characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'gpt-4o; rm -rf /', input: 'Hello' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown model', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'nonexistent', input: 'Hello' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Error passthrough', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-resp-err-'));
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
        ],
      }));
      app = await createServer(configPath);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      mockFetch.mockReset();
    });

    it('passes through upstream error status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map(),
        json: async () => ({
          error: { message: 'Rate limited', type: 'rate_limit_error' },
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'gpt-4o', input: 'Hello' },
      });

      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.error.message).toBe('Rate limited');
    });
  });
});
