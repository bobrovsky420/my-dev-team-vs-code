/**
 * The engine port: the one interface the UI layer talks to. Two
 * implementations exist or are planned - the in-process LocalEngine
 * (src/engine/localEngine.ts) and a Phase-B RemoteEngine speaking this same
 * contract over HTTP - and a VS Code setting switches between them, so
 * nothing above this interface may depend on which one is running.
 */
import { ModelChoice, Reply, RunRequest } from './types';
import { RunEvent, RunStep } from './events';
import { ClientHost } from './capabilities';

/**
 * What the client hands the engine for one run: where to deliver events
 * (`onEvent`), plus the one inversion seam the engine reaches it through (the
 * `ClientHost` it extends - `tools`, `capabilities`, and `invoke`). Every
 * engine->client request - running a tool, approving a plan, an executor
 * check-in, a clarifying question, loading a skill body - crosses that single
 * `invoke` seam, named by capability, so a new capability never needs a new
 * method here. The UI lives entirely on the client: the engine only ever asks,
 * and a capability the client does not list in `capabilities` simply degrades
 * (the engine never gates, never asks, reports a skill unavailable, ...), so
 * each one is purely additive.
 *
 * `onEvent` must not throw into the engine - a rendering problem must never fail
 * the run it is only observing.
 */
export interface RunClient extends ClientHost {
  onEvent(event: RunEvent): void;
}

/** A started run. `result` settles exactly once; `cancel` is idempotent. */
export interface RunHandle {
  /**
   * The final validated reply. Rejects with `RunFailedError` when the run
   * failed, `RunCancelledError` when it was cancelled, or the raw error for
   * anything unexpected.
   */
  result: Promise<Reply>;
  /** Stop the run: abort model calls and in-flight tool executions. */
  cancel(): void;
}

export interface Engine {
  readonly kind: 'local' | 'remote' | 'sidecar';
  startRun(request: RunRequest, client: RunClient): RunHandle;
  /**
   * Activation-time health probe: human-readable warnings the UI should
   * surface (unreachable server, missing models), empty when all is well.
   * Must never throw and should answer quickly - it must not delay activation.
   */
  startupWarnings(): Promise<string[]>;
  /**
   * The models the user may pick from in the `/model` picker, the "Auto"
   * choice first. The model registry is otherwise an engine internal; this is
   * the one place it is exposed, as user-facing choices (id, label, whether it
   * can run now). Must never throw.
   */
  listModels(): Promise<ModelChoice[]>;
}

/**
 * The credentials a run carries to a remote engine. The LocalEngine ignores
 * them; Phase B attaches them as a header per request (never in the protocol
 * body), which is what makes per-request billing and rate limiting work.
 */
export type Credentials =
  | { kind: 'anonymous' }
  | { kind: 'bearer'; token: string };

/** Supplies credentials at request time (VS Code auth session, stored key...). */
export interface AuthProvider {
  getCredentials(): Promise<Credentials>;
}

/** A run that ended in a step failure. `hint` is engine-supplied troubleshooting text. */
export class RunFailedError extends Error {
  constructor(
    readonly step: RunStep | undefined,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'RunFailedError';
  }
}

/** A run stopped by `RunHandle.cancel` before it could finish. */
export class RunCancelledError extends Error {
  constructor() {
    super('The run was cancelled.');
    this.name = 'RunCancelledError';
  }
}
