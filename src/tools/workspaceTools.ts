import * as vscode from 'vscode';
import * as path from 'path';
import { exec, ChildProcess, ExecOptions } from 'child_process';
import { promisify } from 'util';
import {
  Approver,
  ChangeReporter,
  RunMirror,
  RUN_SCOPE,
  RUN_DANGEROUS_SCOPE,
} from './types';
import { settings } from '../config/settings';
import { messages, TRUNCATED_SUFFIX } from '../config/messages';
import { environment } from '../config/environment';
import { searchContent } from './contentSearch';
import {
  isAllowedCommand,
  isDeniedCommand,
  suggestedAllowPrefix,
  addAllowedCommand,
} from './commandPolicy';

// Re-exported so existing importers (client/references.ts) keep their import
// from this module while the content-search engine lives in its own file.
export { searchContent } from './contentSearch';
export type { ContentMatch, ContentSearchResult } from './contentSearch';

const execAsync = promisify(exec);

/** Every open workspace folder, or throw when none is open. */
function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder is open.');
  }
  return folders;
}

/** The first workspace folder: the default root and the `run` tool's cwd. */
function workspaceRoot(): vscode.Uri {
  return workspaceFolders()[0].uri;
}

/**
 * True when every open folder lives on a virtual (non-`file`) filesystem - a
 * GitHub repo opened in the browser, say. The `run` tool spawns a child
 * process against a real cwd and so cannot work there; the fs-based tools
 * (read/search/write/edit) still do.
 */
function isVirtualWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders;
  return (
    !!folders && folders.length > 0 && folders.every((f) => f.uri.scheme !== 'file')
  );
}

/**
 * Whether a thrown fs error means "the file does not exist", however it
 * surfaced: VS Code's `FileSystemError` (`code === 'FileNotFound'`) on a
 * virtual filesystem, Node's `ENOENT` on the local one (`vscode.workspace.fs`
 * passes the raw Node error through for `file:` paths), or the in-memory test
 * fake (a plain `Error` whose message starts with `ENOENT`). Matching the code
 * first and the message only as a fallback keeps it robust across all three.
 */
function isFileNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === 'ENOENT' || e?.code === 'FileNotFound') {
    return true;
  }
  return typeof e?.message === 'string' && /ENOENT|no such file|file ?not ?found/i.test(e.message);
}

/** Whether a path exists (a stat that does not throw), used for disambiguation. */
async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a tool-supplied path into the workspace folder it targets and the path
 * relative to that folder. In a multi-root workspace `asRelativePath` prefixes
 * every path it returns with the folder's name (e.g. `backend/src/app.ts`), so
 * a path whose first segment names an open folder is resolved against that
 * folder; a bare path - and every single-folder workspace - resolves against
 * the first folder, exactly as before. This keeps the tools consistent: a path
 * the search tool lists (it scans all roots) is one read/write/edit can open.
 *
 * The head segment is ambiguous: it can name an open folder *or* a real
 * top-level directory in the first folder that happens to share that name (a
 * `backend/` directory while a `backend` root also exists). To avoid silently
 * shadowing a real file, an existing path in the first folder wins - the head
 * resolves to the named folder only when nothing exists at that path in the
 * first folder (which covers the `asRelativePath` prefixed form and a
 * not-yet-created write target alike).
 */
async function resolveFolder(
  relPath: string
): Promise<{ root: vscode.Uri; rel: string }> {
  const folders = workspaceFolders();
  if (folders.length > 1) {
    const slash = relPath.search(/[\\/]/);
    const head = slash === -1 ? relPath : relPath.slice(0, slash);
    const match = folders.find((f) => f.name === head);
    if (match) {
      const inFirst = vscode.Uri.joinPath(folders[0].uri, ...relPath.split(/[\\/]/));
      if (await pathExists(inFirst)) {
        return { root: folders[0].uri, rel: relPath };
      }
      return { root: match.uri, rel: slash === -1 ? '' : relPath.slice(slash + 1) };
    }
  }
  return { root: folders[0].uri, rel: relPath };
}

/** A resolved, contained workspace path plus what `revalidateContainment` needs. */
interface ResolvedPath {
  /** The Uri to read/write/edit. */
  uri: vscode.Uri;
  /** The workspace folder the path resolved against. */
  root: vscode.Uri;
  /** The path relative to `root` (the protected-path check operates on this). */
  relInRoot: string;
  /** The original tool path, kept only for error messages. */
  relPath: string;
}

/**
 * Reject the path if any component - the target or an ancestor - is a symbolic
 * link, since a link inside the workspace can still point outside it. Otherwise
 * `read` could follow a link to exfiltrate a file and `write` could clobber one
 * through it; a symlinked *directory* escapes just as a symlinked file does, so
 * every ancestor is checked, not only the final component. A component that
 * does not exist yet (a new `write` target) has nothing to follow, so a stat
 * that fails is not an error here.
 */
async function assertNoSymlink(
  root: vscode.Uri,
  relInRoot: string,
  relPath: string
): Promise<void> {
  let prefix = root;
  for (const segment of relInRoot.split(/[\\/]/)) {
    prefix = vscode.Uri.joinPath(prefix, segment);
    let stat: vscode.FileStat | undefined;
    try {
      stat = await vscode.workspace.fs.stat(prefix);
    } catch {
      continue;
    }
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`Path is a symbolic link, which is not allowed: ${relPath}`);
    }
  }
}

/**
 * Resolve a workspace-relative path to a Uri, rejecting anything that points
 * outside the workspace (absolute paths, `..` traversal, or a symbolic link
 * anywhere in the resolved path). Tool inputs come from a model and the tools
 * are callable by any chat model in the editor, so the path is untrusted. The
 * path is first mapped to its workspace folder (see `resolveFolder`), then
 * checked against that folder's root.
 *
 * This is **check-then-use, not atomic**: the symlink check stats each path
 * component, but the fs API offers no "open without following links", so a
 * component could in principle be swapped for a link between the check here and
 * the later read/write. Callers shrink that window by re-validating with
 * `revalidateContainment` right against the operation; the residual race needs
 * a local attacker and is documented as low-severity rather than fully closed.
 */
async function resolveWorkspaceUri(relPath: string): Promise<ResolvedPath> {
  const { root, rel: relativeToRoot } = await resolveFolder(relPath);
  const rootPath = path.resolve(root.fsPath);
  const target = path.resolve(rootPath, relativeToRoot);
  const rel = path.relative(rootPath, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${relPath}`);
  }
  await assertNoSymlink(root, rel, relPath);
  return { uri: vscode.Uri.joinPath(root, ...rel.split(/[\\/]/)), root, relInRoot: rel, relPath };
}

/**
 * Re-run the symlink containment check on an already-resolved path, to be
 * called right before a write (and right after a read) so the window in which
 * a component could be swapped for an escaping symlink between
 * `resolveWorkspaceUri` and the operation is as small as the fs API allows. A
 * read re-validates *after* reading so bytes that may have come through a
 * swapped-in link are discarded rather than returned.
 */
async function revalidateContainment(resolved: ResolvedPath): Promise<void> {
  await assertNoSymlink(resolved.root, resolved.relInRoot, resolved.relPath);
}

/**
 * Root-relative path prefix `write`/`edit` always refuse, on top of the
 * user-configurable `settings.write.protectedPaths`. `.git/` is hardcoded and
 * not user-removable: it is not git-tracked (so the "recoverable via source
 * control" reason for leaving write/edit ungated does not hold there) and a
 * write to `.git/hooks/*` runs on the next git command - code execution that
 * never passes the run tool's approval gate.
 */
const ALWAYS_PROTECTED = '.git';

/**
 * Whether a workspace-folder-relative path falls inside a protected location.
 * The match is segment by segment (so `.git` does not catch `.gitignore`) and
 * case-insensitive (so a case-insensitive filesystem cannot bypass it with
 * `.GIT`). `relInRoot` is the path already resolved relative to its workspace
 * folder, with the multi-root folder prefix stripped.
 */
function isProtectedWritePath(relInRoot: string): boolean {
  const segments = relInRoot
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return [ALWAYS_PROTECTED, ...settings.write.protectedPaths].some((prefix) => {
    const prefixSegments = prefix
      .split(/[\\/]/)
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    return (
      prefixSegments.length > 0 &&
      prefixSegments.every((segment, i) => segments[i] === segment)
    );
  });
}

/**
 * Backstop on the read tool's output, so a few enormous lines cannot flood the
 * context. Caps `lines` at `settings.read.maxChars`, cutting at a line boundary
 * so the result always ends on a whole line, and reports how many of the input
 * lines actually survived - the caller computes its range header from that, so
 * the header can never claim lines the char cap dropped (a single line longer
 * than the cap is the one exception: it is char-cut and still counted as one,
 * since dropping it would return nothing).
 */
function capReadLines(lines: string[]): {
  text: string;
  lineCount: number;
  truncated: boolean;
} {
  const max = settings.read.maxChars;
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    // +1 for the newline joining this line to the previous one.
    const addition = (i === 0 ? 0 : 1) + lines[i].length;
    if (used + addition > max) {
      if (i === 0) {
        return {
          text: lines[0].slice(0, max) + TRUNCATED_SUFFIX,
          lineCount: 1,
          truncated: true,
        };
      }
      return {
        text: lines.slice(0, i).join('\n') + TRUNCATED_SUFFIX,
        lineCount: i,
        truncated: true,
      };
    }
    used += addition;
  }
  return { text: lines.join('\n'), lineCount: lines.length, truncated: false };
}

/**
 * Read a file's text contents, whole or a 1-based inclusive line range.
 * Read-only: no approval needed.
 *
 * Every call returns at most `settings.read.maxLines` lines, so one read of a
 * large file cannot flood a small model's context window. A result that does
 * not cover the whole file is prefixed with the range shown and the file's
 * total line count, so the model knows where to continue; an impossible range
 * returns a recovery instruction instead of throwing.
 */
export async function readFile(
  relPath: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  const resolved = await resolveWorkspaceUri(relPath);
  // Stat before reading so an oversized file is refused by its size rather than
  // pulled whole into the extension host: the line/char caps below only bound
  // the result, but the whole file is loaded before they apply, so without this
  // a read of a multi-GB or giant minified file would exhaust memory. The
  // attachment reader and the content scan guard the same way.
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(resolved.uri);
  } catch (err) {
    // A missing file is a recoverable condition the model self-corrects from
    // (read elsewhere, or write to create it), not a hard failure: return a
    // clean recovery message rather than letting Node's raw error - which spells
    // out the absolute path, "ENOENT", and "stat" - surface as the tool result.
    if (isFileNotFound(err)) {
      return messages.readFailed.notFound(relPath);
    }
    throw err;
  }
  if (stat.size > settings.read.maxFileSizeBytes) {
    return messages.readFailed.tooLarge(relPath, stat.size, settings.read.maxFileSizeBytes);
  }
  const bytes = await vscode.workspace.fs.readFile(resolved.uri);
  // Re-check containment after the read: if a component was swapped for a
  // symlink between the resolve and the read, discard the bytes rather than
  // return data that may have come from outside the workspace.
  await revalidateContainment(resolved);
  const text = Buffer.from(bytes).toString('utf8');

  const start = startLine ?? 1;
  if (endLine !== undefined && endLine < start) {
    return messages.readFailed.emptyRange(start, endLine);
  }
  // Count lines like `wc -l` does: a trailing newline ends the last line, it
  // does not start another - so the count matches what a line-count command
  // run by the model reports.
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const total = lines.length;
  if (start > total) {
    return messages.readFailed.pastEnd(relPath, start, total);
  }
  const end = Math.min(endLine ?? Infinity, start + settings.read.maxLines - 1, total);
  // Apply the char cap before deciding the end line, so the header reports the
  // range actually returned rather than the range requested - when the char cap
  // drops the tail, `actualEnd` is the last line that survived it.
  const capped = capReadLines(lines.slice(start - 1, end));
  const actualEnd = start + capped.lineCount - 1;
  if (start === 1 && actualEnd === total && !capped.truncated) {
    // The whole file fits in one call: return it verbatim (trailing newline
    // included), with no range header to strip.
    return text;
  }
  return messages.read.range(start, actualEnd, total) + '\n' + capped.text;
}

/**
 * Search by glob (file names) or by content. Read-only: no approval needed.
 * Glob mode returns workspace-relative paths; content mode returns one
 * `path:line: <trimmed preview>` line per match, so the model learns where a
 * file matches and can follow up with a ranged `read` around that line instead
 * of reading the file from the start.
 */
export async function searchFiles(
  query: string,
  mode: 'glob' | 'content'
): Promise<string[]> {
  if (mode === 'glob') {
    const uris = await vscode.workspace.findFiles(
      query,
      settings.search.excludeGlob,
      settings.search.globMaxResults
    );
    return uris.map((u) => vscode.workspace.asRelativePath(u));
  }

  const { matches, truncated } = await searchContent(query);
  const lines = matches.map((m) => `${m.path}:${m.line}: ${m.preview}`);
  if (truncated) {
    // The scan stopped at the budget with files unexamined; tell the model so a
    // short (or empty) result on a large repo is not read as authoritative.
    lines.push(messages.search.contentTruncated(settings.search.contentScanLimit));
  }
  return lines;
}

/**
 * Kill a spawned command and everything it started. exec's own `timeout`
 * only signals the shell, leaving grandchild processes running, so the tree
 * is taken down explicitly: `taskkill /t` on Windows, and elsewhere a signal
 * to the negative pid - the whole process group, which the child leads
 * because `runCommand` spawns it `detached` off Windows. Signalling only the
 * child (the shell) would orphan whatever it started.
 */
function killProcessTree(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${child.pid} /t /f`);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group is already gone (or the child never detached under a test
      // fake); fall back to signalling the child itself.
      child.kill('SIGKILL');
    }
  }
}

/**
 * Backstop on the run tool's model-facing result. The exec buffer
 * (settings.runCommandMaxBufferBytes) bounds what is captured; this bounds
 * what is handed back to the model, so one chatty command cannot flood a
 * small model's context window. Head and tail are both kept - build and test
 * failures usually print the interesting part last.
 */
function capRunOutput(text: string): string {
  const max = settings.runResultMaxChars;
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) + '\n…(output truncated)…\n' + text.slice(text.length - half)
  );
}

/**
 * Run a shell command. SIDE-EFFECTING: gated by the Approver. The optional
 * mirror receives the command's lifecycle and live output (Phase 1 shows it
 * in a "Dev Team" terminal); the buffered result returned to the model is
 * unaffected by it.
 *
 * A command that *ran but failed* - a non-zero exit or a timeout - **rejects**
 * (with the reason and the command's output as the error message) rather than
 * returning, so the failure crosses the tool seam as a failed call: the executor
 * marks the transcript event failed and the run continues, instead of the model
 * receiving a plain result string it might read as success (a killed-by-timeout
 * run in particular). Outcomes that are not a command failure - a refusal
 * (Restricted Mode / virtual workspace), a decline at the approval gate, a
 * cancellation, and of course success - still return their string.
 *
 * `dangerous` is the model's own flag for a destructive or irreversible command
 * (see the run tool's input schema). When set - or when the command matches the
 * denylist (commandPolicy.ts), since the model's flag is decided from
 * possibly-untrusted content - the approval prompt is escalated: it carries a
 * warning title/preview and a distinct "Allow All" scope, so an allowance the
 * user granted for ordinary commands never silently approves a destructive one,
 * and the allowlist fast path never covers it. An ordinary command on the
 * user's allowlist runs with no prompt; an ordinary command not on it can be
 * added to the allowlist from the prompt's "always allow" choice.
 */
export async function runCommand(
  command: string,
  approver: Approver,
  mirror?: RunMirror,
  signal?: AbortSignal,
  dangerous?: boolean
): Promise<string> {
  // An untrusted folder (Restricted Mode) or a virtual workspace cannot run a
  // shell command; refuse before the approval prompt so the user is never
  // asked to confirm an action that cannot happen, and the model gets a reason
  // it can relay.
  if (!vscode.workspace.isTrusted) {
    return messages.restricted.run;
  }
  if (isVirtualWorkspace()) {
    return messages.virtual.run;
  }
  const folders = vscode.workspace.workspaceFolders;
  const cwd = workspaceRoot().fsPath;
  // A request cancelled before (or during) the approval prompt must not start
  // a process.
  if (signal?.aborted) {
    return messages.cancelled.run;
  }
  // In a multi-root workspace the command runs in the first folder; name it in
  // the prompt so the user knows which directory the command lands in.
  const cwdFolder = folders && folders.length > 1 ? folders[0].name : undefined;
  // The denylist (a built-in floor plus the user's additions) forces a command
  // to be treated as destructive regardless of the model's `dangerous` flag,
  // which is decided from possibly-untrusted content. So a destructive command
  // is escalated when the model flagged it *or* it is denylisted: a warning
  // title/preview, and a distinct "Allow All" scope an ordinary allowance never
  // covers - that asks again on its own. This closes the gap where an injected
  // "ordinary-looking" command could ride an existing ordinary grant.
  const effectiveDangerous = Boolean(dangerous) || isDeniedCommand(command);
  let ok: boolean;
  if (!effectiveDangerous && isAllowedCommand(command)) {
    // The allowlist fast path: an ordinary command the user marked safe runs
    // with no prompt (a denylisted command never reaches here).
    ok = true;
  } else {
    // Offer the persistent "always allow commands like this" choice only for an
    // ordinary command (never a destructive or denylisted one), and only when
    // there is a sensible prefix to suggest.
    const prefix = effectiveDangerous ? '' : suggestedAllowPrefix(command);
    const alwaysAllow = prefix
      ? {
          label: messages.approval.alwaysAllow(prefix),
          apply: () => addAllowedCommand(prefix),
        }
      : undefined;
    ok = await approver.confirm(
      effectiveDangerous
        ? messages.approval.runCommandDangerousTitle
        : messages.approval.runCommandTitle,
      messages.approval.runCommandDetail(command, cwdFolder, effectiveDangerous),
      effectiveDangerous ? RUN_DANGEROUS_SCOPE : RUN_SCOPE,
      undefined,
      alwaysAllow
    );
  }
  if (!ok) {
    // Declined commands never ran, so they never reach the mirror either.
    return messages.notApproved.run;
  }
  if (signal?.aborted) {
    return messages.cancelled.run;
  }

  let timedOut = false;
  let aborted = false;
  // The shell must match what the prompts announce (config/environment.ts):
  // PowerShell on Windows, the platform default (/bin/sh) elsewhere.
  // Off Windows the child leads its own process group, so killProcessTree can
  // take the whole group down (taskkill /t covers this on Windows). exec
  // forwards its options to spawn, which honours `detached` - the ExecOptions
  // type just does not declare it, hence the cast.
  const pending = execAsync(command, {
    cwd,
    shell: environment.execShell,
    maxBuffer: settings.runCommandMaxBufferBytes,
    windowsHide: true,
    detached: process.platform !== 'win32',
  } as ExecOptions & { detached: boolean });
  if (mirror) {
    mirror.begin(command);
    // Tap the child's streams for the live view; exec keeps buffering the
    // same data for the returned result, so this observes without changing
    // anything. (The promisified child is absent only under test fakes.)
    pending.child?.stdout?.on('data', (chunk) => mirror.output(String(chunk)));
    pending.child?.stderr?.on('data', (chunk) => mirror.output(String(chunk)));
  }
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProcessTree(pending.child);
  }, settings.runCommandTimeoutMs);
  // Cancelling the chat request kills the in-flight process tree instead of
  // letting it run to its timeout in the background.
  const onAbort = () => {
    aborted = true;
    killProcessTree(pending.child);
  };
  signal?.addEventListener('abort', onAbort);

  try {
    const { stdout, stderr } = await pending;
    mirror?.end(messages.terminal.completed);
    return capRunOutput(combineOutput(String(stdout), String(stderr)));
  } catch (err: any) {
    // A failed command's output is what the caller needs to diagnose it, so
    // include the stdout/stderr exec attaches to the error.
    const reason = aborted
      ? 'Command was cancelled and the process was killed.'
      : timedOut
      ? `Command timed out after ${settings.runCommandTimeoutMs} ms and was killed.`
      : `Command failed: ${err?.message ?? String(err)}`;
    mirror?.end(reason);
    const output = capRunOutput(
      combineOutput(String(err?.stdout ?? ''), String(err?.stderr ?? ''))
    );
    const message = output ? `${reason}\n${output}` : reason;
    // A cancellation is the user stopping the run, not a failure to fix, so it
    // stays an ordinary result (the run is being torn down anyway). A genuine
    // command failure - a non-zero exit or a timeout - is thrown so it surfaces
    // as a failed tool call rather than a result a model could mistake for
    // success.
    if (aborted) {
      return message;
    }
    throw new Error(message);
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function combineOutput(stdout: string, stderr: string): string {
  return (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
}

/**
 * Create or overwrite a file. Not gated by the Approver: the workspace is
 * git-backed, so a clobbered file is recoverable, and writing is the
 * executor's core job - prompting on every file would make a routine
 * multi-file change unusable. The safety that matters here is still enforced:
 * path traversal and symlink targets are rejected outright, and a cancelled
 * request never lands a file. See the "Approvals" section in docs/DESIGN.md for why
 * write/edit are intentionally ungated while `run` still asks.
 */
export async function writeFile(
  relPath: string,
  contents: string,
  signal?: AbortSignal,
  reporter?: ChangeReporter,
  approver?: Approver
): Promise<string> {
  // An untrusted folder (Restricted Mode) disables writing; refuse with a
  // reason the model can relay rather than touching disk.
  if (!vscode.workspace.isTrusted) {
    return messages.restricted.write;
  }
  // Resolve (and so validate) the path first: a traversal or symlink target
  // is rejected outright before anything touches disk.
  const resolved = await resolveWorkspaceUri(relPath);
  // A protected in-workspace location (.git/, .vscode/, ...) can run code on
  // its own, sidestepping the run tool's approval gate, so write refuses it
  // even though it is inside the workspace.
  if (isProtectedWritePath(resolved.relInRoot)) {
    return messages.protected.write(relPath);
  }
  // A cancelled request (the chat stop button) must not land a file on disk.
  if (signal?.aborted) {
    return messages.cancelled.write;
  }
  // Optional approval gate (myDevTeam.approval.fileChanges, off by default):
  // when on, every write asks first, like the run tool. Asked after the path
  // is validated and the protected/cancel checks pass, so the user is never
  // prompted for a write that would be refused anyway.
  if (settings.approval.fileChanges && approver) {
    const ok = await approver.confirm(
      messages.approval.writeFileTitle,
      messages.approval.fileChangeDetail(relPath),
      'write'
    );
    if (!ok) {
      return messages.notApproved.write;
    }
    // The prompt can sit open for a while; a cancel during it must still drop
    // the write.
    if (signal?.aborted) {
      return messages.cancelled.write;
    }
  }
  // Read the prior contents for the change summary before overwriting them; a
  // file that does not exist yet is a create, so its "before" is empty.
  const before = await readTextOrEmpty(resolved.uri);
  // Re-check containment immediately before writing, so a symlink swapped in
  // after the resolve cannot redirect the write outside the workspace.
  await revalidateContainment(resolved);
  await vscode.workspace.fs.writeFile(resolved.uri, Buffer.from(contents, 'utf8'));
  reporter?.report(relPath, before, contents);
  return `Wrote ${relPath} (${Buffer.byteLength(contents, 'utf8')} bytes).`;
}

/** A file's text, or '' when it does not exist - used to seed a write's "before". */
async function readTextOrEmpty(uri: vscode.Uri): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Adapt a model-emitted snippet's line endings to the file's. Models usually
 * emit LF while files on Windows are often CRLF, so an exact match that fails
 * only on line endings would be a spurious "not found"; the snippet is
 * converted instead of the file, so an edit never rewrites the file's own
 * line endings as a side effect.
 */
function matchLineEndings(fileText: string, snippet: string): string {
  const lf = snippet.replaceAll('\r\n', '\n');
  return fileText.includes('\r\n') ? lf.replaceAll('\n', '\r\n') : lf;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Locate the snippet to replace in the file text: an exact match first; on a
 * miss, a retry with the snippets' line endings adapted to the file's (the
 * replacement must be adapted alongside, or an LF snippet pasted into a CRLF
 * file would mix endings). Returns the adapted needle/replacement pair on a
 * unique match, or the recovery message the model should see.
 */
function locateEdit(
  text: string,
  relPath: string,
  oldText: string,
  newText: string
): { needle: string; replacement: string } | { failure: string } {
  let needle = oldText;
  let replacement = newText;
  if (!text.includes(needle)) {
    needle = matchLineEndings(text, oldText);
    replacement = matchLineEndings(text, newText);
  }
  const count = countOccurrences(text, needle);
  if (count === 0) {
    return { failure: messages.editFailed.notFound(relPath) };
  }
  if (count > 1) {
    return { failure: messages.editFailed.multipleMatches(count, relPath) };
  }
  return { needle, replacement };
}

/**
 * Replace text in an existing file. Not gated by the Approver (see
 * `writeFile`): the workspace is git-backed, so the change is recoverable. The
 * replaced text must match exactly one place in the file - zero or multiple
 * matches return a recovery instruction to the model instead of touching the
 * file, so a misremembered snippet can never corrupt it. Creating files stays
 * the write tool's job: a missing target is an error here, not an empty file
 * to fill. On the ungated default path the read, locate, and write happen
 * back-to-back with no pause, so no re-verification step is needed; when the
 * optional approval gate (`myDevTeam.approval.fileChanges`) is on the prompt can
 * sit open arbitrarily long, so the file is re-read and re-located after
 * approval - an edit a concurrent on-disk change invalidated during the prompt
 * is reported rather than clobbering it with the pre-prompt snapshot.
 */
export async function editFile(
  relPath: string,
  oldText: string,
  newText: string,
  signal?: AbortSignal,
  reporter?: ChangeReporter,
  approver?: Approver
): Promise<string> {
  // An untrusted folder (Restricted Mode) disables editing; refuse with a
  // reason the model can relay rather than touching disk.
  if (!vscode.workspace.isTrusted) {
    return messages.restricted.edit;
  }
  // Resolve (and so validate) the path first: a traversal or symlink target
  // is rejected outright before anything touches disk.
  const resolved = await resolveWorkspaceUri(relPath);
  // A protected in-workspace location (.git/, .vscode/, ...) can run code on
  // its own, sidestepping the run tool's approval gate, so edit refuses it even
  // though it is inside the workspace.
  if (isProtectedWritePath(resolved.relInRoot)) {
    return messages.protected.edit(relPath);
  }
  if (oldText === newText) {
    return messages.editFailed.identical;
  }
  // A cancelled request (the chat stop button) must not land an edit on disk.
  if (signal?.aborted) {
    return messages.cancelled.edit;
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(resolved.uri);
  } catch {
    return messages.editFailed.missingFile(relPath);
  }
  let text = Buffer.from(bytes).toString('utf8');
  let located = locateEdit(text, relPath, oldText, newText);
  if ('failure' in located) {
    return located.failure;
  }
  // Optional approval gate (myDevTeam.approval.fileChanges, off by default):
  // asked only once the edit is known to apply (the file exists and oldText
  // matched a single place), so the user is never prompted for an edit that
  // then fails to locate its target.
  if (settings.approval.fileChanges && approver) {
    const ok = await approver.confirm(
      messages.approval.editFileTitle,
      messages.approval.fileChangeDetail(relPath),
      'edit'
    );
    if (!ok) {
      return messages.notApproved.edit;
    }
    if (signal?.aborted) {
      return messages.cancelled.edit;
    }
    // The prompt can sit open arbitrarily long; the file may have changed on
    // disk meanwhile. Re-read and re-locate against the current contents so the
    // write reflects them rather than clobbering a concurrent edit with the
    // pre-prompt snapshot - and if the edit no longer applies (the file vanished,
    // or oldText is now absent or ambiguous) report that instead of writing
    // stale text. The ungated path above has no pause, so it keeps its one read.
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(resolved.uri)).toString('utf8');
    } catch {
      return messages.editFailed.missingFile(relPath);
    }
    const relocated = locateEdit(text, relPath, oldText, newText);
    if ('failure' in relocated) {
      return relocated.failure;
    }
    located = relocated;
  }
  // Re-check containment immediately before writing the edit back, so a symlink
  // swapped in after the resolve cannot redirect the write outside the
  // workspace. This only stats path components, so the snapshot the match was
  // computed against is still the one the write lands on.
  await revalidateContainment(resolved);
  // The replacement goes through a function so replace() cannot interpret
  // `$&`-style patterns inside model-written code as substitutions.
  const updated = text.replace(located.needle, () => located.replacement);
  await vscode.workspace.fs.writeFile(resolved.uri, Buffer.from(updated, 'utf8'));
  reporter?.report(relPath, text, updated);
  return `Edited ${relPath} (1 replacement).`;
}
