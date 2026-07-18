/**
 * The stdio sidecar child entry point: the same engine host as sidecar/main.ts,
 * but speaking the sidecar wire as newline-delimited JSON over stdin/stdout
 * instead of `child_process` IPC. This is the entry a non-Node parent launches
 * - the IntelliJ/Kotlin client spawns `node dist/sidecar-stdio.js` and frames
 * the identical `ParentMessage`/`ChildMessage` shapes as NDJSON, so the engine
 * cannot tell the two transports apart.
 *
 * Like sidecar/main.ts, this module - and everything it pulls in - must never
 * import `vscode`: it runs outside any editor. esbuild bundles it to
 * `dist/sidecar-stdio.js` (see esbuild.mjs).
 */
import { format } from 'node:util';
import { LocalEngine } from '../engine/localEngine';
import { createChildRuntime } from './childRuntime';
import { createNdjsonReader, ndjsonLine } from './ndjson';
import { ParentMessage } from './transport';

// stdout is the protocol stream: any stray console output there would corrupt
// a frame, so route every console level to stderr before the engine runs.
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[level] = (...args: unknown[]): void => {
    process.stderr.write(`${format(...(args as [unknown, ...unknown[]]))}\n`);
  };
}

const handle = createChildRuntime(
  (msg) => {
    process.stdout.write(ndjsonLine(msg));
  },
  () => new LocalEngine()
);

process.stdin.setEncoding('utf8');
process.stdin.on('data', createNdjsonReader((msg) => handle(msg as ParentMessage)));
// The parent owns the lifecycle: when its end of the pipe closes (it exited or
// disposed the channel), exit rather than linger as an orphan.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
