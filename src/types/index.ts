/**
 * Shared type definitions for the LLM proxy.
 */

/** API format the upstream provider expects. */
export type ProviderFormat = 'openai' | 'anthropic';

/** A configured upstream API endpoint. */
export interface ProviderConfig {
  /** Unique identifier for this provider (used in model routes). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Base URL of the upstream API (no trailing slash). */
  baseUrl: string;
  /** API key for the upstream. */
  apiKey: string;
  /** Whether this provider uses the Anthropic Messages API format. */
  format: ProviderFormat;
  /** Optional API version header (e.g. "2023-06-01" for Anthropic). */
  apiVersion?: string;
  /** Default request timeout in ms. */
  timeout?: number;
  /** Static headers sent with every request to this provider. */
  headers?: Record<string, string>;
}

/** A model alias — the name clients send, mapped to an upstream model. */
export interface ModelRouteConfig {
  /** The alias name exposed to clients via /v1/models. */
  alias: string;
  /** Provider ID to route to. */
  providerId: string;
  /** Actual model name at the upstream provider. */
  upstreamModel: string;
  /** Max concurrent requests for this specific model (overrides provider-level limit). */
  maxConcurrent?: number;
  /** Extra headers to send when routing to this model. */
  headers?: Record<string, string>;
}

/** Top-level proxy configuration. */
export interface ProxyConfig {
  /** Server listen port. */
  port: number;
  /** Optional API key clients must present via `Authorization: Bearer <key>`. */
  authKey?: string;
  /** Global concurrency limit (total in-flight requests across all models). */
  globalMaxConcurrent: number;
  /** List of upstream providers. */
  providers: ProviderConfig[];
  /** List of model alias routes. */
  models: ModelRouteConfig[];
}

/** OpenAI message format. */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** Anthropic message format. */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >;
}

/** Resolved route — everything needed to forward a request. */
export interface ResolvedRoute {
  provider: ProviderConfig;
  modelRoute: ModelRouteConfig;
}
