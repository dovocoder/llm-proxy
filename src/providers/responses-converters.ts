// ─── OpenAI Responses API Types ─────────────────────────────────────────────

/**
 * Input item for the Responses API.
 * Can be a simple message or a complex content block.
 */
export interface ResponsesInputItem {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | Array<{
    type: 'input_text' | 'output_text' | 'input_image' | 'input_file';
    text?: string;
    image_url?: string;
  }>;
}

/**
 * Request body for POST /v1/responses (OpenAI Responses API).
 */
export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: Record<string, string>;
  user?: string;
}

/**
 * Output item in the response.
 */
export interface ResponsesOutputItem {
  type: 'message';
  id: string;
  role: 'assistant';
  status: 'completed';
  content: Array<{
    type: 'output_text';
    text: string;
  }>;
}

/**
 * Response body for POST /v1/responses (OpenAI Responses API).
 */
export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled';
  output: ResponsesOutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// ─── Responses ↔ ChatCompletions Conversions ───────────────────────────────

import type { OpenAIChatRequest, OpenAIChatResponse, AnthropicRequest, AnthropicResponse } from './converters.js';
import type { OpenAIMessage } from '../types/index.js';

/**
 * Convert a Responses API request to a Chat Completions request.
 * Used for fallback when the provider doesn't support /v1/responses.
 */
export function responsesToChatCompletions(req: ResponsesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  // Instructions become the system message.
  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  // Convert input to messages.
  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      let content = '';
      if (typeof item.content === 'string') {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        // Flatten content blocks to text.
        content = item.content
          .filter((block) => block.type === 'input_text' || block.type === 'output_text')
          .map((block) => block.text ?? '')
          .join('\n');
      }
      messages.push({ role: item.role as OpenAIMessage['role'], content });
    }
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_output_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: false,
  };
}

/**
 * Convert a Chat Completions response to a Responses API response.
 * Used for fallback when the provider doesn't support /v1/responses.
 */
export function chatCompletionsToResponses(res: OpenAIChatResponse, model: string): ResponsesResponse {
  const choice = res.choices?.[0];
  const text = choice?.message?.content ?? '';

  return {
    id: res.id,
    object: 'response',
    created_at: res.created,
    model,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: `msg_${res.id}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      total_tokens: res.usage?.total_tokens ?? 0,
    },
  };
}

// ─── Responses ↔ Anthropic Messages Conversions ────────────────────────────

/**
 * Convert a Responses API request to an Anthropic Messages request.
 * Used for fallback when the provider uses Anthropic format and doesn't support /v1/responses.
 */
export function responsesToAnthropic(req: ResponsesRequest): AnthropicRequest {
  const messages: AnthropicRequest['messages'] = [];

  // Convert input items to Anthropic messages.
  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      let content = '';
      if (typeof item.content === 'string') {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        content = item.content
          .filter((block) => block.type === 'input_text' || block.type === 'output_text')
          .map((block) => block.text ?? '')
          .join('\n');
      }
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      // Merge consecutive same-role messages (Anthropic requires strict alternation).
      const last = messages[messages.length - 1];
      if (last && last.role === role && typeof last.content === 'string') {
        last.content = last.content + '\n' + content;
      } else {
        messages.push({ role, content });
      }
    }
  }

  return {
    model: req.model,
    messages,
    system: req.instructions,
    max_tokens: req.max_output_tokens ?? 4096,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: false,
  };
}

/**
 * Convert an Anthropic Messages response to a Responses API response.
 * Used for fallback when the provider uses Anthropic format and doesn't support /v1/responses.
 */
export function anthropicToResponses(res: AnthropicResponse, model: string): ResponsesResponse {
  const textParts: string[] = [];
  for (const block of res.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }

  return {
    id: res.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: `msg_${res.id}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: textParts.join('\n') }],
      },
    ],
    usage: {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    },
  };
}
