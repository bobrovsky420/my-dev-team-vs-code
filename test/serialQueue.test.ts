import { describe, it, expect } from 'vitest';
import { SerialQueue } from '../src/client/serialQueue';

/** A deferred promise plus its resolve/reject, for driving task timing by hand. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SerialQueue', () => {
  it('runs tasks in submission order even when a later task would finish first', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const first = deferred<void>();

    // The first task blocks until we release it; the second resolves at once.
    // Without serialization the second would record before the first.
    const p1 = queue.run(async () => {
      await first.promise;
      order.push('first');
    });
    const p2 = queue.run(async () => {
      order.push('second');
    });

    // The second task must not have started while the first is still pending.
    await Promise.resolve();
    expect(order).toEqual([]);

    first.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('never overlaps two tasks', async () => {
    const queue = new SerialQueue();
    let active = 0;
    let maxActive = 0;
    const task = () =>
      queue.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        await Promise.resolve();
        active--;
      });

    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it('keeps running the rest of the queue after a task rejects', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const failing = queue.run(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const after = queue.run(async () => {
      order.push('after');
      return 'ok';
    });

    // The caller sees the failing task's own rejection...
    await expect(failing).rejects.toThrow('boom');
    // ...but the queue advanced and the following task still ran and resolved.
    await expect(after).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'after']);
  });

  it('resolves each task with its own result', async () => {
    const queue = new SerialQueue();
    const results = await Promise.all([
      queue.run(async () => 1),
      queue.run(async () => 2),
      queue.run(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });
});
