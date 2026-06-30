import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config/loader.js';
import { RouterWithProviders } from './router/index.js';
import { ConcurrencyManager, type SimpleLogger } from './queue/concurrency.js';
import { TokenManager } from './auth/token-manager.js';
import { buildRoutes, type RouteContext } from './routes/index.js';

export async function createServer(configPath: string): Promise<FastifyInstance> {
  const config = loadConfig(configPath);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, { origin: true });

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

  return app;
}

export async function start(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? './config.json';
  const app = await createServer(configPath);
  const log = app.log as unknown as SimpleLogger;

  try {
    const configData = loadConfig(configPath);
    await app.listen({ port: configData.port, host: '0.0.0.0' });
    log?.info({ port: configData.port }, 'LLM Proxy started');
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
