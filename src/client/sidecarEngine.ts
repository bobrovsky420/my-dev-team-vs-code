/**
 * The client end of the sidecar: an `Engine` that runs the real engine in a
 * child process. It owns no agent logic - it forwards each run over the channel,
 * folds the child's events back into `client.onEvent`, and services the engine's
 * inversion on this side of the boundary: every `invoke` runs through the real
 * `client.invoke` (so files, the shell, the approval gate, the plan-review and
 * check-in prompts, the clarify pop-up, and the skill bodies all stay in the
 * editor), named by capability. The run's result is settled from the terminal
 * `result` message, rethrowing the same `RunFailedError`/`RunCancelledError` the
 * in-process engine would have.
 *
 * Before any run is started the parent waits for the child's `ready` handshake
 * (which carries the protocol version the child speaks): a stale `dist/sidecar.js`
 * is rejected up front with a clear "reload" message instead of mis-serialising
 * mid-run, and a child that dies during module load fails the first run with a
 * timeout rather than hanging it. One-shot queries (`listModels`/`startupWarnings`)
 * time out too, and a failed query surfaces as a warning rather than disappearing,
 * so the health check still fires when the child cannot reach Ollama.
 *
 * It is transport-agnostic: it takes a `SidecarChannel`, so a unit test can wire
 * it straight to an in-process child runtime, and production wraps a forked
 * child (`createForkedChannel`) or any stream pair (`createStreamChannel`, the
 * remote-ready NDJSON variant).
 */
import { fork } from 'node:child_process';
import {
  Engine,
  RunClient,
  RunHandle,
  RunFailedError,
  RunCancelledError,
} from '../protocol/engine';
import { RunRequest, Reply, ModelChoice, PROTOCOL_VERSION } from '../protocol/types';
import { CapabilityName } from '../protocol/capabilities';
import { RuntimeConfig } from '../config/runtimeConfig';
import { DebugEntry } from '../config/debugLog';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import { SidecarChannel, ChildMessage, ParentMessage, RunResult } from '../sidecar/transport';

interface RunState {
  client: RunClient;
  ac: AbortController;
  resolve: (reply: Reply) => void;
  reject: (err: unknown) => void;
  settled: boolean;
  /** True once `start` has been posted to the child (so a cancel must be forwarded). */
  started: boolean;
  /** True if cancel was called before the run could start (so it never starts). */
  cancelRequested: boolean;
}

export class SidecarEngine implements Engine {
  readonly kind = 'sidecar';
  private runSeq = 0;
  private querySeq = 0;
  private readonly runs = new Map<string, RunState>();
  private readonly queries = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** Set once the child exits/crashes; further runs fail fast with this reason. */
  private closedReason: string | undefined;

  // The readiness handshake. `whenReady` resolves once the child's `ready`
  // arrives (and its protocol version matches), rejects on a version mismatch or
  // the readiness timeout, and the first run is held until it settles.
  private readyState: 'pending' | 'ready' | 'failed' = 'pending';
  private readyError: Error | undefined;
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly channel: SidecarChannel,
    private readonly getConfig: () => RuntimeConfig,
    /** Where the child's debug entries (its provider-API traffic) are written. */
    private readonly onDebug?: (entry: DebugEntry) => void
  ) {
    channel.onMessage((msg) => this.handle(msg));
    channel.onClose((reason) => this.handleClose(reason));
    // Hand the engine its config before any run (env-var secrets ride in the
    // child's process environment, so only this non-secret config is sent).
    channel.post({ t: 'config', config: getConfig() });
    this.readyTimer = setTimeout(
      () => this.rejectReady(new RunFailedError(undefined, messages.sidecar.notReady)),
      settings.sidecar.readyTimeoutMs
    );
    // Do not let the readiness timeout keep the host's event loop alive.
    this.readyTimer.unref?.();
  }

  /** Re-send the runtime config; call when the user changed a setting. */
  refreshConfig(): void {
    if (!this.closedReason) {
      this.channel.post({ t: 'config', config: this.getConfig() });
    }
  }

  dispose(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    this.channel.dispose();
  }

  startRun(request: RunRequest, client: RunClient): RunHandle {
    const runId = `run-${this.runSeq++}`;
    const ac = new AbortController();
    let resolve!: (reply: Reply) => void;
    let reject!: (err: unknown) => void;
    const result = new Promise<Reply>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const state: RunState = {
      client,
      ac,
      resolve,
      reject,
      settled: false,
      started: false,
      cancelRequested: false,
    };
    this.runs.set(runId, state);

    if (this.closedReason) {
      this.failRun(runId, new RunFailedError(undefined, this.closedReason));
    } else {
      // Hold the start until the child says it is up (or fails to). A run
      // cancelled while waiting never starts.
      this.whenReady().then(
        () => {
          if (state.settled || state.cancelRequested) {
            if (!state.settled) {
              this.failRun(runId, new RunCancelledError());
            }
            return;
          }
          state.started = true;
          this.channel.post({
            t: 'start',
            runId,
            request,
            // Advertise exactly what the real client implements, so the child's
            // proxy host offers the same set and the engine degrades the rest.
            capabilities: [...client.capabilities],
          });
        },
        (err) => this.failRun(runId, err)
      );
    }

    return {
      result,
      cancel: () => {
        ac.abort(new RunCancelledError());
        state.cancelRequested = true;
        if (state.started && !this.closedReason) {
          this.channel.post({ t: 'cancel', runId });
        }
      },
    };
  }

  async listModels(): Promise<ModelChoice[]> {
    try {
      return (await this.query('listModels')) as ModelChoice[];
    } catch {
      // The picker has nothing to show if the child cannot answer; an empty
      // catalogue is the only sensible fallback (the startup warning carries the
      // "engine unreachable" signal).
      return [];
    }
  }

  async startupWarnings(): Promise<string[]> {
    try {
      return (await this.query('startupWarnings')) as string[];
    } catch (err) {
      // Distinguish "the child says all is well" (an empty array it returned)
      // from "the child did not answer": the latter is itself worth surfacing,
      // so the health check still warns instead of silently reporting nothing.
      return [messages.sidecar.probeFailed(errorMessage(err))];
    }
  }

  private query(method: 'listModels' | 'startupWarnings'): Promise<unknown> {
    if (this.closedReason) {
      return Promise.reject(new Error(this.closedReason));
    }
    const queryId = `q-${this.querySeq++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.queries.delete(queryId)) {
          reject(new Error(messages.sidecar.queryTimeout));
        }
      }, settings.sidecar.queryTimeoutMs);
      timer.unref?.();
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      this.queries.set(queryId, {
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
      });
      this.channel.post({ t: 'query', queryId, method });
    });
  }

  private handle(msg: ChildMessage): void {
    switch (msg.t) {
      case 'ready':
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.rejectReady(
            new RunFailedError(
              undefined,
              messages.sidecar.versionMismatch(msg.protocolVersion, PROTOCOL_VERSION)
            )
          );
        } else {
          this.resolveReady();
        }
        return;
      case 'event':
        this.runs.get(msg.runId)?.client.onEvent(msg.event);
        return;
      case 'debug':
        // The child's engine debug entries (provider-API traffic); the parent
        // owns the output channel they are written to.
        this.onDebug?.(msg.entry);
        return;
      case 'invoke': {
        const state = this.runs.get(msg.runId);
        if (!state) {
          // An `invoke` for a run we no longer track (a late or duplicate
          // message, or one whose run already settled). Answer with an error so
          // the child's awaiting promise settles instead of leaking, rather than
          // dropping it silently.
          this.channel.post({
            t: 'invoke-result',
            callId: msg.callId,
            ok: false,
            error: messages.sidecar.orphanToolCall,
          });
          return;
        }
        // The run's real client services the capability: a tool through the
        // ToolHost and approval gate, a plan review / check-in / clarify through
        // its pop-up, a skill body from the bodies collected this turn. The abort
        // signal lets a cancelled run stop an in-flight tool, and the run id
        // attributes a tool's approval prompt to the owning turn. The dispatch is
        // generic, so the capability/payload types are erased to the wire's
        // `unknown` here and restored by the client's own typed handlers.
        const invoke = state.client.invoke as (
          capability: CapabilityName,
          payload: unknown,
          signal?: AbortSignal,
          correlationId?: string
        ) => Promise<unknown>;
        invoke(msg.capability, msg.payload, state.ac.signal, msg.runId).then(
          (result) =>
            this.channel.post({ t: 'invoke-result', callId: msg.callId, ok: true, result }),
          (err) =>
            this.channel.post({
              t: 'invoke-result',
              callId: msg.callId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
        );
        return;
      }
      case 'result':
        this.settleResult(msg.runId, msg.result);
        return;
      case 'query-result': {
        const q = this.queries.get(msg.queryId);
        if (!q) {
          return;
        }
        this.queries.delete(msg.queryId);
        if (msg.ok) {
          q.resolve(msg.value);
        } else {
          q.reject(new Error(msg.error));
        }
        return;
      }
    }
  }

  private resolveReady(): void {
    if (this.readyState !== 'pending') {
      return;
    }
    this.readyState = 'ready';
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      w.resolve();
    }
  }

  private rejectReady(err: Error): void {
    if (this.readyState !== 'pending') {
      return;
    }
    this.readyState = 'failed';
    this.readyError = err;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      w.reject(err);
    }
  }

  private whenReady(): Promise<void> {
    if (this.readyState === 'ready') {
      return Promise.resolve();
    }
    if (this.readyState === 'failed') {
      return Promise.reject(this.readyError);
    }
    return new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  private failRun(runId: string, err: unknown): void {
    const state = this.runs.get(runId);
    if (!state || state.settled) {
      return;
    }
    state.settled = true;
    this.runs.delete(runId);
    state.reject(err);
  }

  private settleResult(runId: string, result: RunResult): void {
    const state = this.runs.get(runId);
    if (!state || state.settled) {
      return;
    }
    state.settled = true;
    this.runs.delete(runId);
    if (result.ok) {
      state.resolve(result.reply);
    } else if (result.kind === 'cancelled') {
      state.reject(new RunCancelledError());
    } else if (result.kind === 'failed') {
      state.reject(new RunFailedError(result.step, result.message, result.hint));
    } else {
      state.reject(new Error(result.message));
    }
  }

  private handleClose(reason: string): void {
    this.closedReason = reason;
    // A run waiting on readiness (never started) is rejected with the close
    // reason too, so nothing is left pending.
    this.rejectReady(new RunFailedError(undefined, reason));
    for (const state of this.runs.values()) {
      if (!state.settled) {
        state.settled = true;
        state.reject(new RunFailedError(undefined, reason));
      }
    }
    this.runs.clear();
    for (const q of this.queries.values()) {
      q.reject(new Error(reason));
    }
    this.queries.clear();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A production channel that forks the bundled engine child (`dist/sidecar.js`)
 * and talks to it over `child_process` IPC. The child inherits the parent's
 * environment, so env-var API keys resolve there with nothing on the wire.
 *
 * - `execArgv: []` so the child does not inherit the extension host's launch
 *   flags - notably `--inspect`/`--inspect-brk` under the debugger, which would
 *   make the child fail to bind an already-used inspector port.
 * - `serialization: 'advanced'` so messages cross as a real structured clone
 *   (the `fork` default is `'json'`, which silently drops `undefined`-valued
 *   fields in a `tool-call`'s args).
 */
export function createForkedChannel(scriptPath: string): SidecarChannel {
  const child = fork(scriptPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: [],
    serialization: 'advanced',
  });
  const messageHandlers: ((m: ChildMessage) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  let closed = false;
  const close = (reason: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const h of closeHandlers) {
      h(reason);
    }
  };
  child.on('message', (m) => {
    for (const h of messageHandlers) {
      h(m as ChildMessage);
    }
  });
  child.on('exit', (code, signal) =>
    close(`The engine sidecar exited unexpectedly (${signal ?? `code ${code}`}).`)
  );
  child.on('error', (err) => close(`The engine sidecar could not start: ${err.message}`));
  return {
    post: (msg) => {
      if (!closed) {
        child.send(msg);
      }
    },
    onMessage: (h) => {
      messageHandlers.push(h);
    },
    onClose: (h) => {
      closeHandlers.push(h);
    },
    dispose: () => {
      closed = true;
      child.kill();
    },
  };
}

/**
 * A transport-neutral channel over a writable/readable stream pair, framing each
 * message as newline-delimited JSON (NDJSON). This is the remote-ready variant
 * the transport's docs anticipate: the same `SidecarEngine`/`childRuntime` pair
 * works over a socket or stdio, not just `fork` IPC, which is the cheap step
 * toward the Phase-B remote engine and a JVM/Kotlin client that cannot use Node's
 * IPC. (JSON framing, unlike structured clone, does not carry `undefined`; the
 * contract is plain JSON data, so that is by design.)
 *
 * `outgoing` carries parent messages to the peer; `incoming` carries the peer's
 * messages back. A malformed line is skipped rather than tearing the channel
 * down. The stream ending or erroring closes the channel; `dispose` ends the
 * outgoing stream (the caller owns the underlying socket/process lifecycle).
 */
export function createStreamChannel(
  outgoing: NodeJS.WritableStream,
  incoming: NodeJS.ReadableStream
): SidecarChannel {
  const messageHandlers: ((m: ChildMessage) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  let closed = false;
  let buffer = '';
  const close = (reason: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const h of closeHandlers) {
      h(reason);
    }
  };
  incoming.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) {
        continue;
      }
      let msg: ChildMessage;
      try {
        msg = JSON.parse(line) as ChildMessage;
      } catch {
        // Skip a malformed frame rather than killing the whole channel.
        continue;
      }
      for (const h of messageHandlers) {
        h(msg);
      }
    }
  });
  incoming.on('end', () => close('The engine sidecar stream ended.'));
  incoming.on('error', (err: Error) =>
    close(`The engine sidecar stream failed: ${err.message}`)
  );
  return {
    post: (msg) => {
      if (!closed) {
        outgoing.write(`${JSON.stringify(msg)}\n`);
      }
    },
    onMessage: (h) => {
      messageHandlers.push(h);
    },
    onClose: (h) => {
      closeHandlers.push(h);
    },
    dispose: () => {
      closed = true;
      outgoing.end();
    },
  };
}

/** Running totals a `traceChannel` reports for diagnosing a slow sidecar. */
export interface ChannelStats {
  /** Parent messages posted to the child. */
  sent: number;
  /** Child messages received. */
  received: number;
  /** Approximate JSON bytes posted. */
  bytesSent: number;
  /** Approximate JSON bytes received. */
  bytesReceived: number;
}

/**
 * Wrap a channel to count the messages and (approximate) bytes crossing it in
 * each direction, reporting the running totals to `report` whenever the channel
 * closes or is disposed. Used behind the telemetry flag (engineFactory) to make
 * a slow or chatty sidecar diagnosable; the unwrapped channel is used otherwise,
 * so there is no cost when tracing is off.
 */
export function traceChannel(
  channel: SidecarChannel,
  report: (stats: ChannelStats) => void
): SidecarChannel {
  const stats: ChannelStats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 };
  const size = (msg: unknown): number => {
    try {
      return JSON.stringify(msg).length;
    } catch {
      return 0;
    }
  };
  return {
    post: (msg: ParentMessage) => {
      stats.sent++;
      stats.bytesSent += size(msg);
      channel.post(msg);
    },
    onMessage: (h) => {
      channel.onMessage((m) => {
        stats.received++;
        stats.bytesReceived += size(m);
        h(m);
      });
    },
    onClose: (h) => {
      channel.onClose((reason) => {
        report({ ...stats });
        h(reason);
      });
    },
    dispose: () => {
      report({ ...stats });
      channel.dispose();
    },
  };
}
