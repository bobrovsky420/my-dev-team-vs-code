/**
 * Resolves the references a chat request carries into run-request attachments.
 * This is client work by design: the engine is stateless and has no workspace
 * access (tools are inverted), so the client turns every reference into a
 * labelled `{ label, text }` attachment - the one seam the engine sees - and
 * ships them on the RunRequest. The engine decides per step how much of each
 * attachment its model sees (triage gets labels only; the planner/answerer/
 * executor get the full text).
 *
 * Two kinds of reference are resolved here:
 *
 * - **Explicit references** (`request.references`): VS Code delivers files,
 *   selections, and symbols here, not in the prompt. Each `value` is a Uri
 *   (whole file), a Location (file + range, e.g. a selection or a symbol's
 *   definition), or a plain string. A value that is location-shaped but not a
 *   `Location` instance (a symbol reference can arrive structurally) is still
 *   read; an unrecognised value becomes a short label-only notice so the
 *   models at least know the user pointed at something.
 * - **Prompt references** (`#codebase`, `#changes`): typed inline in the
 *   prompt. The client resolves each into context - a quick workspace search
 *   for `#codebase`, the uncommitted git diff for `#changes` - removes the
 *   marker from the prompt, and attaches the result. Both are read-only and
 *   need no approval.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Attachment } from '../protocol/types';
import { settings } from '../config/settings';
import { messages, truncateForDisplay } from '../config/messages';
import { readFile, searchContent } from '../tools/workspaceTools';

const execFileAsync = promisify(execFile);

/** A value that carries a file Uri and a range, whether or not it is a `Location` instance. */
function isLocationLike(v: unknown): v is { uri: vscode.Uri; range: vscode.Range } {
  if (!v || typeof v !== 'object') {
    return false;
  }
  const candidate = v as { uri?: unknown; range?: { start?: { line?: unknown }; end?: { line?: unknown } } };
  return (
    candidate.uri instanceof vscode.Uri &&
    typeof candidate.range?.start?.line === 'number' &&
    typeof candidate.range?.end?.line === 'number'
  );
}

/** Resolve a whole-file (Uri) reference, guarding against an oversized file. */
async function readWholeFile(uri: vscode.Uri): Promise<Attachment> {
  const rel = vscode.workspace.asRelativePath(uri);
  // Check the size via stat before reading: only maxAttachmentChars of the
  // text survive into the prompt anyway, so an enormous file is answered with
  // a notice instead of being pulled fully into memory.
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > settings.maxAttachmentReadBytes) {
    return { label: `File: ${rel}`, text: messages.attachments.tooLarge(stat.size) };
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    label: `File: ${rel}`,
    text: truncateForDisplay(Buffer.from(bytes).toString('utf8'), settings.maxAttachmentChars),
  };
}

/** Resolve a location reference (a selection or a symbol's definition range). */
async function readLocation(uri: vscode.Uri, range: vscode.Range): Promise<Attachment> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const rel = vscode.workspace.asRelativePath(uri);
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  const where = endLine > startLine ? `(lines ${startLine}-${endLine})` : `(line ${startLine})`;
  return {
    label: `Selection from ${rel} ${where}`,
    text: truncateForDisplay(doc.getText(range), settings.maxAttachmentChars),
  };
}

/**
 * The Uris an explicit reference set already covers, used to de-dupe the active
 * editor: when the user attached the open file (or VS Code sent its implicit
 * current-file reference), the auto-attach below must not add it a second time.
 */
function referencedUris(references: readonly vscode.ChatPromptReference[]): Set<string> {
  const uris = new Set<string>();
  for (const ref of references) {
    const v = ref.value;
    if (v instanceof vscode.Uri) {
      uris.add(v.toString());
    } else if (v instanceof vscode.Location) {
      uris.add(v.uri.toString());
    } else if (isLocationLike(v)) {
      uris.add(v.uri.toString());
    }
  }
  return uris;
}

/**
 * Resolve the active editor into an attachment - the whole open file, or just
 * the selection when text is selected - so "the current file"/"this selection"
 * has a concrete referent without the user attaching anything, the way Copilot
 * always includes the open editor. The deixis is resolved here, on the client,
 * rather than left to the model (a small local model just hallucinates a literal
 * path like `current_file_path`). Returns the attachment plus the editor's Uri
 * (for de-duping against explicit references), or undefined when the setting is
 * off or no editor is active.
 *
 * The text comes from the in-memory document (so unsaved edits are included,
 * matching what the user sees) and is capped like any other attachment. The
 * document is already open, so there is no disk read or size guard to apply -
 * the char cap bounds what reaches the prompt.
 */
function resolveActiveEditor(): { attachment: Attachment; uri: vscode.Uri } | undefined {
  if (!settings.attachActiveEditorEnabled) {
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const doc = editor.document;
  const uri = doc.uri;
  const rel = vscode.workspace.asRelativePath(uri);
  const sel = editor.selection;
  // Compute emptiness from the positions rather than `selection.isEmpty`, so
  // this works against the in-memory test fake (whose Range carries no methods)
  // as well as a real vscode.Selection.
  const hasSelection =
    !!sel &&
    (sel.start.line !== sel.end.line || sel.start.character !== sel.end.character);
  if (hasSelection) {
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const where = endLine > startLine ? `(lines ${startLine}-${endLine})` : `(line ${startLine})`;
    return {
      uri,
      attachment: {
        label: `Active selection in ${rel} ${where}`,
        text: truncateForDisplay(doc.getText(sel), settings.maxAttachmentChars),
      },
    };
  }
  return {
    uri,
    attachment: {
      label: `Active file: ${rel}`,
      text: truncateForDisplay(doc.getText(), settings.maxAttachmentChars),
    },
  };
}

/** Turn one explicit reference into an attachment; never throws. */
async function resolveReference(ref: vscode.ChatPromptReference): Promise<Attachment> {
  const v = ref.value;
  try {
    if (v instanceof vscode.Uri) {
      return await readWholeFile(v);
    }
    if (v instanceof vscode.Location) {
      return await readLocation(v.uri, v.range);
    }
    // A symbol (or other location-shaped value) that did not arrive as a
    // `Location` instance: read its range rather than drop it silently.
    if (isLocationLike(v)) {
      return await readLocation(v.uri, v.range);
    }
    if (typeof v === 'string') {
      return { label: 'Attached text', text: truncateForDisplay(v, settings.maxAttachmentChars) };
    }
    // An unrecognised reference kind (e.g. binary/image data): keep a label so
    // the models know the user attached something we could not inline.
    return { label: 'Unsupported reference', text: messages.references.unsupported };
  } catch (err) {
    return {
      label: 'Unreadable attachment',
      text: `(could not read attachment: ${String(err)})`,
    };
  }
}

/** Words too common to make useful workspace search terms. */
const STOPWORDS = new Set([
  'about', 'add', 'also', 'and', 'are', 'changes', 'code', 'codebase', 'does',
  'file', 'files', 'find', 'fix', 'from', 'function', 'have', 'help', 'here',
  'how', 'into', 'method', 'please', 'show', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'this', 'used', 'using', 'what', 'when', 'where',
  'which', 'why', 'will', 'with', 'your',
]);

/**
 * Derive a few distinctive search terms from the prompt for `#codebase`.
 * Original casing is preserved so a term matches mixed-case identifiers
 * (`searchContent` is a case-sensitive substring scan); short and
 * common words are dropped, and the longest terms are tried first.
 */
function deriveTerms(prompt: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of prompt.split(/[^A-Za-z0-9_]+/)) {
    const lower = raw.toLowerCase();
    if (raw.length < 4 || STOPWORDS.has(lower) || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    terms.push(raw);
  }
  terms.sort((a, b) => b.length - a.length);
  return terms.slice(0, settings.references.codebaseMaxTerms);
}

/**
 * Resolve `#codebase`: derive search terms from the (marker-stripped) prompt,
 * grep the workspace for each, and attach the matching file list plus a head
 * snippet of the first few - a quick relevance pass so the agents start with
 * the repository's relevant code instead of discovering it from scratch.
 */
async function resolveCodebase(prompt: string): Promise<Attachment> {
  const terms = deriveTerms(prompt);
  const joined = terms.join(', ');
  const label = messages.references.codebaseLabel(joined || 'your message');
  if (terms.length === 0) {
    return { label, text: messages.references.codebaseNoTerms };
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    let hits: { path: string }[] = [];
    try {
      // #codebase only wants the distinct matching files, not the truncation
      // flag (the attachment is a best-effort relevance pass, and removing the
      // candidate-set cap in searchContent already makes a low-match term scan
      // to completion), so take the matches and fold them down by path.
      hits = (await searchContent(term)).matches;
    } catch {
      // A failed search yields no hits for this term; the others still run.
    }
    for (const hit of hits) {
      if (!seen.has(hit.path)) {
        seen.add(hit.path);
        files.push(hit.path);
      }
      if (files.length >= settings.references.codebaseMaxFiles) {
        break;
      }
    }
    if (files.length >= settings.references.codebaseMaxFiles) {
      break;
    }
  }
  if (files.length === 0) {
    return { label, text: messages.references.codebaseNoMatches(joined) };
  }
  let text = messages.references.codebaseHeader(joined) + files.map((f) => `- ${f}`).join('\n');
  for (const file of files.slice(0, settings.references.codebaseSnippetFiles)) {
    let head = '';
    try {
      head = await readFile(file, 1, settings.references.codebaseSnippetLines);
    } catch {
      // Skip a file that cannot be read; the path is still listed above.
    }
    if (head.trim()) {
      text += `\n\n--- ${file} ---\n${head}`;
    }
  }
  return { label, text: truncateForDisplay(text, settings.references.codebaseMaxChars) };
}

/** True when an execFile rejection was the stdout maxBuffer overflow. */
export function isMaxBufferError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    !!e &&
    (e.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' ||
      /maxBuffer/i.test(String(e.message ?? '')))
  );
}

/** One git invocation's outcome: its stdout, and whether it overflowed the buffer. */
interface GitRun {
  out: string;
  overflow: boolean;
}

/**
 * Build the `#changes` text from a git runner. When either full diff overflowed
 * the read buffer, it falls back to a compact `--stat` summary (per-file line
 * counts, far smaller than the diff) prefixed with a notice, rather than
 * returning empty - a big working tree must never be misreported as "no changes"
 * (the overflow used to be swallowed into `''`, so `#changes` told the agent
 * there was nothing to review; see FIX.md, finding B-2). The runner reports a
 * non-overflow failure (no git, not a repo) as empty, which stays "no changes".
 * Exported for tests, which inject a fake runner instead of a git repo.
 */
export async function buildGitDiff(
  run: (args: string[]) => Promise<GitRun>
): Promise<string> {
  const staged = await run(['diff', '--staged']);
  const unstaged = await run(['diff']);

  if (staged.overflow || unstaged.overflow) {
    const stagedStat = (await run(['diff', '--staged', '--stat'])).out.trim();
    const unstagedStat = (await run(['diff', '--stat'])).out.trim();
    const parts: string[] = [messages.references.changesTooLarge];
    if (stagedStat) {
      parts.push('# Staged changes (summary)\n' + stagedStat);
    }
    if (unstagedStat) {
      parts.push('# Unstaged changes (summary)\n' + unstagedStat);
    }
    return parts.join('\n\n');
  }

  const parts: string[] = [];
  if (staged.out.trim()) {
    parts.push('# Staged changes\n' + staged.out.trim());
  }
  if (unstaged.out.trim()) {
    parts.push('# Unstaged changes\n' + unstaged.out.trim());
  }
  return parts.join('\n\n');
}

/** The default `#changes` resolver: the workspace's staged + unstaged git diff. */
async function defaultGitDiff(cwd: string): Promise<string> {
  return buildGitDiff(async (args) => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        maxBuffer: settings.runCommandMaxBufferBytes,
        windowsHide: true,
      });
      return { out: String(stdout), overflow: false };
    } catch (err) {
      // No git, not a repo, or the command failed: treat as no changes - except
      // a buffer overflow, which means there *are* changes, just too many to read.
      return { out: '', overflow: isMaxBufferError(err) };
    }
  });
}

/** Resolve `#changes`: the uncommitted git diff, or a notice when there is none. */
async function resolveChanges(gitDiff: (cwd: string) => Promise<string>): Promise<Attachment> {
  const label = messages.references.changesLabel;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return { label, text: messages.references.changesEmpty };
  }
  let diff = '';
  try {
    diff = await gitDiff(root.fsPath);
  } catch {
    diff = '';
  }
  if (!diff.trim()) {
    return { label, text: messages.references.changesEmpty };
  }
  return { label, text: truncateForDisplay(diff, settings.references.changesMaxChars) };
}

const CODEBASE_MARKER = /#codebase\b/i;
const CHANGES_MARKER = /#changes\b/i;

/**
 * Resolve every reference a chat request carries into attachments and return
 * the prompt with any inline markers removed. The `gitDiff` parameter is the
 * `#changes` resolver; it defaults to the real git diff and is injected in
 * tests so they need no git repository.
 */
export async function collectReferences(
  references: readonly vscode.ChatPromptReference[],
  prompt: string,
  gitDiff: (cwd: string) => Promise<string> = defaultGitDiff
): Promise<{ attachments: Attachment[]; prompt: string }> {
  const attachments: Attachment[] = [];
  for (const ref of references) {
    attachments.push(await resolveReference(ref));
  }

  const wantsChanges = CHANGES_MARKER.test(prompt);
  const wantsCodebase = CODEBASE_MARKER.test(prompt);
  // Strip the markers (and collapse the gap they leave) so the agents see the
  // user's request, not a stray "#codebase". The terms for #codebase come from
  // the cleaned prompt - the rest of the message minus the markers.
  const cleaned =
    wantsChanges || wantsCodebase
      ? prompt
          .replace(/#codebase\b/gi, '')
          .replace(/#changes\b/gi, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim()
      : prompt;

  if (wantsChanges) {
    attachments.push(await resolveChanges(gitDiff));
  }
  if (wantsCodebase) {
    attachments.push(await resolveCodebase(cleaned));
  }

  // Always include the active editor as implicit context (Copilot-style), so a
  // bare "analyse the current file" works even when the user attached nothing.
  // Skipped when that same file is already attached - explicitly, or via VS
  // Code's own implicit current-file reference - so it never doubles. Added last
  // so the user's explicit references and inline markers lead the prompt.
  const active = resolveActiveEditor();
  if (active && !referencedUris(references).has(active.uri.toString())) {
    attachments.push(active.attachment);
  }

  return { attachments, prompt: cleaned };
}
