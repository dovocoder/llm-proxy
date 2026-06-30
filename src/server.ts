import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config/loader.js';
import { RouterWithProviders } from './router/index.js';
import { ConcurrencyManager, type SimpleLogger } from './queue/concurrency.js';
import { TokenManager } from './auth/token-manager.js';
import { buildRoutes, type RouteContext } from './routes/index.js';

export async function createServer(configPath: string): Promise<{ app: FastifyInstance; port: number }> {
  const config = loadConfig(configPath);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    // Limit request body to 10MB to prevent DoS via oversized payloads.
    bodyLimit: 10 * 1024 * 1024,
  });

  // CORS: only allow configured origins, or disable if none set.
  const corsOrigins = process.env.CORS_ORIGINS;
  const corsOpts = corsOrigins
    ? { origin: corsOrigins.split(',').map((s) => s.trim()) }
    : { origin: false }; // No CORS — API server, not browser-facing.
  await app.register(cors, corsOpts);

  const ctx: RouteContext = {
    config,
    router: new RouterWithProviders(config),
    concurrency: new ConcurrencyManager(
      config.globalMaxConcurrent,
      app.log as unknown as SimpleLogger,
    ),
    tokenManager: new TokenManager(config),
  };

  buildRoutes(app, ctx);

  return { app, port: config.port };
}

export async function start(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? './config.json';
  const { app, port } = await createServer(configPath);
  const log = app.log as unknown as SimpleLogger;

  try {
    await app.listen({ port, host: '0.0.0.0' });
    log?.info({ port }, 'LLM Proxy started');
  } catch (err) {
    log?.error({ err: err as Error }, 'Failed to start server');
    process.exit(1);
  }
}

// Auto-start only when run directly (not when imported by tests).
const isMainModule = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMainModule) {
  void start();
}
