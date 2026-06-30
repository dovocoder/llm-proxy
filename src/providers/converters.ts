import type { OpenAIMessage } from '../types/index.js';

// ─── OpenAI Types ───────────────────────────────────────────────────────────

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  user?: string;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ─── Anthropic Types ────────────────────────────────────────────────────────

export interface AnthropicRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
          | { type: 'tool_result'; tool_use_id: string; content: string }
        >;
  }>;
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

// ─── Conversions ────────────────────────────────────────────────────────────

/**
 * Convert an OpenAI chat request into an Anthropic messages request.
 */
export function openAIToAnthropic(req: OpenAIChatRequest): AnthropicRequest {
  let system: string | undefined;
  const messages: AnthropicRequest['messages'] = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      // Merge multiple system messages into one.
      system = system ? `${system}\n${msg.content ?? ''}` : (msg.content ?? undefined);
      continue;
    }

    // Map OpenAI roles to Anthropic roles.
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = msg.content ?? '';

    // Merge consecutive same-role messages (Anthropic requires strict alternation).
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = last.content + '\n' + content;
    } else {
      messages.push({ role, content });
    }
  }

  return {
    model: req.model,
    messages,
    system,
    max_tokens: req.max_tokens ?? 4096,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: false,
  };
}

/**
 * Convert an Anthropic messages response into an OpenAI chat completion response.
 */
export function anthropicToOpenAI(res: AnthropicResponse, model: string): OpenAIChatResponse {
  const textParts: string[] = [];
  for (const block of res.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

  const finishReasonMap: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
  };

  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: textParts.join('\n') },
        finish_reason: finishReasonMap[res.stop_reason] ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    },
  };
}
