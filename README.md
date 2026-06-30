# LLM Proxy

A self-hosted LLM API proxy that unifies access to multiple upstream providers (OpenAI, Anthropic, and custom OpenAI-compatible endpoints) behind a single API surface.

## Features

- **Multi-provider routing** — Link to different upstream API providers (OpenAI, Anthropic, or any OpenAI-compatible endpoint)
- **Model aliasing** — Expose custom model names (e.g. `gpt-4o`, `claude-sonnet`) that map to upstream model names
- **Cross-format translation** — Automatically converts between OpenAI and Anthropic API formats:
  - Send OpenAI `POST /v1/chat/completions` requests to an Anthropic provider
  - Send Anthropic `POST /v1/messages` requests to an OpenAI provider
- **Custom headers** — Attach per-provider and per-model headers for custom model endpoints
- **Concurrency limits with queueing** — Set global, per-model, and per-token concurrency limits. When full, requests **wait in queue** rather than being rejected
- **API tokens** — Per-client tokens with optional concurrency limits and model access control. Clients only see and use models they're authorized for
- **API key authentication** — Optional proxy-level auth key (or per-client tokens)
- **Environment variable expansion** — Use `${VAR}` in config to inject secrets from environment

## Quick Start

```bash
# Install dependencies
npm install

# Copy example config and edit with your provider details
cp examples/config.example.json config.json

# Set required env vars
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# Start the proxy (dev mode with hot reload)
npm run dev

# Or build and run
npm run build
npm start
```

## Configuration

Create a `config.json` (path configurable via `CONFIG_PATH` env var):

```json
{
  "port": 3000,
  "authKey": "${PROXY_AUTH_KEY}",
  "globalMaxConcurrent": 20,
  "providers": [
    {
      "id": "openai-main",
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "format": "openai",
      "timeout": 60000
    },
    {
      "id": "anthropic-main",
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "format": "anthropic",
      "apiVersion": "2023-06-01"
    },
    {
      "id": "custom-llama",
      "name": "Custom Llama Server",
      "baseUrl": "https://llama.example.com/v1",
      "apiKey": "${LLAMA_API_KEY}",
      "format": "openai",
      "headers": {
        "X-Custom-Header": "my-value"
      }
    }
  ],
  "models": [
    {
      "alias": "gpt-4o",
      "providerId": "openai-main",
      "upstreamModel": "gpt-4o",
      "maxConcurrent": 5
    },
    {
      "alias": "claude-sonnet",
      "providerId": "anthropic-main",
      "upstreamModel": "claude-3-5-sonnet-20241022",
      "maxConcurrent": 3
    },
    {
      "alias": "llama-3.3-70b",
      "providerId": "custom-llama",
      "upstreamModel": "llama-3.3-70b-instruct",
      "headers": {
        "X-Model-Tier": "premium"
      }
    }
  ],
  "tokens": [
    {
      "token": "${ADMIN_TOKEN}",
      "name": "admin"
    },
    {
      "token": "${CHATBOT_TOKEN}",
      "name": "chatbot",
      "maxConcurrent": 3,
      "allowedModels": ["gpt-4o", "gpt-4o-mini"]
    },
    {
      "token": "${INTERNAL_CLI_TOKEN}",
      "name": "internal-cli",
      "maxConcurrent": 1,
      "allowedModels": ["gpt-4o"]
    }
  ]
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `port` | `number` | Server listen port (default: 3000) |
| `authKey` | `string?` | If set, clients must send `Authorization: Bearer <key>` |
| `globalMaxConcurrent` | `number` | Max in-flight requests across all models (default: 10) |
| `providers` | `Provider[]` | Upstream API providers |
| `models` | `ModelRoute[]` | Model alias → provider mappings |
| `tokens` | `Token[]?` | Per-client API tokens with optional concurrency limits and model access control |

#### Provider

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique provider identifier |
| `name` | `string` | Human-readable name |
| `baseUrl` | `string` | Upstream API base URL (include `/v1` if applicable) |
| `apiKey` | `string` | API key for the upstream |
| `format` | `"openai" \| "anthropic"` | API format the provider uses |
| `apiVersion` | `string?` | API version header (Anthropic only, default: `2023-06-01`) |
| `timeout` | `number?` | Request timeout in ms (default: 30000) |
| `headers` | `Record<string, string>?` | Static headers sent with every request to this provider |

#### Model Route

| Field | Type | Description |
|-------|------|-------------|
| `alias` | `string` | Model name exposed to clients |
| `providerId` | `string` | Which provider to route to |
| `upstreamModel` | `string` | Actual model name at the upstream provider |
| `maxConcurrent` | `number?` | Per-model concurrency limit (overrides provider-level) |
| `headers` | `Record<string, string>?` | Extra headers sent when routing to this model |

#### Token

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string` | The token string clients send via `Authorization: Bearer <token>` |
| `name` | `string` | Human-readable name for this token |
| `maxConcurrent` | `number?` | Per-token concurrency limit. Requests queue when full (never rejected) |
| `allowedModels` | `string[]?` | If set, this token can only access these model aliases. Unset/empty = all models |

## API Endpoints

### `GET /v1/models`

Returns all configured model aliases in OpenAI format. If the request is authenticated with a token that has `allowedModels` configured, only the allowed models are returned.

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4o", "object": "model", "created": 1234567890, "owned_by": "llm-proxy" },
    { "id": "claude-sonnet", "object": "model", "created": 1234567890, "owned_by": "llm-proxy" }
  ]
}
```

### `POST /v1/chat/completions`

OpenAI-format chat completion. Forwards to the provider mapped by the `model` field.

If the provider uses Anthropic format, the request and response are automatically converted.

### `POST /v1/messages`

Anthropic-format messages API. Forwards to the provider mapped by the `model` field.

If the provider uses OpenAI format, the request and response are automatically converted.

### `GET /health`

Returns server health and concurrency stats.

```json
{
  "status": "ok",
  "concurrency": {
    "globalActive": 3,
    "globalQueued": 1,
    "models": {
      "gpt-4o": { "active": 2, "queued": 0 },
      "claude-sonnet": { "active": 1, "queued": 1 }
    },
    "tokens": {
      "chatbot": { "active": 2, "queued": 0 },
      "internal-cli": { "active": 1, "queued": 1 }
    }
  }
}
```

## Cross-Format Conversion

The proxy automatically handles format translation when the client format differs from the provider format:

| Client sends | Provider format | What happens |
|---|---|---|
| `/v1/chat/completions` | `openai` | Forward as-is |
| `/v1/chat/completions` | `anthropic` | Convert request → Anthropic, convert response → OpenAI |
| `/v1/messages` | `anthropic` | Forward as-is |
| `/v1/messages` | `openai` | Convert request → OpenAI, convert response → Anthropic |

### Conversion details

- OpenAI `system` messages → Anthropic top-level `system` field
- Consecutive same-role messages are merged (Anthropic requires strict alternation)
- Stop reasons are mapped (`end_turn` → `stop`, `max_tokens` → `length`, etc.)
- Token usage is converted between formats

## Concurrency Model

The proxy implements a three-level concurrency limiter:

1. **Global limit** (`globalMaxConcurrent`): max total in-flight requests
2. **Per-model limit** (`maxConcurrent` on each model route): max concurrent requests per model
3. **Per-token limit** (`maxConcurrent` on each token): max concurrent requests per client token

When any limit is reached, new requests **wait in a FIFO queue** — they are never rejected (HTTP 429). As in-flight requests complete, queued requests are resumed in order.

Acquire order: token → model → global (prevents starvation under contention).

The `/health` endpoint shows current active and queued counts for all three levels.

## Development

```bash
# Install
npm install

# Run tests
npm test

# Watch tests
npm run test:watch

# Type check
npm run typecheck

# Lint
npm run lint

# Dev server with hot reload
npm run dev
```

## Tech Stack

- **TypeScript** with ESM modules
- **Fastify** web framework
- **Zod** for config validation
- **Vitest** for testing
- **ESLint** for linting

## License

MIT
