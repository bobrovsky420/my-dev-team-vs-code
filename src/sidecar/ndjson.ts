/**
 * NDJSON framing for the stdio sidecar: one JSON message per line. The child
 * entry point (sidecar/stdioMain.ts) uses it to speak the sidecar wire over
 * stdin/stdout, where `child_process` IPC is not available - which is what a
 * non-Node parent (the IntelliJ/Kotlin client) launches. It mirrors the framing
 * of the parent-side `createStreamChannel` (client/sidecarEngine.ts): plain
 * JSON, newline-delimited, a malformed line skipped rather than fatal. This
 * module imports no `vscode` and no Node APIs, so both ends and the unit tests
 * can use it.
 */

/** Frame one message as an NDJSON line (JSON followed by a newline). */
export function ndjsonLine(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Build a chunk feeder that reassembles NDJSON messages from an incoming
 * stream: chunks may split or join lines arbitrarily. A malformed line is
 * skipped so one bad frame cannot tear the channel down.
 */
export function createNdjsonReader(
  onMessage: (msg: unknown) => void
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = undefined;
        }
        if (msg !== undefined) {
          onMessage(msg);
        }
      }
      newline = buffer.indexOf('\n');
    }
  };
}
