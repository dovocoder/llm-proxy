import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RouterWithProviders } from '../router/index.js';
import { ConcurrencyManager, QueueFullError, type SimpleLogger } from '../queue/concurrency.js';
import { ProviderAdapter } from '../providers/adapter.js';
import { TokenManager } from '../auth/token-manager.js';
import type { ApiTokenConfig, ProxyConfig } from '../types/index.js';
import type { AnthropicRequest, OpenAIChatRequest } from '../providers/converters.js';
import type { ResponsesRequest } from '../providers/responses-converters.js';

export interface RouteContext {
  config: ProxyConfig;
  router: RouterWithProviders;
  concurrency: ConcurrencyManager;
  tokenManager: TokenManager;
}

/** Extract bearer token from Authorization header (case-insensitive scheme). */
function extractBearerToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (!auth) return undefined;
  // RFC 7235: auth scheme is case-insensitive.
  const lower = auth.toLowerCase();
  if (lower.startsWith('bearer ')) {
    return auth.slice(7); // Slice from original to preserve token case.
  }
  return undefined;
}

/** Authentication hook — validates tokens via TokenManager. */
function authHook(ctx: RouteContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!ctx.tokenManager.authEnabled) return;

    const rawToken = extractBearerToken(request);
    if (!rawToken) {
      await reply.status(401).send({
        error: { message: 'Missing Authorization header', type: 'authentication_error' },
      });
      return;
    }

    const tokenConfig = ctx.tokenManager.authenticate(rawToken);
    if (!tokenConfig) {
      await reply.status(401).send({
        error: { message: 'Invalid API key', type: 'authentication_error' },
      });
      return;
    }
  };
}

/** Resolve and validate a model request, including token access control. Returns null + sends error reply on failure. */
async function resolveModel(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  modelAlias: string,
): Promise<{ resolved: ReturnType<RouterWithProviders['resolve']> } | null> {
  // Check model exists.
  try {
    const resolved = ctx.router.resolve(modelAlias);
    // Check token has access to this model.
    const rawToken = extractBearerToken(request);
    if (rawToken && ctx.tokenManager.authEnabled) {
      const tokenConfig = ctx.tokenManager.authenticate(rawToken);
      if (tokenConfig && !ctx.tokenManager.canAccessModel(tokenConfig, modelAlias)) {
        await reply.status(403).send({
          error: {
            message: `Access denied for model "${modelAlias}"`,
            type: 'forbidden_error',
          },
        });
        return null;
      }
    }
    return { resolved };
  } catch (err) {
    await reply.status(404).send({
      error: {
        message: err instanceof Error ? err.message : 'Model not found',
        type: 'not_found_error',
      },
    });
    return null;
  }
}

/** Get the token config for the current request (if auth is enabled). */
function getRequestToken(ctx: RouteContext, request: FastifyRequest): ApiTokenConfig | null {
  if (!ctx.tokenManager.authEnabled) return null;
  const rawToken = extractBearerToken(request);
  if (!rawToken) return null;
  return ctx.tokenManager.authenticate(rawToken);
}

/** Maximum length for a model alias name (prevents abuse). */
const MAX_MODEL_NAME_LENGTH = 200;

/** Maximum number of messages in a single request (prevents abuse). */
const MAX_MESSAGES_COUNT = 1000;

/** Validate model name to prevent injection. */
function validateModelName(model: unknown): string | null {
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_NAME_LENGTH) {
    return null;
  }
  // Allow only alphanumeric, hyphens, underscores, dots, and colons.
  if (!/^[a-zA-Z0-9._\-:]+$/.test(model)) {
    return null;
  }
  return model;
}

/** Validate messages array bounds. */
function validateMessages(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES_COUNT) {
    return false;
  }
  return true;
}

/** Sanitize upstream error responses — only forward safe fields. */
function sanitizeUpstreamError(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: Record<string, unknown> }).error;
    return {
      error: {
        message: typeof err.message === 'string' ? err.message : 'Upstream error',
        type: typeof err.type === 'string' ? err.type : 'upstream_error',
      },
    };
  }
  // If the error body doesn't have an error field, wrap it.
  return {
    error: {
      message: 'Upstream provider error',
      type: 'upstream_error',
    },
  };
}

/** Build all API routes. */
export function buildRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.addHook('onRequest', authHook(ctx));

  // ─── GET /v1/models ──────────────────────────────────────────────────

  app.get('/v1/models', async (request: FastifyRequest, reply: FastifyReply) => {
    const allModels = ctx.router.listModels();
    const tokenConfig = getRequestToken(ctx, request);

    // Filter models by token access.
    const visibleModels = tokenConfig
      ? ctx.tokenManager.accessibleModels(tokenConfig, allModels)
      : allModels;

    const data = visibleModels.map((id) => ({
      id,
      object: 'model' as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'llm-proxy',
    }));

    return reply.send({ object: 'list', data });
  });

  // ─── POST /v1/chat/completions (OpenAI format) ───────────────────────

  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as OpenAIChatRequest;

    const model = validateModelName(body?.model);
    if (!model || !validateMessages(body?.messages)) {
      return reply.status(400).send({
        error: { message: 'Missing or invalid required fields: model, messages', type: 'invalid_request_error' },
      });
    }

    const result = await resolveModel(ctx, request, reply, model);
    if (!result) return;

    const { provider, modelRoute } = result.resolved;
    const log = request.log as unknown as SimpleLogger;
    const adapter = new ProviderAdapter(provider, log);
    const tokenConfig = getRequestToken(ctx, request);

    // Replace model alias with upstream model name.
    const upstreamBody: OpenAIChatRequest = { ...body, model: modelRoute.upstreamModel };

    // Acquire concurrency slots: global + model + token (waits if full, never rejects).
    const release = await ctx.concurrency.acquire(
      modelRoute.alias,
      modelRoute.maxConcurrent,
      tokenConfig?.name,
      tokenConfig?.maxConcurrent,
    );

    try {
      const result = await adapter.forwardOpenAI(upstreamBody, modelRoute.headers);
      const body = result.status >= 400 ? sanitizeUpstreamError(result.body) : result.body;
      return reply.status(result.status).send(body);
    } catch (err) {
      if (err instanceof QueueFullError) {
        return reply.status(503).send({
          error: { message: 'Server at capacity, please retry later', type: 'server_busy' },
        });
      }
      log?.error({ err: err as Error }, 'Upstream forwarding failed');
      return reply.status(502).send({
        error: { message: 'Upstream provider error', type: 'upstream_error' },
      });
    } finally {
      release();
    }
  });

  // ─── POST /v1/messages (Anthropic format) ────────────────────────────

  app.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as AnthropicRequest;

    const model = validateModelName(body?.model);
    if (!model || !validateMessages(body?.messages)) {
      return reply.status(400).send({
        error: { message: 'Missing or invalid required fields: model, messages', type: 'invalid_request_error' },
      });
    }

    const result = await resolveModel(ctx, request, reply, model);
    if (!result) return;

    const { provider, modelRoute } = result.resolved;
    const log = request.log as unknown as SimpleLogger;
    const adapter = new ProviderAdapter(provider, log);
    const tokenConfig = getRequestToken(ctx, request);

    // Replace model alias with upstream model name.
    const upstreamBody: AnthropicRequest = { ...body, model: modelRoute.upstreamModel };

    const release = await ctx.concurrency.acquire(
      modelRoute.alias,
      modelRoute.maxConcurrent,
      tokenConfig?.name,
      tokenConfig?.maxConcurrent,
    );

    try {
      const result = await adapter.forwardAnthropic(upstreamBody, modelRoute.headers);
      const body = result.status >= 400 ? sanitizeUpstreamError(result.body) : result.body;
      return reply.status(result.status).send(body);
    } catch (err) {
      if (err instanceof QueueFullError) {
        return reply.status(503).send({
          error: { message: 'Server at capacity, please retry later', type: 'server_busy' },
        });
      }
      log?.error({ err: err as Error }, 'Upstream forwarding failed');
      return reply.status(502).send({
        error: { message: 'Upstream provider error', type: 'upstream_error' },
      });
    } finally {
      release();
    }
  });

  // ─── POST /v1/responses (OpenAI Responses API) ──────────────────────

  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ResponsesRequest;

    const model = validateModelName(body?.model);
    if (!model || body?.input === undefined) {
      return reply.status(400).send({
        error: { message: 'Missing or invalid required fields: model, input', type: 'invalid_request_error' },
      });
    }

    const result = await resolveModel(ctx, request, reply, model);
    if (!result) return;

    const { provider, modelRoute } = result.resolved;
    const log = request.log as unknown as SimpleLogger;
    const adapter = new ProviderAdapter(provider, log);
    const tokenConfig = getRequestToken(ctx, request);

    // Replace model alias with upstream model name.
    const upstreamBody: ResponsesRequest = { ...body, model: modelRoute.upstreamModel };

    const release = await ctx.concurrency.acquire(
      modelRoute.alias,
      modelRoute.maxConcurrent,
      tokenConfig?.name,
      tokenConfig?.maxConcurrent,
    );

    try {
      const result = await adapter.forwardResponses(upstreamBody, modelRoute.headers);
      const body = result.status >= 400 ? sanitizeUpstreamError(result.body) : result.body;
      return reply.status(result.status).send(body);
    } catch (err) {
      if (err instanceof QueueFullError) {
        return reply.status(503).send({
          error: { message: 'Server at capacity, please retry later', type: 'server_busy' },
        });
      }
      log?.error({ err: err as Error }, 'Upstream forwarding failed');
      return reply.status(502).send({
        error: { message: 'Upstream provider error', type: 'upstream_error' },
      });
    } finally {
      release();
    }
  });

  // ─── GET /health ─────────────────────────────────────────────────────

  app.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const stats = ctx.concurrency.stats();
    const tokenConfig = getRequestToken(ctx, request);

    // Non-admin tokens only see aggregate counts, not model/token names.
    const isAdmin = !tokenConfig || (
      (!tokenConfig.allowedModels || tokenConfig.allowedModels.length === 0)
    );

    if (isAdmin) {
      return reply.send({ status: 'ok', concurrency: stats });
    }

    // Restricted tokens only see aggregate counts.
    return reply.send({
      status: 'ok',
      concurrency: {
        globalActive: stats.globalActive,
        globalQueued: stats.globalQueued,
      },
    });
  });
}
