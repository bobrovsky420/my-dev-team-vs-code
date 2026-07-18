/**
 * The sidecar wire: the messages that cross between the client (parent) and the
 * engine host (child). This module imports no `vscode` and no Node-only APIs, so
 * both ends and the unit tests can use it. The shapes mirror the engine protocol
 * - the run-event stream, the single `invoke`/`invoke-result` inversion (every
 * engine->client request - a tool, a plan review, a check-in, a clarify, a skill
 * body - crosses it, named by capability), and the run result - so the child is
 * just the `LocalEngine` with its `RunClient` piped to the parent (see
 * sidecar/childRuntime.ts and client/sidecarEngine.ts).
 *
 * The Node client transports these as `child_process.fork` IPC messages
 * (`serialization: 'advanced'`, a real structured clone, no framing); they are
 * all plain JSON-serializable data, so a non-Node client (e.g. a future
 * JVM/Kotlin client) can instead frame them as newline-delimited JSON over a
 * stream without changing the contract - which `createStreamChannel`
 * (client/sidecarEngine.ts) does, over any writable/readable pair.
 */
import { RunRequest, Reply } from '../protocol/types';
import { RunEvent, RunStep } from '../protocol/events';
import { CapabilityName } from '../protocol/capabilities';
import { RuntimeConfig } from '../config/runtimeConfig';
import { DebugEntry } from '../config/debugLog';

/**
 * How a settled run is reported back, preserving the protocol's error shape so
 * the parent can rethrow the same `RunFailedError`/`RunCancelledError` the
 * in-process engine would have.
 */
export type RunResult =
  | { ok: true; reply: Reply }
  | { ok: false; kind: 'failed'; message: string; step?: RunStep; hint?: string }
  | { ok: false; kind: 'cancelled' }
  | { ok: false; kind: 'other'; message: string };

/** Messages the parent (client) sends to the child (engine host). */
export type ParentMessage =
  /** Inject/refresh the engine's runtime config (handshake, then on settings change). */
  | { t: 'config'; config: RuntimeConfig }
  /** Start a run. `capabilities` mirrors the real client's `ClientHost.capabilities`,
   * so the child's proxy host advertises exactly what the parent can answer and
   * the engine degrades an unsupported one. */
  | {
      t: 'start';
      runId: string;
      request: RunRequest;
      capabilities: CapabilityName[];
    }
  /** Cancel a run. */
  | { t: 'cancel'; runId: string }
  /** Answer an `invoke`: the capability's result, or the error it threw. Keyed by
   * the call's id so a run with several in-flight invokes never confuses them. */
  | { t: 'invoke-result'; callId: string; ok: true; result: unknown }
  | { t: 'invoke-result'; callId: string; ok: false; error: string }
  /** Ask the engine a one-shot question (the picker catalogue, startup warnings). */
  | { t: 'query'; queryId: string; method: 'listModels' | 'startupWarnings' };

/** Messages the child (engine host) sends back to the parent. */
export type ChildMessage =
  /**
   * The readiness handshake: posted once when the child's engine is constructed,
   * before any run. Carries the `PROTOCOL_VERSION` the child speaks and the
   * engine `kind`, so the parent can hold the first run until the child is up and
   * reject up front on a version mismatch (a stale `dist/sidecar.js`) instead of
   * mis-serialising mid-run.
   */
  | { t: 'ready'; protocolVersion: number; kind: string }
  /** A run event (the engine's `onEvent`), forwarded verbatim for rendering. */
  | { t: 'event'; runId: string; event: RunEvent }
  /**
   * The engine asks the client to run one capability (a tool, a plan review, a
   * check-in, a clarify, a skill body) and answer with an `invoke-result`.
   * `runId` finds the run's client; `callId` correlates the resolver, so a run
   * that issues several invokes at once never overwrites a pending one. The one
   * inversion message - what was the `tool-call`/`plan-review`/`continue-review`
   * trio plus the never-built clarify/skill bridges, now a single envelope.
   */
  | {
      t: 'invoke';
      runId: string;
      callId: string;
      capability: CapabilityName;
      payload: unknown;
    }
  /**
   * A debug-log entry from the child's engine (its provider-API traffic), posted
   * only when `myDevTeam.debug` is on. The parent writes it to the same "My Dev
   * Team (Debug)" output channel as its own client<->backend trace. Run-agnostic:
   * a debug entry is not tied to a single run's lifecycle.
   */
  | { t: 'debug'; entry: DebugEntry }
  /** The run settled (its `result` promise resolved or rejected). */
  | { t: 'result'; runId: string; result: RunResult }
  /** A query answer. */
  | { t: 'query-result'; queryId: string; ok: true; value: unknown }
  | { t: 'query-result'; queryId: string; ok: false; error: string };

/**
 * The duplex channel the client end (`SidecarEngine`) talks over: it posts
 * parent messages and subscribes to child messages. Production wraps a forked
 * child's stdio (see client/sidecarEngine.ts); tests wire it straight to an
 * in-process child runtime, so the whole inversion is exercised with no process.
 */
export interface SidecarChannel {
  /** Send a message to the child. */
  post(msg: ParentMessage): void;
  /** Subscribe to messages from the child. */
  onMessage(handler: (msg: ChildMessage) => void): void;
  /** Called when the child exits/crashes unexpectedly, with a reason. */
  onClose(handler: (reason: string) => void): void;
  /** Tear the channel down (kill the child). */
  dispose(): void;
}
