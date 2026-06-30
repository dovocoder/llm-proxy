import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RouterWithProviders } from '../router/index.js';
import { ConcurrencyManager, type SimpleLogger } from '../queue/concurrency.js';
import { ProviderAdapter } from '../providers/adapter.js';
import type { ProxyConfig } from '../types/index.js';
import type { AnthropicRequest, OpenAIChatRequest } from '../providers/converters.js';

export interface RouteContext {
  config: ProxyConfig;
  router: RouterWithProviders;
  concurrency: ConcurrencyManager;
}

/** Authentication hook — checks Authorization header if authKey is configured. */
function authHook(config: ProxyConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.authKey) return;

    const auth = request.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;

    if (token !== config.authKey) {
      await reply.status(401).send({
        error: {
          message: 'Invalid or missing API key',
          type: 'authentication_error',
        },
      });
    }
  };
}

/** Build all API routes. */
export function buildRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.addHook('onRequest', authHook(ctx.config));

  // ─── GET /v1/models ──────────────────────────────────────────────────

  app.get('/v1/models', async (_req: FastifyRequest, reply: FastifyReply) => {
    const models = ctx.router.listModels().map((id) => ({
      id,
      object: 'model' as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'llm-proxy',
    }));

    return reply.send({ object: 'list', data: models });
  });

  // ─── POST /v1/chat/completions (OpenAI format) ───────────────────────

  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as OpenAIChatRequest;

    if (!body?.model || !body?.messages) {
      return reply.status(400).send({
        error: { message: 'Missing required fields: model, messages', type: 'invalid_request_error' },
      });
    }

    let resolved;
    try {
      resolved = ctx.router.resolve(body.model);
    } catch (err) {
      return reply.status(404).send({
        error: {
          message: err instanceof Error ? err.message : 'Model not found',
          type: 'not_found_error',
        },
      });
    }

    const { provider, modelRoute } = resolved;
    const log = request.log as unknown as SimpleLogger;
    const adapter = new ProviderAdapter(provider, log);

    // Replace model alias with upstream model name.
    const upstreamBody: OpenAIChatRequest = { ...body, model: modelRoute.upstreamModel };

    // Acquire concurrency slots (waits if full, never rejects).
    const release = await ctx.concurrency.acquire(
      modelRoute.alias,
      modelRoute.maxConcurrent,
    );

    try {
      const result = await adapter.forwardOpenAI(upstreamBody, modelRoute.headers);
      return reply.status(result.status).send(result.body);
    } catch (err) {
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

    if (!body?.model || !body?.messages) {
      return reply.status(400).send({
        error: { message: 'Missing required fields: model, messages', type: 'invalid_request_error' },
      });
    }

    let resolved;
    try {
      resolved = ctx.router.resolve(body.model);
    } catch (err) {
      return reply.status(404).send({
        error: {
          message: err instanceof Error ? err.message : 'Model not found',
          type: 'not_found_error',
        },
      });
    }

    const { provider, modelRoute } = resolved;
    const log = request.log as unknown as SimpleLogger;
    const adapter = new ProviderAdapter(provider, log);

    // Replace model alias with upstream model name.
    const upstreamBody: AnthropicRequest = { ...body, model: modelRoute.upstreamModel };

    const release = await ctx.concurrency.acquire(
      modelRoute.alias,
      modelRoute.maxConcurrent,
    );

    try {
      const result = await adapter.forwardAnthropic(upstreamBody, modelRoute.headers);
      return reply.status(result.status).send(result.body);
    } catch (err) {
      log?.error({ err: err as Error }, 'Upstream forwarding failed');
      return reply.status(502).send({
        error: { message: 'Upstream provider error', type: 'upstream_error' },
      });
    } finally {
      release();
    }
  });

  // ─── GET /health ─────────────────────────────────────────────────────

  app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const stats = ctx.concurrency.stats();
    return reply.send({ status: 'ok', concurrency: stats });
  });
}
