/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal logger type — compatible with pino and fastify loggers.
 */
export type SimpleLogger = {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
} | undefined;

/**
 * Concurrency limiter with queueing — requests wait, never rejected.
 *
 * When the concurrency limit is reached, new requests are queued in FIFO order
 * and resumed as slots free up. This applies to both per-model and global limits.
 */
export class ConcurrencyQueue {
  private active = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly label: string,
    private readonly logger?: SimpleLogger,
  ) {}

  /** Current number of in-flight requests. */
  get activeCount(): number {
    return this.active;
  }

  /** Current number of queued requests. */
  get queuedCount(): number {
    return this.waitQueue.length;
  }

  /**
   * Acquire a slot. If the limit is reached, this waits until a slot frees.
   * Never rejects — always resolves eventually.
   */
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }

    // Queue this request — it will resolve when a slot frees.
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });

    // When resumed, we've been granted the slot by `release()`.
    this.active++;
  }

  /** Release a slot and wake the next queued request. */
  release(): void {
    if (this.active > 0) this.active--;

    const next = this.waitQueue.shift();
    if (next) {
      this.logger?.debug({ label: this.label, queued: this.waitQueue.length }, 'Resolving queued request');
      next();
    }
  }

  /**
   * Run a function with concurrency control.
   * Acquires a slot, runs fn, and always releases.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Manages per-model and global concurrency queues.
 * A request must pass through both global and model-level limits.
 */
export class ConcurrencyManager {
  private globalQueue: ConcurrencyQueue;
  private modelQueues = new Map<string, ConcurrencyQueue>();

  constructor(globalLimit: number, private readonly logger?: SimpleLogger) {
    this.globalQueue = new ConcurrencyQueue(globalLimit, 'global', logger);
  }

  /** Ensure a model queue exists with the given limit. */
  getOrCreateModelQueue(modelAlias: string, limit: number): ConcurrencyQueue {
    let queue = this.modelQueues.get(modelAlias);
    if (!queue) {
      queue = new ConcurrencyQueue(limit, `model:${modelAlias}`, this.logger);
      this.modelQueues.set(modelAlias, queue);
    }
    return queue;
  }

  /**
   * Acquire both global and model-level slots.
   * Order: global first (prevents model-queue starvation under contention).
   */
  async acquire(modelAlias: string, modelLimit?: number): Promise<() => void> {
    // If model-specific limit is set, acquire that too.
    let modelQueue: ConcurrencyQueue | undefined;
    if (modelLimit !== undefined) {
      modelQueue = this.getOrCreateModelQueue(modelAlias, modelLimit);
      await modelQueue.acquire();
    }
    await this.globalQueue.acquire();

    // Return a release function that frees both slots.
    return () => {
      this.globalQueue.release();
      modelQueue?.release();
    };
  }

  /** Stats for observability. */
  stats(): { globalActive: number; globalQueued: number; models: Record<string, { active: number; queued: number }> } {
    const models: Record<string, { active: number; queued: number }> = {};
    for (const [alias, queue] of Array.from(this.modelQueues.entries())) {
      models[alias] = { active: queue.activeCount, queued: queue.queuedCount };
    }
    return {
      globalActive: this.globalQueue.activeCount,
      globalQueued: this.globalQueue.queuedCount,
      models,
    };
  }
}
