import type { ProviderConfig, ProviderFormat } from '../types/index.js';
import type { SimpleLogger } from '../queue/concurrency.js';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  type AnthropicRequest,
  type AnthropicResponse,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
} from './converters.js';
import {
  responsesToChatCompletions,
  chatCompletionsToResponses,
  responsesToAnthropic,
  anthropicToResponses,
  type ResponsesRequest,
} from './responses-converters.js';

export interface ForwardResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Provider adapter — handles forwarding requests to upstream providers.
 * When the client format differs from the provider format, converts the request
 * and response automatically.
 */
export class ProviderAdapter {
  constructor(
    private readonly provider: ProviderConfig,
    private readonly logger?: SimpleLogger,
  ) {}

  get format(): ProviderFormat {
    return this.provider.format;
  }

  /**
   * Forward an OpenAI-format chat completion request.
   * If the provider uses Anthropic format, converts request + response.
   */
  async forwardOpenAI(body: OpenAIChatRequest, extraHeaders?: Record<string, string>): Promise<ForwardResult> {
    if (this.provider.format === 'openai') {
      return this.forwardNative('/chat/completions', body, extraHeaders);
    }

    // Convert OpenAI → Anthropic, send, then convert response back.
    const anthropicReq = openAIToAnthropic(body);
    const result = await this.forwardNative('/messages', anthropicReq, extraHeaders);
    if (result.status >= 400) {
      return result; // Pass errors through as-is.
    }
    const anthropicRes = result.body as AnthropicResponse;
    const openAIRes = anthropicToOpenAI(anthropicRes, body.model);
    return { status: result.status, body: openAIRes, headers: result.headers };
  }

  /**
   * Forward an Anthropic-format messages request.
   * If the provider uses OpenAI format, converts request + response.
   */
  async forwardAnthropic(body: AnthropicRequest, extraHeaders?: Record<string, string>): Promise<ForwardResult> {
    if (this.provider.format === 'anthropic') {
      return this.forwardNative('/messages', body, extraHeaders);
    }

    // Convert Anthropic → OpenAI, send, then convert response back.
    const openAIReq = anthropicToOpenAIRequest(body);
    const result = await this.forwardNative('/chat/completions', openAIReq, extraHeaders);
    if (result.status >= 400) {
      return result;
    }
    const openAIRes = result.body as OpenAIChatResponse;
    const anthropicRes = openAIToAnthropicResponse(openAIRes);
    return { status: result.status, body: anthropicRes, headers: result.headers };
  }

  /**
   * Forward a Responses API request.
   *
   * If the provider supports Responses natively (supportsResponses flag),
   * forward as-is. Otherwise, fall back to chat/completions (OpenAI) or
   * messages (Anthropic) and convert the response back to Responses format.
   */
  async forwardResponses(body: ResponsesRequest, extraHeaders?: Record<string, string>): Promise<ForwardResult> {
    // If provider supports Responses API natively, forward directly.
    if (this.provider.supportsResponses === true) {
      return this.forwardNative('/responses', body, extraHeaders);
    }

    // Fallback: convert to the provider's native format.
    if (this.provider.format === 'openai') {
      const chatReq = responsesToChatCompletions(body);
      const result = await this.forwardNative('/chat/completions', chatReq, extraHeaders);
      if (result.status >= 400) return result;
      const chatRes = result.body as OpenAIChatResponse;
      const responsesRes = chatCompletionsToResponses(chatRes, body.model);
      return { status: result.status, body: responsesRes, headers: result.headers };
    }

    // Anthropic fallback: convert Responses → Anthropic Messages, then convert response back.
    const anthropicReq = responsesToAnthropic(body);
    const result = await this.forwardNative('/messages', anthropicReq, extraHeaders);
    if (result.status >= 400) return result;
    const anthropicRes = result.body as AnthropicResponse;
    const responsesRes = anthropicToResponses(anthropicRes, body.model);
    return { status: result.status, body: responsesRes, headers: result.headers };
  }

  /**
   * Forward a request natively (no conversion) to the upstream provider.
   */
  private async forwardNative(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ForwardResult> {
    const url = `${this.provider.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.provider.apiKey}`,
      ...this.provider.headers,
      ...extraHeaders,
    };

    // Anthropic uses x-api-key instead of Bearer auth.
    if (this.provider.format === 'anthropic') {
      headers['x-api-key'] = this.provider.apiKey;
      headers['anthropic-version'] = this.provider.apiVersion ?? '2023-06-01';
      delete headers.Authorization;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.provider.timeout ?? 30000);

    try {
      this.logger?.debug({ url, format: this.provider.format }, 'Forwarding request to upstream');

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Only forward a safe subset of response headers to the client.
      // Prevents leaking upstream infrastructure details (server info, internal IDs, etc.)
      const responseHeaders: Record<string, string> = {};
      const safeResponseHeaders = new Set([
        'content-type',
        'x-request-id',
        'openai-organization',
        'openai-processing-ms',
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-tokens-limit',
        'anthropic-ratelimit-tokens-remaining',
        'x-ratelimit-limit-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset-tokens',
      ]);
      res.headers.forEach((value, key) => {
        if (safeResponseHeaders.has(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      // Safely parse upstream response — handle non-JSON responses gracefully.
      let resBody: unknown;
      try {
        resBody = await res.json();
      } catch {
        // Upstream returned non-JSON (HTML error page, plain text, etc.)
        resBody = {
          error: {
            message: 'Upstream returned non-JSON response',
            type: 'upstream_error',
            status: res.status,
          },
        };
      }

      return {
        status: res.status,
        body: resBody,
        headers: responseHeaders,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        status: 504,
        body: {
          error: {
            message: isAbort ? 'Upstream request timed out' : 'Failed to reach upstream provider',
            type: isAbort ? 'timeout_error' : 'connection_error',
          },
        },
        headers: {},
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Conversion helpers (Anthropic → OpenAI request) ───────────────────────────

function anthropicToOpenAIRequest(req: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIChatRequest['messages'] = [];

  // Anthropic system prompt is top-level, not a message.
  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Flatten content blocks into text.
      const textParts: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          textParts.push(`[tool_use: ${block.name}]`);
        } else if (block.type === 'tool_result') {
          textParts.push(`[tool_result: ${block.content}]`);
        }
      }
      messages.push({ role: msg.role, content: textParts.join('\n') });
    }
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stream: false,
  };
}

function openAIToAnthropicResponse(res: OpenAIChatResponse): AnthropicResponse {
  const choice = res.choices?.[0];
  const text = choice?.message?.content ?? '';
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: res.model,
    stop_reason: choice?.finish_reason === 'length' ? 'max_tokens' : (choice?.finish_reason ?? 'end_turn'),
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

export { openAIToAnthropic, anthropicToOpenAI };
export type { AnthropicRequest, AnthropicResponse, OpenAIChatRequest, OpenAIChatResponse };
export type { ResponsesRequest, ResponsesResponse } from './responses-converters.js';
