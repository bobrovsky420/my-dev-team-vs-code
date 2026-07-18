/**
 * Runs submitted tasks one at a time, in submission order, however many the
 * caller starts at once.
 *
 * The engine's executor fires a model step's tool calls concurrently (a
 * `Promise.all` over them), but the client must run them sequentially. Two
 * reasons: a later call in a batch may depend on an earlier one (running the
 * app after the files it needs are written), and the append-only chat can only
 * stay coherent when each call's transcript line, approval prompt, and result
 * land in order - concurrent execution interleaves several out-of-band approval
 * prompts with a transcript whose tail is held back at the first pending call,
 * which is what makes later calls (the run command) surface ahead of earlier
 * ones (the writes). Serializing per run removes both.
 *
 * Submitting a task chains it after the ones already queued and returns a
 * promise for that task's own result. One failing (or rejecting) task never
 * stalls the queue: the internal chain advances on settle, success or failure,
 * so the rest of a batch still runs and the engine gets every tool result back
 * (it requires one per call). The caller still observes each task's own outcome
 * through the returned promise. Cancellation is left to the tasks themselves -
 * each tool observes the run's abort signal and returns quickly once it fires,
 * so an aborted run drains its queue rather than hanging on it.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    // Chain off the current tail (which never rejects, see below) so this task
    // starts only once every earlier one has settled - submission order is run
    // order because `run` reads and replaces `tail` synchronously.
    const result = this.tail.then(() => task());
    // Advance the internal chain whether this task resolved or rejected, and
    // swallow both there so the chain itself never rejects - an unhandled
    // rejection would otherwise surface on the tail and stall nothing useful.
    // The caller's `result` still rejects with the task's own error.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
