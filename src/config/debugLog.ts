/**
 * The engine's debug-logging seam: an injectable sink the engine emits raw
 * diagnostic entries to when `myDevTeam.debug` is on, without importing `vscode`.
 * Like `config/runtimeConfig.ts` and `config/credentials.ts`, this lets the
 * engine run wherever - in the extension host or in the sidecar child - and still
 * surface its provider-API traffic to the user.
 *
 * Who sets it:
 *  - in the host, the client injects a sink that writes to the "My Dev Team
 *    (Debug)" output channel (client/debugLog.ts);
 *  - in the sidecar child, `createChildRuntime` injects a sink that posts each
 *    entry to the parent over the wire (a `debug` message), where the parent
 *    writes it to the same channel.
 *
 * Until something injects, a no-op sink keeps `emitDebug` cheap and safe. The
 * engine still gates on `runtimeConfig().debugEnabled` before emitting, so there
 * is no serialization cost when debug is off.
 */

/**
 * One debug entry. Wire-serializable (it crosses the sidecar boundary): `detail`
 * is a pre-rendered string, so a class instance in the engine's raw request or
 * response can never break the structured clone / JSON framing.
 */
export interface DebugEntry {
  /** Which party produced the entry. */
  source: 'client' | 'backend' | 'provider';
  /** A short human label, e.g. "provider request" or "<- event triaged". */
  label: string;
  /** The raw payload, already rendered to a string (omitted when there is none). */
  detail?: string;
}

/** Where the engine's debug entries go. Plain - no `vscode`. */
export interface DebugSink {
  write(entry: DebugEntry): void;
}

let sink: DebugSink | undefined;

/** Inject the debug sink (an output channel in the host, a wire post in the child). */
export function setDebugSink(next: DebugSink | undefined): void {
  sink = next;
}

/**
 * Emit a debug entry to the injected sink. Never throws (a logging failure must
 * never fail the run it only observes) and is a no-op until a sink is injected.
 */
export function emitDebug(entry: DebugEntry): void {
  try {
    sink?.write(entry);
  } catch {
    // A broken sink must never take the run down with it.
  }
}

/**
 * Render an arbitrary value to a readable string for a `DebugEntry.detail`.
 * Pretty-prints plain data as JSON; falls back to `String(value)` for anything
 * that cannot be stringified (a cycle, a BigInt). Errors are rendered with their
 * message so a logged failure is legible.
 */
export function stringifyDetail(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value, replacer, 2);
  } catch {
    return String(value);
  }
}

/** JSON replacer that keeps the dump finite and legible. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}
