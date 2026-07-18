/**
 * The client end of debug logging (`myDevTeam.debug`): a thin wrapper over the
 * "My Dev Team (Debug)" output channel plus an `Engine` decorator that traces the
 * client <-> backend protocol. Together with the engine-side provider middleware
 * (engine/core/providerLog.ts), turning the setting on logs every layer of a run:
 *
 *  - `DebugChannel` writes a `DebugEntry` to the output channel (gated on the live
 *    setting), and exposes `asSink()` so the in-process local engine's provider
 *    logs land in the same channel; the sidecar's provider logs arrive over the
 *    wire and are written the same way.
 *  - `traceEngine` wraps an `Engine` so the run request, the stream of run events,
 *    and every `invoke` inversion (a tool, a plan review, a check-in, a clarify,
 *    a skill body - the one seam now carries them all) are logged - identically
 *    whether the wrapped engine is the in-process `LocalEngine` or the
 *    `SidecarEngine`, since both implement the same port.
 *
 * Nothing here changes a run: when the setting is off `traceEngine` returns the
 * engine untouched, and a write is a no-op. Diagnostic only - the channel carries
 * the run's raw content and stays on the user's machine.
 */
import * as vscode from 'vscode';
import { Engine, RunClient, RunHandle } from '../protocol/engine';
import { CapabilityName, CapabilityPayload, CapabilityResult } from '../protocol/capabilities';
import { RunRequest } from '../protocol/types';
import { settings } from '../config/settings';
import { DebugEntry, DebugSink, stringifyDetail } from '../config/debugLog';

/** The output-channel display name (also the channel id). */
export const DEBUG_CHANNEL_NAME = 'My Dev Team (Debug)';

/** Writes debug entries to an output channel, gated on the live `myDevTeam.debug`. */
export class DebugChannel {
  constructor(private readonly channel: vscode.OutputChannel) {}

  /** Whether debug logging is currently on (read live). */
  enabled(): boolean {
    return settings.debug;
  }

  /** Append one entry, prefixed with a timestamp and the source. A no-op when off. */
  write(entry: DebugEntry): void {
    if (!settings.debug) {
      return;
    }
    const stamp = new Date().toISOString();
    this.channel.appendLine(`[${stamp}] [${entry.source}] ${entry.label}`);
    if (entry.detail) {
      // Indent the payload so it reads as a block under its header line.
      for (const line of entry.detail.split('\n')) {
        this.channel.appendLine(`    ${line}`);
      }
    }
  }

  /** A `DebugSink` view, for injecting into the in-process engine (config/debugLog.ts). */
  asSink(): DebugSink {
    return { write: (entry) => this.write(entry) };
  }
}

/**
 * Wrap an engine so every run is traced to `channel`. When debug is off the engine
 * is returned untouched (read live, so a later run picks up a toggle), so there is
 * no wrapping cost, no behaviour change, and the engine's own identity/memoisation
 * is preserved in the common case. When on, only `startRun` is intercepted; every
 * other member (kind, listModels, startupWarnings) passes straight through.
 */
export function traceEngine(engine: Engine, channel: DebugChannel): Engine {
  if (!channel.enabled()) {
    return engine;
  }
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'startRun') {
        return (request: RunRequest, client: RunClient): RunHandle =>
          tracedRun(target, request, client, channel);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Start a run with both the request and the run client traced. */
function tracedRun(
  engine: Engine,
  request: RunRequest,
  client: RunClient,
  channel: DebugChannel
): RunHandle {
  channel.write({
    source: 'client',
    label: `-> start run (prompt ${request.prompt.length} chars, ${request.offeredTools.length} tools)`,
    detail: stringifyDetail(request),
  });
  const traced: RunClient = {
    onEvent: (event) => {
      channel.write({ source: 'backend', label: `<- event ${event.type}`, detail: stringifyDetail(event) });
      client.onEvent(event);
    },
    tools: client.tools,
    capabilities: client.capabilities,
    // One traced seam for every engine->client request - any tool (including the
    // engine-built clarify and skill), a plan review, a check-in - logged by
    // capability. Tracing the single `invoke` covers them all.
    invoke: async <K extends CapabilityName>(
      capability: K,
      payload: CapabilityPayload<K>,
      signal?: AbortSignal,
      correlationId?: string
    ): Promise<CapabilityResult<K>> => {
      channel.write({
        source: 'backend',
        label: `<- invoke ${capability}`,
        detail: stringifyDetail(payload),
      });
      try {
        const result = await client.invoke(capability, payload, signal, correlationId);
        channel.write({
          source: 'client',
          label: `-> invoke-result ${capability}`,
          detail: stringifyDetail(result),
        });
        return result;
      } catch (err) {
        channel.write({
          source: 'client',
          label: `-> invoke-error ${capability}`,
          detail: stringifyDetail(err),
        });
        throw err;
      }
    },
  };

  const handle = engine.startRun(request, traced);
  handle.result.then(
    (reply) => channel.write({ source: 'backend', label: '<- result (ok)', detail: stringifyDetail(reply) }),
    (err) => channel.write({ source: 'backend', label: '<- result (error)', detail: stringifyDetail(err) })
  );
  return handle;
}
