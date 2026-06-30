import { describe, it, expect } from 'vitest';
import { ConcurrencyQueue, ConcurrencyManager } from '../src/queue/concurrency.js';

describe('ConcurrencyQueue', () => {
  it('runs tasks up to the limit', async () => {
    const queue = new ConcurrencyQueue(3, 'test');
    const results: number[] = [];

    const tasks = Array.from({ length: 3 }, (_, i) =>
      queue.run(async () => {
        results.push(i);
        await new Promise((r) => setTimeout(r, 50));
      }),
    );

    await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2]);
    expect(queue.activeCount).toBe(0);
  });

  it('queues requests when limit is reached (never rejects)', async () => {
    const queue = new ConcurrencyQueue(2, 'test');
    const executionOrder: string[] = [];

    // Fill both slots.
    const t1 = queue.run(async () => {
      executionOrder.push('t1-start');
      await new Promise((r) => setTimeout(r, 80));
      executionOrder.push('t1-end');
    });

    const t2 = queue.run(async () => {
      executionOrder.push('t2-start');
      await new Promise((r) => setTimeout(r, 80));
      executionOrder.push('t2-end');
    });

    // This one should queue.
    const t3 = queue.run(async () => {
      executionOrder.push('t3-start');
      await new Promise((r) => setTimeout(r, 30));
      executionOrder.push('t3-end');
    });

    await Promise.all([t1, t2, t3]);

    // t3 should start after t1 or t2 finishes.
    const t3StartIdx = executionOrder.indexOf('t3-start');
    const t1EndIdx = executionOrder.indexOf('t1-end');
    const t2EndIdx = executionOrder.indexOf('t2-end');
    expect(t3StartIdx).toBeGreaterThan(Math.min(t1EndIdx, t2EndIdx));
  });

  it('processes 10 tasks with limit=1 in order', async () => {
    const queue = new ConcurrencyQueue(1, 'test');
    const results: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) =>
      queue.run(async () => {
        results.push(i);
        await new Promise((r) => setTimeout(r, 5));
      }),
    );

    await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('releases slot even if task throws', async () => {
    const queue = new ConcurrencyQueue(1, 'test');

    await expect(queue.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // Next task should work fine.
    const result = await queue.run(async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('ConcurrencyManager', () => {
  it('acquires global and model-level slots', async () => {
    const manager = new ConcurrencyManager(10, undefined);
    const release = await manager.acquire('test-model', 5);
    const stats = manager.stats();
    expect(stats.globalActive).toBe(1);
    expect(stats.models['test-model'].active).toBe(1);
    release();
    expect(manager.stats().globalActive).toBe(0);
  });

  it('respects model-level concurrency limit', async () => {
    const manager = new ConcurrencyManager(100, undefined);

    const release1 = await manager.acquire('m1', 2);
    const release2 = await manager.acquire('m1', 2);

    // Third request should queue (not reject).
    let resolved = false;
    const acquirePromise = manager.acquire('m1', 2).then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    release1();
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(true);

    const release3 = await acquirePromise;
    release2();
    release3();
  });

  it('handles different models independently', async () => {
    const manager = new ConcurrencyManager(100, undefined);
    const r1 = await manager.acquire('model-a', 1);
    const r2 = await manager.acquire('model-b', 1);

    expect(manager.stats().globalActive).toBe(2);
    r1();
    r2();
    expect(manager.stats().globalActive).toBe(0);
  });

  it('respects per-token concurrency limit', async () => {
    const manager = new ConcurrencyManager(100, undefined);

    const r1 = await manager.acquire('m1', undefined, 'client-a', 2);
    const r2 = await manager.acquire('m1', undefined, 'client-a', 2);

    // Third request from same token should queue.
    let resolved = false;
    const acquirePromise = manager.acquire('m1', undefined, 'client-a', 2).then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    r1();
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(true);

    const r3 = await acquirePromise;
    r2();
    r3();
  });

  it('different tokens have independent concurrency limits', async () => {
    const manager = new ConcurrencyManager(100, undefined);

    // Token A fills its limit.
    const rA1 = await manager.acquire('m1', undefined, 'token-a', 1);

    // Token B can still acquire (different token, different limit).
    const rB1 = await manager.acquire('m1', undefined, 'token-b', 1);

    expect(manager.stats().tokens['token-a'].active).toBe(1);
    expect(manager.stats().tokens['token-b'].active).toBe(1);

    rA1();
    rB1();
  });

  it('token concurrency stats appear after use', async () => {
    const manager = new ConcurrencyManager(100, undefined);
    const r = await manager.acquire('m1', undefined, 'my-client', 5);
    const stats = manager.stats();
    expect(stats.tokens['my-client']).toBeDefined();
    expect(stats.tokens['my-client'].active).toBe(1);
    r();
    expect(manager.stats().tokens['my-client'].active).toBe(0);
  });
});
