import { describe, it, expect } from 'vitest';
import { openAIToAnthropic, anthropicToOpenAI } from '../src/providers/converters.js';
import type { OpenAIChatRequest, AnthropicResponse } from '../src/providers/converters.js';

describe('openAIToAnthropic', () => {
  it('converts a basic OpenAI request to Anthropic format', () => {
    const openaiReq: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    };

    const result = openAIToAnthropic(openaiReq);
    expect(result.model).toBe('gpt-4o');
    expect(result.max_tokens).toBe(1000);
    expect(result.temperature).toBe(0.7);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('Hello');
    expect(result.system).toBeUndefined();
  });

  it('extracts system message to top-level system field', () => {
    const openaiReq: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 500,
    };

    const result = openAIToAnthropic(openaiReq);
    expect(result.system).toBe('You are helpful');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('merges multiple system messages', () => {
    const openaiReq: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 500,
    };

    const result = openAIToAnthropic(openaiReq);
    expect(result.system).toBe('Rule 1\nRule 2');
  });

  it('merges consecutive same-role messages', () => {
    const openaiReq: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'World' },
      ],
      max_tokens: 500,
    };

    const result = openAIToAnthropic(openaiReq);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('Hello\nWorld');
  });

  it('alternates roles correctly', () => {
    const openaiReq: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
      ],
      max_tokens: 500,
    };

    const result = openAIToAnthropic(openaiReq);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('applies default max_tokens when not specified', () => {
    const openaiReq: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    };

    const result = openAIToAnthropic(openaiReq);
    expect(result.max_tokens).toBe(4096);
  });
});

describe('anthropicToOpenAI', () => {
  it('converts a basic Anthropic response to OpenAI format', () => {
    const anthropicRes: AnthropicResponse = {
      id: 'msg_001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello there!' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = anthropicToOpenAI(anthropicRes, 'claude-sonnet');
    expect(result.id).toBe('msg_001');
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('claude-sonnet');
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe('Hello there!');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(15);
  });

  it('maps stop_reason correctly', () => {
    const anthropicRes: AnthropicResponse = {
      id: 'msg_002',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '...' }],
      model: 'claude',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 5, output_tokens: 100 },
    };

    const result = anthropicToOpenAI(anthropicRes, 'claude');
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('joins multiple text content blocks', () => {
    const anthropicRes: AnthropicResponse = {
      id: 'msg_003',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
      model: 'claude',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    };

    const result = anthropicToOpenAI(anthropicRes, 'claude');
    expect(result.choices[0].message.content).toBe('Part 1\nPart 2');
  });
});
