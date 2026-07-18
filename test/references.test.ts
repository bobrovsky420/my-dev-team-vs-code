import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectReferences,
  buildGitDiff,
  isMaxBufferError,
} from '../src/client/references';
import { messages } from '../src/config/messages';
import { settings } from '../src/config/settings';
import {
  __reset,
  __state,
  __setActiveEditor,
  __setConfig,
  __setFile,
  Uri,
  Location,
  Position,
  Range,
  workspace,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

/** A no-op git diff so #changes tests need no git repository. */
const noDiff = async () => '';

describe('collectReferences - explicit references', () => {
  it('inlines a whole file (Uri reference)', async () => {
    const uri = __setFile('src/a.ts', 'file body');
    const { attachments, prompt } = await collectReferences([{ value: uri } as any], 'look', noDiff);

    expect(prompt).toBe('look');
    expect(attachments).toEqual([{ label: 'File: src/a.ts', text: 'file body' }]);
  });

  it('replaces an oversized file with a notice, without reading it', async () => {
    const uri = __setFile('huge.bin', 'x'.repeat(settings.maxAttachmentReadBytes + 1));
    workspace.fs.readFile.mockClear();

    const { attachments } = await collectReferences([{ value: uri } as any], 'q', noDiff);

    expect(attachments[0].label).toBe('File: huge.bin');
    expect(attachments[0].text).toContain('attachment skipped');
    const readPaths = workspace.fs.readFile.mock.calls.map((c) => (c[0] as Uri).path);
    expect(readPaths).not.toContain(uri.path);
  });

  it('inlines a single-line selection (Location reference) with its line number', async () => {
    const uri = __setFile('src/b.ts', 'line0\nline1\nline2');
    const location = new Location(uri, new Range(new Position(1, 0), new Position(1, 5)));

    const { attachments } = await collectReferences([{ value: location } as any], 'explain', noDiff);

    expect(attachments[0].label).toBe('Selection from src/b.ts (line 2)');
    expect(attachments[0].text).toBe('line1');
  });

  it('labels a multi-line selection with its line range', async () => {
    const uri = __setFile('src/c.ts', 'l0\nl1\nl2\nl3\nl4');
    const location = new Location(uri, new Range(new Position(1, 0), new Position(3, 2)));

    const { attachments } = await collectReferences([{ value: location } as any], 'explain', noDiff);

    expect(attachments[0].label).toBe('Selection from src/c.ts (lines 2-4)');
  });

  it('reads a symbol reference that arrives location-shaped but is not a Location', async () => {
    const uri = __setFile('src/d.ts', 'a\nb\nfunction f() {}\nc');
    // A structural { uri, range } (how a symbol reference can be delivered),
    // not an instanceof Location: it must still be read, not dropped.
    const value = { uri, range: new Range(new Position(2, 0), new Position(2, 14)) };

    const { attachments } = await collectReferences([{ value } as any], 'explain', noDiff);

    expect(attachments[0].label).toBe('Selection from src/d.ts (line 3)');
    expect(attachments[0].text).toBe('function f() {}');
  });

  it('inlines a plain string reference', async () => {
    const { attachments } = await collectReferences([{ value: 'raw snippet' } as any], 'q', noDiff);
    expect(attachments[0]).toEqual({ label: 'Attached text', text: 'raw snippet' });
  });

  it('keeps a label-only notice for an unsupported reference kind', async () => {
    const { attachments } = await collectReferences(
      [{ value: 42 } as any, { value: { not: 'a location' } } as any],
      'q',
      noDiff
    );
    expect(attachments).toHaveLength(2);
    for (const attachment of attachments) {
      expect(attachment.label).toBe('Unsupported reference');
      expect(attachment.text).toContain('unsupported type');
    }
  });

  it('reports an unreadable attachment instead of throwing', async () => {
    const ghost = Uri.joinPath(__state.workspaceFolders![0].uri, 'ghost.ts');
    const { attachments } = await collectReferences([{ value: ghost } as any], 'q', noDiff);
    expect(attachments[0].label).toBe('Unreadable attachment');
    expect(attachments[0].text).toContain('could not read attachment');
  });

  it('truncates very large attachments', async () => {
    const huge = 'z'.repeat(settings.maxAttachmentChars + 100);
    const { attachments } = await collectReferences([{ value: huge } as any], 'q', noDiff);
    expect(attachments[0].text).toContain('. . . (truncated)');
  });
});

describe('collectReferences - active editor (implicit context)', () => {
  /** A fake active editor reading from in-memory text, like a real TextEditor. */
  function fakeEditor(uri: Uri, text: string, selection?: Range) {
    return {
      document: {
        uri,
        getText: (range?: Range) =>
          range
            ? text.split('\n').slice(range.start.line, range.end.line + 1).join('\n')
            : text,
      },
      // Default to an empty selection (caret only): start === end.
      selection: selection ?? new Range(new Position(0, 0), new Position(0, 0)),
    };
  }

  it('attaches the whole open file when nothing is selected', async () => {
    const uri = __setFile('src/open.ts', 'line0\nline1\nline2');
    __setActiveEditor(fakeEditor(uri, 'line0\nline1\nline2'));

    const { attachments } = await collectReferences([], 'analyse the current file', noDiff);

    expect(attachments).toEqual([
      { label: 'Active file: src/open.ts', text: 'line0\nline1\nline2' },
    ]);
  });

  it('attaches only the selection when text is selected', async () => {
    const uri = __setFile('src/open.ts', 'l0\nl1\nl2\nl3');
    __setActiveEditor(
      fakeEditor(uri, 'l0\nl1\nl2\nl3', new Range(new Position(1, 0), new Position(2, 2)))
    );

    const { attachments } = await collectReferences([], 'explain this', noDiff);

    expect(attachments).toHaveLength(1);
    expect(attachments[0].label).toBe('Active selection in src/open.ts (lines 2-3)');
    expect(attachments[0].text).toBe('l1\nl2');
  });

  it('does not attach when the setting is off', async () => {
    __setConfig('myDevTeam.attachActiveEditor', false);
    const uri = __setFile('src/open.ts', 'body');
    __setActiveEditor(fakeEditor(uri, 'body'));

    const { attachments } = await collectReferences([], 'hello', noDiff);

    expect(attachments).toEqual([]);
  });

  it('does not duplicate a file already attached explicitly', async () => {
    const uri = __setFile('src/open.ts', 'file body');
    __setActiveEditor(fakeEditor(uri, 'file body'));

    // The same file arrives as an explicit Uri reference (e.g. the user attached
    // it, or VS Code sent its implicit current-file reference).
    const { attachments } = await collectReferences([{ value: uri } as any], 'q', noDiff);

    expect(attachments).toEqual([{ label: 'File: src/open.ts', text: 'file body' }]);
  });

  it('attaches the active file alongside an explicit reference to a different file', async () => {
    const attached = __setFile('src/other.ts', 'other body');
    const openUri = __setFile('src/open.ts', 'open body');
    __setActiveEditor(fakeEditor(openUri, 'open body'));

    const { attachments } = await collectReferences([{ value: attached } as any], 'q', noDiff);

    // Explicit reference leads; the active file trails as implicit context.
    expect(attachments).toEqual([
      { label: 'File: src/other.ts', text: 'other body' },
      { label: 'Active file: src/open.ts', text: 'open body' },
    ]);
  });
});

describe('collectReferences - #changes', () => {
  it('attaches the git diff and strips the marker from the prompt', async () => {
    const gitDiff = async () => '# Unstaged changes\ndiff --git a/x b/x';
    const { attachments, prompt } = await collectReferences([], 'review #changes please', gitDiff);

    expect(prompt).toBe('review please');
    expect(attachments[0].label).toBe('Uncommitted git changes');
    expect(attachments[0].text).toContain('diff --git');
  });

  it('attaches a notice when there are no changes', async () => {
    const { attachments, prompt } = await collectReferences([], '#changes', async () => '   ');
    expect(prompt).toBe('');
    expect(attachments[0].text).toContain('no uncommitted git changes');
  });

  it('truncates an enormous diff to the cap', async () => {
    const gitDiff = async () => 'd'.repeat(settings.references.changesMaxChars + 100);
    const { attachments } = await collectReferences([], '#changes', gitDiff);
    expect(attachments[0].text).toContain('. . . (truncated)');
  });

  it('attaches a notice when there is no workspace folder', async () => {
    __state.workspaceFolders = undefined;
    const { attachments } = await collectReferences([], '#changes', async () => 'should be ignored');
    expect(attachments[0].text).toContain('not available');
  });
});

describe('isMaxBufferError', () => {
  it('recognises the stdout overflow by code or message', () => {
    expect(isMaxBufferError({ code: 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' })).toBe(true);
    expect(isMaxBufferError(new Error('stdout maxBuffer length exceeded'))).toBe(true);
  });

  it('does not flag an ordinary git failure', () => {
    expect(isMaxBufferError(new Error('not a git repository'))).toBe(false);
    expect(isMaxBufferError(undefined)).toBe(false);
  });
});

describe('buildGitDiff (B-2: large diff is not misreported as empty)', () => {
  it('combines staged and unstaged diffs', async () => {
    const run = async (args: string[]) => ({
      out: args.includes('--staged') ? 'S' : 'U',
      overflow: false,
    });
    const text = await buildGitDiff(run);
    expect(text).toBe('# Staged changes\nS\n\n# Unstaged changes\nU');
  });

  it('falls back to a --stat summary with a notice when the diff overflows', async () => {
    // The full `diff`/`diff --staged` overflow; the `--stat` variants are small.
    const run = async (args: string[]) => {
      if (args.includes('--stat')) {
        return { out: args.includes('--staged') ? ' a | 2 +-' : ' b | 9 +++', overflow: false };
      }
      return { out: '', overflow: true };
    };
    const text = await buildGitDiff(run);
    expect(text).toContain(messages.references.changesTooLarge);
    expect(text).toContain('# Unstaged changes (summary)');
    expect(text).toContain('b | 9 +++');
    // Crucially, it is not the empty string the bug produced.
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('reports a genuinely clean tree (and non-overflow failures) as empty', async () => {
    const run = async () => ({ out: '', overflow: false });
    expect(await buildGitDiff(run)).toBe('');
  });
});

describe('collectReferences - #codebase', () => {
  it('lists matching files with a head snippet and strips the marker', async () => {
    const uri = __setFile('src/widget.ts', 'export class Widget {\n  render() {}\n}');
    __state.findFilesResult = [uri];

    const { attachments, prompt } = await collectReferences(
      [],
      'where is the Widget class defined #codebase',
      noDiff
    );

    expect(prompt).toBe('where is the Widget class defined');
    const attachment = attachments[0];
    expect(attachment.label).toContain('Codebase search:');
    expect(attachment.label).toContain('Widget');
    expect(attachment.text).toContain('- src/widget.ts');
    expect(attachment.text).toContain('--- src/widget.ts ---');
    expect(attachment.text).toContain('export class Widget');
  });

  it('notes when no distinctive search terms could be derived', async () => {
    const { attachments } = await collectReferences([], '#codebase', noDiff);
    expect(attachments[0].text).toContain('no distinctive search terms');
  });

  it('notes when the search terms match no files', async () => {
    __setFile('src/other.ts', 'nothing relevant here');
    __state.findFilesResult = [];

    const { attachments } = await collectReferences([], 'find the Sprocket #codebase', noDiff);
    expect(attachments[0].text).toContain('no files in the workspace matched');
  });

  it('caps the number of files it lists', async () => {
    const uris = Array.from({ length: settings.references.codebaseMaxFiles + 3 }, (_, i) =>
      __setFile(`src/widget${i}.ts`, 'class Widget {}')
    );
    __state.findFilesResult = uris;

    const { attachments } = await collectReferences([], 'the Widget #codebase', noDiff);
    const listed = attachments[0].text.split('\n').filter((l) => l.startsWith('- '));
    expect(listed.length).toBe(settings.references.codebaseMaxFiles);
  });
});

describe('collectReferences - combined and pass-through', () => {
  it('resolves #codebase and #changes together and strips both markers', async () => {
    const uri = __setFile('src/widget.ts', 'class Widget {}');
    __state.findFilesResult = [uri];
    const gitDiff = async () => 'a diff';

    const { attachments, prompt } = await collectReferences(
      [],
      'look at the Widget #codebase and #changes here',
      gitDiff
    );

    expect(prompt).toBe('look at the Widget and here');
    const labels = attachments.map((a) => a.label);
    expect(labels).toContain('Uncommitted git changes');
    expect(labels.some((l) => l.startsWith('Codebase search:'))).toBe(true);
  });

  it('leaves the prompt untouched and adds no attachments without references', async () => {
    const { attachments, prompt } = await collectReferences([], 'plain prompt', noDiff);
    expect(prompt).toBe('plain prompt');
    expect(attachments).toEqual([]);
  });

  it('does not treat a bare hash word as a marker', async () => {
    // "#codebases" is not "#codebase" (word boundary), so nothing is resolved.
    const { attachments, prompt } = await collectReferences([], 'about #codebases', noDiff);
    expect(prompt).toBe('about #codebases');
    expect(attachments).toEqual([]);
  });
});
