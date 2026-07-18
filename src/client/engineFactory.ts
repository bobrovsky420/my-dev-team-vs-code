/**
 * Engine selection: the switch between the in-process `LocalEngine`, the
 * `sidecar` child process (same engine, separate process), and the future
 * `RemoteEngine`. The `myDevTeam.engine` setting is read live on every request,
 * so flipping it takes effect on the next chat turn without a reload.
 *
 * - `local` (default): the engine runs in the extension host.
 * - `sidecar`: the engine runs in a forked Node child (`dist/sidecar.js`) and
 *   talks over the sidecar protocol; the client keeps the tools, approval, and
 *   rendering. The child is spawned lazily on first use and reused, its config
 *   refreshed when the user changes a setting, and killed on deactivate. If the
 *   child crashes, the memoised instance is dropped so the next request forks a
 *   fresh one; after too many crashes in a short window the provider gives up,
 *   warns, and falls back to local until the user switches the engine.
 * - `remote`: not built yet; warns once and falls back to local.
 */
import * as vscode from 'vscode';
import { Engine } from '../protocol/engine';
import { LocalEngine } from '../engine/localEngine';
import { SidecarEngine, createForkedChannel, traceChannel } from './sidecarEngine';
import { DebugChannel, traceEngine } from './debugLog';
import { SidecarChannel } from '../sidecar/transport';
import { providersWithStoredKeyButNoEnv } from './secrets';
import { providerDescriptor, providerLabels } from '../config/providers';
import { settings, runtimeConfigSnapshot } from '../config/settings';
import { messages } from '../config/messages';

/** What the extension uses to obtain the current engine and to tear it down. */
export interface EngineProvider {
  /** The engine for the live `myDevTeam.engine` setting (built lazily, reused). */
  getEngine(): Engine;
  /** Stop the config subscription and kill the sidecar child, if any. */
  dispose(): void;
}

/**
 * Build the engine provider. `sidecarScriptPath` is the absolute path to the
 * bundled child entry (`dist/sidecar.js`), used only when the user picks the
 * sidecar engine. The LocalEngine and the SidecarEngine are each built once and
 * reused: agents are stateless between runs, and the provider wiring underneath
 * reacts to config changes on its own (the sidecar by a pushed refresh).
 *
 * `debug` is the "My Dev Team (Debug)" output channel: every engine `getEngine`
 * hands out is wrapped with `traceEngine`, so when `myDevTeam.debug` is on the
 * client<->backend protocol is logged there (whichever engine runs), and the
 * sidecar additionally forwards its provider-API traffic to the same channel.
 */
export function createEngineProvider(
  sidecarScriptPath: string,
  debug: DebugChannel
): EngineProvider {
  let local: LocalEngine | undefined;
  let sidecar: SidecarEngine | undefined;
  let warnedRemote = false;
  let warnedSidecarSecrets = false;
  // Respawn bookkeeping: the timestamps of recent child crashes, and whether we
  // have given up reforking after too many in the window. Re-armed when the user
  // switches the engine away from sidecar.
  let sidecarCrashes: number[] = [];
  let sidecarBlocked = false;
  let warnedSidecarCrashed = false;

  // Fork a fresh child and wrap it in a SidecarEngine. On close (crash/exit) the
  // memoised instance is dropped so the next getEngine() forks again; once the
  // crashes within the window exceed the cap we stop and fall back to local.
  const buildSidecar = (): SidecarEngine => {
    let channel: SidecarChannel = createForkedChannel(sidecarScriptPath);
    if (settings.telemetry.evalLogEnabled) {
      channel = traceChannel(channel, (stats) =>
        console.log(
          `[My Dev Team] sidecar channel closed: sent ${stats.sent} msg / ${stats.bytesSent} B, ` +
            `received ${stats.received} msg / ${stats.bytesReceived} B`
        )
      );
    }
    channel.onClose(() => {
      sidecar = undefined;
      const now = Date.now();
      sidecarCrashes = sidecarCrashes.filter((t) => now - t < settings.sidecar.respawnWindowMs);
      sidecarCrashes.push(now);
      if (sidecarCrashes.length >= settings.sidecar.maxRespawns) {
        sidecarBlocked = true;
      }
    });
    return new SidecarEngine(channel, runtimeConfigSnapshot, (entry) => debug.write(entry));
  };

  // The sidecar child reads cloud keys from the environment only, so a key the
  // user set via "Set API Key" (SecretStorage) silently stops working under it.
  // Warn once when sidecar is selected and that mismatch exists; re-armed when
  // the user switches away, the same way the remote warning is.
  const warnSidecarSecrets = (): void => {
    if (warnedSidecarSecrets) {
      return;
    }
    const affected = providersWithStoredKeyButNoEnv();
    if (affected.length === 0) {
      return;
    }
    warnedSidecarSecrets = true;
    const list = affected
      .map((id) => `${providerLabels[id]} (set ${providerDescriptor(id).envKey})`)
      .join(', ');
    void vscode.window.showWarningMessage(messages.engine.sidecarSecretKeysIgnored(list));
  };

  // Pick the underlying engine for the live `myDevTeam.engine` setting; getEngine
  // wraps it in the debug tracer so callers always get a traced engine.
  const resolveEngine = (): Engine => {
    const choice = settings.engine;
    if (choice !== 'sidecar') {
      warnedSidecarSecrets = false;
      // Re-arm the crash give-up: switching away and back is the user's "try
      // again", same as the other one-time warnings.
      sidecarBlocked = false;
      warnedSidecarCrashed = false;
      sidecarCrashes = [];
    }
    if (choice !== 'remote') {
      warnedRemote = false;
    }
    if (choice === 'sidecar') {
      warnSidecarSecrets();
      if (sidecarBlocked) {
        if (!warnedSidecarCrashed) {
          warnedSidecarCrashed = true;
          void vscode.window.showWarningMessage(messages.engine.sidecarCrashed);
        }
        return (local ??= new LocalEngine());
      }
      return (sidecar ??= buildSidecar());
    }
    if (choice === 'remote' && !warnedRemote) {
      void vscode.window.showWarningMessage(messages.engine.remoteUnavailable);
      warnedRemote = true;
    }
    return (local ??= new LocalEngine());
  };

  const getEngine = (): Engine => traceEngine(resolveEngine(), debug);

  // Keep the sidecar's injected config live: re-send the snapshot whenever a
  // `myDevTeam.*` setting changes (the local engine reads `settings` directly).
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('myDevTeam')) {
      sidecar?.refreshConfig();
    }
  });

  return {
    getEngine,
    dispose: () => {
      configSub.dispose();
      sidecar?.dispose();
    },
  };
}
