/**
 * The engine side of the sidecar: it hosts an `Engine` (the `LocalEngine` in
 * production) and translates the sidecar messages into engine calls. It is the
 * mirror of `client/sidecarEngine.ts` - whatever that posts, this handles, and
 * vice versa. It imports no `vscode` (the whole point of the runtime-config and
 * env-only-secrets work), so it runs in a plain Node child.
 *
 * The inversion is wired here: the run's `ClientHost` is a proxy that posts an
 * `invoke` and resolves when the parent answers with an `invoke-result`, for
 * every capability - a tool, a plan review, a check-in, a clarify, a skill body
 * - so an engine running in the child can only ever *ask* the client, named by
 * capability, exactly as in-process.
 */
import {
  Engine,
  RunClient,
  RunHandle,
  RunFailedError,
  RunCancelledError,
} from '../protocol/engine';
import {
  ClientHost,
  CapabilityName,
  CapabilityPayload,
  CapabilityResult,
} from '../protocol/capabilities';
import { RunRequest, PROTOCOL_VERSION } from '../protocol/types';
import { setRuntimeConfig } from '../config/runtimeConfig';
import { setDebugSink } from '../config/debugLog';
import { ParentMessage, ChildMessage, RunResult } from './transport';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Translate a failed run's error into the wire's `RunResult`, preserving the error shape. */
function failureResult(err: unknown): RunResult {
  if (err instanceof RunCancelledError) {
    return { ok: false, kind: 'cancelled' };
  }
  if (err instanceof RunFailedError) {
    return { ok: false, kind: 'failed', message: err.message, step: err.step, hint: err.hint };
  }
  return { ok: false, kind: 'other', message: errorMessage(err) };
}

/**
 * Build the child's message handler. `post` sends a message to the parent;
 * `makeEngine` constructs the engine to host (production passes
 * `() => new LocalEngine()`, tests pass a fake). Returns the function that
 * processes each parent message.
 */
export function createChildRuntime(
  post: (msg: ChildMessage) => void,
  makeEngine: () => Engine
): (msg: ParentMessage) => void {
  const engine = makeEngine();
  // Route the engine's debug entries (its provider-API traffic) to the parent,
  // which writes them to the "My Dev Team (Debug)" output channel. The engine
  // only emits when `myDevTeam.debug` is on (it gates on the injected runtime
  // config), so this posts nothing in the common case.
  setDebugSink({ write: (entry) => post({ t: 'debug', entry }) });
  // The readiness handshake: tell the parent the engine is up, which protocol it
  // speaks, and its kind. Deferred to a microtask so the parent (which subscribes
  // to messages as it constructs its channel) has its handler in place first -
  // in the forked case the child starts asynchronously anyway, but the in-process
  // test harness wires the two ends in the same tick.
  queueMicrotask(() =>
    post({ t: 'ready', protocolVersion: PROTOCOL_VERSION, kind: engine.kind })
  );
  const runs = new Map<string, RunHandle>();
  // Each pending invoke remembers its `runId` so a run that settles (or whose
  // parent answer never arrives) can reject the promise it left waiting rather
  // than leaking it. One map for every capability, keyed by the call's id.
  const invokes = new Map<
    string,
    { runId: string; resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  let callSeq = 0;

  /**
   * Settle a run: forget its handle and reject any invoke still awaiting an
   * `invoke-result` (the parent already settled the run, so no answer is coming),
   * so no resolver leaks.
   */
  function settleRun(runId: string): void {
    runs.delete(runId);
    for (const [callId, pending] of invokes) {
      if (pending.runId === runId) {
        invokes.delete(callId);
        pending.reject(new RunCancelledError());
      }
    }
  }

  function startRun(
    runId: string,
    request: RunRequest,
    capabilities: CapabilityName[]
  ): void {
    // The proxy host: every capability posts an `invoke` and resolves on the
    // matching `invoke-result`. The signal (only `tool` carries one) lets a
    // cancelled run abort the awaiting promise.
    function invoke<K extends CapabilityName>(
      capability: K,
      payload: CapabilityPayload<K>,
      signal?: AbortSignal
    ): Promise<CapabilityResult<K>> {
      return new Promise<CapabilityResult<K>>((resolve, reject) => {
        const callId = `${runId}#${callSeq++}`;
        invokes.set(callId, {
          runId,
          resolve: (result) => resolve(result as CapabilityResult<K>),
          reject,
        });
        if (signal) {
          const onAbort = () => {
            if (invokes.delete(callId)) {
              reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
            }
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        post({ t: 'invoke', runId, callId, capability, payload });
      });
    }

    const host: ClientHost = { tools: request.offeredTools, capabilities, invoke };
    const client: RunClient = {
      onEvent: (event) => post({ t: 'event', runId, event }),
      ...host,
    };

    let handle: RunHandle;
    try {
      handle = engine.startRun(request, client);
    } catch (err) {
      settleRun(runId);
      post({ t: 'result', runId, result: failureResult(err) });
      return;
    }
    runs.set(runId, handle);
    handle.result.then(
      (reply) => {
        settleRun(runId);
        post({ t: 'result', runId, result: { ok: true, reply } });
      },
      (err) => {
        settleRun(runId);
        post({ t: 'result', runId, result: failureResult(err) });
      }
    );
  }

  return (msg: ParentMessage): void => {
    switch (msg.t) {
      case 'config':
        setRuntimeConfig(msg.config);
        return;
      case 'start':
        startRun(msg.runId, msg.request, msg.capabilities);
        return;
      case 'cancel':
        runs.get(msg.runId)?.cancel();
        return;
      case 'invoke-result': {
        const pending = invokes.get(msg.callId);
        if (!pending) {
          return;
        }
        invokes.delete(msg.callId);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error));
        }
        return;
      }
      case 'query': {
        const answer =
          msg.method === 'listModels' ? engine.listModels() : engine.startupWarnings();
        answer.then(
          (value) => post({ t: 'query-result', queryId: msg.queryId, ok: true, value }),
          (err) => post({ t: 'query-result', queryId: msg.queryId, ok: false, error: errorMessage(err) })
        );
        return;
      }
    }
  };
}
