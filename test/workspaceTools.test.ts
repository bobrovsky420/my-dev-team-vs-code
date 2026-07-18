import { describe, it, expect, beforeEach, vi } from 'vitest';

// child_process.exec is invoked through util.promisify inside runCommand.
// We replace it with a controllable fake before importing the module under
// test. The fake carries promisify's custom symbol so the promisified call
// exposes a `.child` with live stdout/stderr emitters, like the real exec -
// that is the surface the run mirror taps. `childRef.current` is the child
// of the most recent call, for tests that emit stream data.
const { execMock, childRef } = vi.hoisted(() => ({
  execMock: vi.fn(),
  childRef: { current: undefined as any },
}));
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const exec = (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb);
  (exec as any)[Symbol.for('nodejs.util.promisify.custom')] = (
    cmd: string,
    opts: unknown
  ) => {
    const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    childRef.current = child;
    let settle!: (err: unknown, value?: unknown) => void;
    const promise = new Promise((resolve, reject) => {
      settle = (err, value) => (err ? reject(err) : resolve(value));
    }) as Promise<unknown> & { child: unknown };
    promise.child = child;
    execMock(cmd, opts, settle);
    return promise;
  };
  return { exec };
});

import {
  readFile,
  searchFiles,
  runCommand,
  writeFile,
  editFile,
} from '../src/tools/workspaceTools';
import { Approver, RunMirror } from '../src/tools/types';
import { settings } from '../src/config/settings';
import { environment } from '../src/config/environment';
import {
  __reset,
  __state,
  __setConfig,
  __setFile,
  __setFileIn,
  __setSymlink,
  __setSymlinkDir,
  __setTrusted,
  __setWorkspaceFolders,
  Uri,
  workspace,
} from './mocks/vscode';

/** Approver test double recording calls and returning a fixed verdict. */
function makeApprover(verdict: boolean): Approver & {
  calls: Array<{
    title: string;
    detail: string;
    scope: string;
    alwaysAllowLabel?: string;
  }>;
} {
  const calls: Array<{
    title: string;
    detail: string;
    scope: string;
    alwaysAllowLabel?: string;
  }> = [];
  return {
    calls,
    async confirm(title, detail, scope, _correlationId, alwaysAllow) {
      calls.push({ title, detail, scope, alwaysAllowLabel: alwaysAllow?.label });
      return verdict;
    },
  };
}

beforeEach(() => {
  __reset();
  execMock.mockReset();
});

describe('readFile', () => {
  it('returns the utf8 contents of an existing file', async () => {
    __setFile('src/a.ts', 'hello world');
    await expect(readFile('src/a.ts')).resolves.toBe('hello world');
  });

  it('returns a clean recovery message when the file does not exist', async () => {
    const out = await readFile('missing.ts');
    expect(out).toMatch(/no such file or directory/i);
    // It names the path the model gave so the loop can self-correct...
    expect(out).toContain('missing.ts');
    // ...but never leaks the raw fs error (ENOENT, the "stat" verb, or an
    // absolute path), even though the renderer shows this result verbatim.
    expect(out).not.toMatch(/ENOENT|stat/);
  });

  it('throws when no workspace folder is open', async () => {
    __state.workspaceFolders = undefined;
    await expect(readFile('a.ts')).rejects.toThrow('No workspace folder is open.');
  });

  it('rejects a path that traverses out of the workspace', async () => {
    await expect(readFile('../secret.txt')).rejects.toThrow(/outside the workspace/);
    await expect(readFile('src/../../secret.txt')).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('rejects an absolute path', async () => {
    await expect(readFile('/etc/passwd')).rejects.toThrow(/outside the workspace/);
  });

  it('allows .. segments that stay inside the workspace', async () => {
    __setFile('a.ts', 'still inside');
    await expect(readFile('src/../a.ts')).resolves.toBe('still inside');
  });

  it('rejects a path that resolves to a symbolic link', async () => {
    // A link living inside the workspace can still point outside it; following
    // it would let read exfiltrate the target.
    __setSymlink('link.ts', 'contents of the link target');
    await expect(readFile('link.ts')).rejects.toThrow(/symbolic link/);
  });

  it('rejects a path inside a symlinked directory', async () => {
    // A symlinked *directory* inside the workspace escapes it just like a
    // symlinked file: the final component stats as a plain file, so every
    // ancestor must be checked too.
    __setSymlinkDir('linkdir');
    __setFile('linkdir/secret.txt', 'outside contents');
    await expect(readFile('linkdir/secret.txt')).rejects.toThrow(/symbolic link/);
  });

  it('rejects a deeper path whose middle component is a symlinked directory', async () => {
    __setSymlinkDir('src/linkdir');
    __setFile('src/linkdir/deep/secret.txt', 'outside contents');
    await expect(readFile('src/linkdir/deep/secret.txt')).rejects.toThrow(
      /symbolic link/
    );
  });

  it('truncates contents beyond the character backstop', async () => {
    // One enormous line: the line cap cannot bound it, the char cap must.
    __setFile('big.ts', 'a'.repeat(settings.read.maxChars + 10));
    const text = await readFile('big.ts');
    expect(text).toContain('. . . (truncated)');
    expect(text.length).toBeLessThan(settings.read.maxChars + 100);
  });

  it('returns a whole small file verbatim, trailing newline included', async () => {
    __setFile('a.ts', 'one\ntwo\n');
    await expect(readFile('a.ts')).resolves.toBe('one\ntwo\n');
  });

  it('refuses an oversized file by its stat, without reading it (B-1)', async () => {
    // A read of a multi-GB or giant minified file would otherwise pull the whole
    // thing into the extension host before the line/char caps apply. The size is
    // checked by stat first, so the file is never read into memory.
    const uri = __setFile('huge.min.js', 'x'.repeat(settings.read.maxFileSizeBytes + 1));
    workspace.fs.readFile.mockClear();

    const out = await readFile('huge.min.js');

    expect(out).toMatch(/over the .* read limit/);
    expect(out).toContain('search tool');
    const readPaths = workspace.fs.readFile.mock.calls.map((c) => (c[0] as Uri).path);
    expect(readPaths).not.toContain(uri.path);
  });
});

describe('readFile (line ranges)', () => {
  /** A file of `count` numbered lines: "line 1" .. "line N", newline-terminated. */
  function numberedLines(count: number): string {
    return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  }

  it('returns a requested range with a header naming range, total, and next line', async () => {
    __setFile('f.ts', numberedLines(10));
    await expect(readFile('f.ts', 3, 5)).resolves.toBe(
      '(lines 3-5 of 10; continue with startLine 6)\nline 3\nline 4\nline 5'
    );
  });

  it('omits the continue hint when the range reaches the end of the file', async () => {
    __setFile('f.ts', numberedLines(10));
    await expect(readFile('f.ts', 9, 99)).resolves.toBe(
      '(lines 9-10 of 10)\nline 9\nline 10'
    );
  });

  it('starts from line 1 when only endLine is given', async () => {
    __setFile('f.ts', numberedLines(5));
    await expect(readFile('f.ts', undefined, 2)).resolves.toBe(
      '(lines 1-2 of 5; continue with startLine 3)\nline 1\nline 2'
    );
  });

  it('caps an unbounded read at the per-call line limit', async () => {
    const cap = settings.read.maxLines;
    __setFile('f.ts', numberedLines(cap + 50));
    const text = await readFile('f.ts');
    expect(text).toContain(
      `(lines 1-${cap} of ${cap + 50}; continue with startLine ${cap + 1})`
    );
    expect(text).toContain(`line ${cap}`);
    expect(text).not.toContain(`line ${cap + 1}\n`);
  });

  it('caps an explicit range wider than the per-call line limit', async () => {
    const cap = settings.read.maxLines;
    __setFile('f.ts', numberedLines(cap + 50));
    const text = await readFile('f.ts', 2, cap + 20);
    expect(text).toContain(
      `(lines 2-${cap + 1} of ${cap + 50}; continue with startLine ${cap + 2})`
    );
  });

  it('reports the lines actually returned when the char cap bites mid-range (B-7)', async () => {
    // Lines long enough that the char backstop (read.maxChars) is hit well
    // before the line cap. The range header must report the lines actually
    // returned, not the full range requested - otherwise the model believes it
    // has lines the char cap dropped and may edit against stale context.
    const line = 'x'.repeat(2000);
    const count = settings.read.maxLines;
    __setFile('big.ts', Array.from({ length: count }, () => line).join('\n') + '\n');
    const text = await readFile('big.ts');

    expect(text).toContain('. . . (truncated)');
    const header = text.split('\n')[0];
    const match = header.match(/^\(lines 1-(\d+) of /);
    expect(match).not.toBeNull();
    const reportedEnd = Number(match![1]);
    // It was the char cap, not the line cap, that bit.
    expect(reportedEnd).toBeLessThan(count);
    // The body (header line removed, truncation marker removed) holds exactly
    // the number of lines the header claims - header and content agree.
    const body = text.slice(header.length + 1).replace(/\n\. \. \. \(truncated\)$/, '');
    expect(body.split('\n').length).toBe(reportedEnd);
  });

  it('does not count a trailing newline as a line of its own', async () => {
    // wc -l style: the count must match what a line-count command reports, or
    // the model's pre-counted ranges would be off by one.
    __setFile('f.ts', 'a\nb\n');
    await expect(readFile('f.ts', 1, 1)).resolves.toBe(
      '(lines 1-1 of 2; continue with startLine 2)\na'
    );
  });

  it('reports a startLine past the end instead of returning nothing', async () => {
    __setFile('f.ts', numberedLines(3));
    await expect(readFile('f.ts', 7)).resolves.toBe(
      'f.ts has only 3 lines; startLine 7 is past the end of the file.'
    );
  });

  it('reports an endLine before startLine with a recovery instruction', async () => {
    __setFile('f.ts', numberedLines(10));
    const out = await readFile('f.ts', 5, 2);
    expect(out).toContain('endLine 2 is before startLine 5');
    expect(out).toMatch(/at or after startLine/);
  });

  it('returns a range covering the whole file without a header', async () => {
    __setFile('f.ts', 'one\ntwo\n');
    await expect(readFile('f.ts', 1, 2)).resolves.toBe('one\ntwo\n');
  });

  it('reads the per-call line limit live from the user settings', async () => {
    __setConfig('myDevTeam.read.maxLines', 2);
    __setFile('f.ts', numberedLines(5));
    await expect(readFile('f.ts')).resolves.toBe(
      '(lines 1-2 of 5; continue with startLine 3)\nline 1\nline 2'
    );
  });
});

describe('searchFiles (glob mode)', () => {
  it('maps found uris to workspace-relative paths', async () => {
    __state.findFilesResult = [
      Uri.joinPath(__state.workspaceFolders![0].uri, 'src/a.ts'),
      Uri.joinPath(__state.workspaceFolders![0].uri, 'src/b.ts'),
    ];
    await expect(searchFiles('**/*.ts', 'glob')).resolves.toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('returns an empty list when nothing matches', async () => {
    __state.findFilesResult = [];
    await expect(searchFiles('**/*.md', 'glob')).resolves.toEqual([]);
  });

  it('always excludes the configured noise folders', async () => {
    __state.findFilesResult = [];
    await searchFiles('**/*.ts', 'glob');
    await searchFiles('needle', 'content');
    for (const call of workspace.findFiles.mock.calls) {
      expect(call[1]).toBe(settings.search.excludeGlob);
    }
  });
});

describe('searchFiles (content mode)', () => {
  it('returns one path:line: preview line per matching line', async () => {
    const a = __setFile('a.ts', 'first line\nconst needle = 1;\nlast line');
    const b = __setFile('b.ts', 'unrelated');
    const c = __setFile('c.ts', 'also needle here');
    __state.findFilesResult = [a, b, c];

    const results = await searchFiles('needle', 'content');
    expect(results).toEqual(['a.ts:2: const needle = 1;', 'c.ts:1: also needle here']);
  });

  it('reports every matching line within a file', async () => {
    const a = __setFile('a.ts', 'needle one\nskip\nneedle two\nneedle three');
    __state.findFilesResult = [a];
    await expect(searchFiles('needle', 'content')).resolves.toEqual([
      'a.ts:1: needle one',
      'a.ts:3: needle two',
      'a.ts:4: needle three',
    ]);
  });

  it('trims the previewed line and strips a trailing CR', async () => {
    const a = __setFile('a.ts', 'plain\r\n\t  needle indented  \r\n');
    __state.findFilesResult = [a];
    await expect(searchFiles('needle', 'content')).resolves.toEqual([
      'a.ts:2: needle indented',
    ]);
  });

  it('caps a very long matched line in the preview', async () => {
    const max = settings.search.contentPreviewMaxChars;
    const line = 'needle' + 'x'.repeat(max + 50);
    const a = __setFile('a.ts', line);
    __state.findFilesResult = [a];
    const [result] = await searchFiles('needle', 'content');
    expect(result.startsWith('a.ts:1: needle')).toBe(true);
    expect(result.endsWith('…')).toBe(true);
    // "a.ts:1: " prefix + at most max chars of preview + the ellipsis.
    expect(result.length).toBeLessThanOrEqual('a.ts:1: '.length + max + 1);
  });

  it('caps the match lines reported from a single file', async () => {
    const perFile = settings.search.contentMaxMatchesPerFile;
    const body = Array.from({ length: perFile + 10 }, () => 'needle').join('\n');
    const a = __setFile('a.ts', body);
    __state.findFilesResult = [a];
    await expect(searchFiles('needle', 'content')).resolves.toHaveLength(perFile);
  });

  it('skips files that cannot be read without failing', async () => {
    const a = __setFile('a.ts', 'has needle');
    const ghost = Uri.joinPath(__state.workspaceFolders![0].uri, 'ghost.ts');
    __state.findFilesResult = [a, ghost]; // ghost is not seeded -> readFile throws
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['a.ts:1: has needle']);
  });

  it('skips binary files instead of matching inside them', async () => {
    const text = __setFile('a.ts', 'has needle');
    const binary = __setFile('blob.bin', 'needle\0with a NUL byte');
    __state.findFilesResult = [text, binary];
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['a.ts:1: has needle']);
  });

  it('skips files larger than the content-search size cap', async () => {
    const small = __setFile('small.ts', 'needle');
    const huge = __setFile(
      'huge.ts',
      'needle' + 'a'.repeat(settings.search.maxFileSizeBytes)
    );
    __state.findFilesResult = [small, huge];
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['small.ts:1: needle']);
  });

  it('checks an oversized file via stat without ever reading it', async () => {
    // The size cap must bound memory, not only the result set: a file over the
    // cap is rejected by its stat size and never pulled into memory.
    const small = __setFile('small.ts', 'needle');
    const huge = __setFile(
      'huge.ts',
      'needle' + 'a'.repeat(settings.search.maxFileSizeBytes)
    );
    __state.findFilesResult = [small, huge];
    workspace.fs.readFile.mockClear();

    await searchFiles('needle', 'content');

    const readPaths = workspace.fs.readFile.mock.calls.map((c) => (c[0] as Uri).path);
    expect(readPaths).toContain(small.path);
    expect(readPaths).not.toContain(huge.path);
  });

  it('caps total content matches at the configured budget', async () => {
    const uris: Uri[] = [];
    for (let i = 0; i < settings.search.contentMaxMatches + 10; i++) {
      uris.push(__setFile(`f${i}.ts`, 'needle'));
    }
    __state.findFilesResult = uris;
    const results = await searchFiles('needle', 'content');
    expect(results).toHaveLength(settings.search.contentMaxMatches);
  });

  it('bounds the candidate set by a generous ceiling, far above the scan budget', async () => {
    // The candidate Uri array can no longer grow without bound (B-4): findFiles
    // is now passed a ceiling so a huge repo cannot materialise one Uri per
    // file. The ceiling sits far above the files-examined budget, so it never
    // drops a file the budget would have reached - a normal match is still found.
    const hit = __setFile('late.ts', 'needle here');
    __state.findFilesResult = [hit];
    workspace.findFiles.mockClear();
    const results = await searchFiles('needle', 'content');
    expect(results).toEqual(['late.ts:1: needle here']);
    const contentCall = workspace.findFiles.mock.calls.at(-1)!;
    expect(contentCall[2]).toBe(settings.search.scanCandidateLimit);
    expect(settings.search.scanCandidateLimit).toBeGreaterThan(
      settings.search.contentScanLimit
    );
  });

  it('flags truncation when the files-examined budget is hit with files left', async () => {
    __setConfig('myDevTeam.search.contentScanLimit', 2);
    // Three candidate files, none matching: the scan stops after two and says so.
    __state.findFilesResult = [
      __setFile('a.ts', 'nothing'),
      __setFile('b.ts', 'nothing'),
      __setFile('c.ts', 'has needle'), // beyond the budget, never scanned
    ];
    const results = await searchFiles('needle', 'content');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatch(/search stopped after scanning 2 files/);
  });

  it('does not flag truncation when every candidate fits the budget', async () => {
    __setConfig('myDevTeam.search.contentScanLimit', 10);
    __state.findFilesResult = [
      __setFile('a.ts', 'has needle'),
      __setFile('b.ts', 'nothing'),
    ];
    const results = await searchFiles('needle', 'content');
    expect(results).toEqual(['a.ts:1: has needle']);
  });

  it('appends the truncation notice even when nothing matched within the budget', async () => {
    __setConfig('myDevTeam.search.contentScanLimit', 1);
    __state.findFilesResult = [
      __setFile('a.ts', 'nothing here'),
      __setFile('b.ts', 'needle'), // unscanned
    ];
    const results = await searchFiles('needle', 'content');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatch(/search stopped after scanning 1 files/);
  });
});

describe('runCommand', () => {
  it('does not execute when the user declines', async () => {
    const approver = makeApprover(false);
    const out = await runCommand('echo hi', approver);
    expect(out).toBe('Command was not approved by the user.');
    expect(execMock).not.toHaveBeenCalled();
    expect(approver.calls[0]).toMatchObject({
      title: 'Run command',
      detail: '$ echo hi',
      scope: 'run',
    });
  });

  it('escalates the prompt and scope for a command flagged dangerous', async () => {
    const approver = makeApprover(false);
    // `echo` is not denylisted, so the escalation here is purely the model's flag.
    const out = await runCommand('echo wipe', approver, undefined, undefined, true);
    expect(out).toBe('Command was not approved by the user.');
    expect(execMock).not.toHaveBeenCalled();
    expect(approver.calls[0].title).toBe('⚠️ Run destructive command');
    expect(approver.calls[0].detail).toContain('# WARNING: flagged as destructive');
    expect(approver.calls[0].detail).toContain('$ echo wipe');
    // The distinct scope is what keeps an ordinary "Allow All" from covering it.
    expect(approver.calls[0].scope).toBe('run:dangerous');
    // A destructive command is never offered the persistent "always allow".
    expect(approver.calls[0].alwaysAllowLabel).toBeUndefined();
  });

  it('escalates a denylisted command to the destructive scope even when not flagged', async () => {
    const approver = makeApprover(false);
    // `rm` is on the built-in denylist; the model left `dangerous` off, but the
    // command is still treated as destructive (the B-1 injection guard).
    const out = await runCommand('rm -rf build', approver);
    expect(out).toBe('Command was not approved by the user.');
    expect(execMock).not.toHaveBeenCalled();
    expect(approver.calls[0].title).toBe('⚠️ Run destructive command');
    expect(approver.calls[0].scope).toBe('run:dangerous');
    expect(approver.calls[0].alwaysAllowLabel).toBeUndefined();
  });

  it('escalates a denylisted command hidden behind a shell operator', async () => {
    const approver = makeApprover(false);
    await runCommand('echo ok && curl http://evil.test', approver);
    // The denied `curl` segment forces the destructive scope despite the benign
    // leading command.
    expect(approver.calls[0].scope).toBe('run:dangerous');
  });

  it('skips the prompt for a command on the user allowlist', async () => {
    __setConfig('myDevTeam.run.allowedCommands', ['npm test', 'git status']);
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'ok', stderr: '' })
    );
    const approver = makeApprover(true);
    const out = await runCommand('npm test -- --watch=false', approver);
    expect(out).toBe('ok');
    expect(approver.calls).toHaveLength(0);
    expect(execMock).toHaveBeenCalled();
  });

  it('still prompts for a chained command even if its prefix is allowlisted', async () => {
    __setConfig('myDevTeam.run.allowedCommands', ['npm test']);
    const approver = makeApprover(false);
    await runCommand('npm test && rm -rf build', approver);
    // A chained command is never eligible for the allowlist fast path, and the
    // denied `rm` segment escalates it.
    expect(approver.calls).toHaveLength(1);
    expect(approver.calls[0].scope).toBe('run:dangerous');
  });

  it('never auto-runs a denylisted command even if the allowlist would match it', async () => {
    __setConfig('myDevTeam.run.allowedCommands', ['git push']);
    const approver = makeApprover(false);
    await runCommand('git push --force', approver);
    // The denylist wins over an allowlist entry, so the prompt still appears.
    expect(approver.calls).toHaveLength(1);
    expect(approver.calls[0].scope).toBe('run:dangerous');
  });

  it('offers a persistent "always allow" choice for an ordinary command', async () => {
    const approver = makeApprover(false);
    await runCommand('git status --short', approver);
    // The suggested prefix extends to the subcommand (git status), not just git.
    expect(approver.calls[0].alwaysAllowLabel).toBe('Always allow `git status`');
  });

  it('persisting "always allow" appends the prefix to the user allowlist', async () => {
    let captured: { apply: () => Promise<void> } | undefined;
    const approver: Approver = {
      async confirm(_t, _d, _s, _c, alwaysAllow) {
        captured = alwaysAllow;
        return true;
      },
    };
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('npm run build', approver);
    expect(captured).toBeDefined();
    await captured!.apply();
    expect(
      workspace.getConfiguration('myDevTeam').get('run.allowedCommands')
    ).toEqual(['npm run']);
  });

  it('uses the ordinary prompt and scope when dangerous is not set', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    const approver = makeApprover(true);
    await runCommand('npm test', approver);
    expect(approver.calls[0].title).toBe('Run command');
    expect(approver.calls[0].detail).not.toContain('WARNING');
    expect(approver.calls[0].scope).toBe('run');
  });

  it('returns combined stdout and stderr when approved', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'out', stderr: 'warn' })
    );
    const out = await runCommand('echo hi', makeApprover(true));
    expect(out).toBe('out\n[stderr]\nwarn');
  });

  it('omits the stderr section when there is none', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'only out', stderr: '' })
    );
    await expect(runCommand('echo hi', makeApprover(true))).resolves.toBe('only out');
  });

  it('rejects with a friendly message when the command fails', async () => {
    // A genuine command failure rejects so it surfaces as a failed tool call,
    // rather than resolving to a string a model might read as success.
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(new Error('boom'), { stdout: '', stderr: '' })
    );
    await expect(runCommand('false', makeApprover(true))).rejects.toThrow(
      'Command failed: boom'
    );
  });

  it('carries the output a failed command produced before exiting in the error', async () => {
    // The real exec attaches the collected stdout/stderr to the error.
    const err = Object.assign(new Error('Command failed: npm test'), {
      stdout: '1 test failed',
      stderr: 'AssertionError',
    });
    execMock.mockImplementation((_cmd, _opts, cb) => cb(err, undefined));
    const failure = await runCommand('npm test', makeApprover(true)).catch(
      (e) => e as Error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('Command failed: npm test');
    expect(failure.message).toContain('1 test failed');
    expect(failure.message).toContain('[stderr]\nAssertionError');
  });

  it('runs in the workspace root with the configured output buffer', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('echo hi', makeApprover(true));
    const opts = execMock.mock.calls[0][1] as { cwd: string; maxBuffer: number };
    expect(opts.cwd).toBe('/ws');
    expect(opts.maxBuffer).toBe(settings.runCommandMaxBufferBytes);
  });

  it('does not start a process when the request is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await runCommand(
      'echo hi',
      makeApprover(true),
      undefined,
      controller.signal
    );
    expect(out).toBe('Command was cancelled before running.');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('kills the process and reports cancellation when aborted mid-run', async () => {
    const controller = new AbortController();
    execMock.mockImplementation((_cmd, _opts, cb) => {
      // Abort while the process is "running", then settle as a killed process
      // would (the kill-tree itself is a no-op on the pid-less test child).
      queueMicrotask(() => {
        controller.abort();
        cb(new Error('killed'));
      });
    });
    const out = await runCommand(
      'sleep 100',
      makeApprover(true),
      undefined,
      controller.signal
    );
    expect(out).toBe('Command was cancelled and the process was killed.');
  });

  it('spawns the shell the environment config announces to the model', async () => {
    // The prompts tell the model its commands run in environment.shell
    // (PowerShell on Windows); the exec call must honour that, not the
    // platform default cmd.exe.
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('echo hi', makeApprover(true));
    const opts = execMock.mock.calls[0][1] as { shell?: string };
    expect(opts.shell).toBe(environment.execShell);
  });

  it('detaches the child off Windows so the whole process group can be killed', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    await runCommand('echo hi', makeApprover(true));
    const opts = execMock.mock.calls[0][1] as { detached?: boolean };
    expect(opts.detached).toBe(process.platform !== 'win32');
  });

  it('kills the whole process group on POSIX platforms when aborted', async () => {
    // Signalling only the shell child would orphan its grandchildren; the
    // negative pid takes down the group the detached child leads.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true as unknown as true);
    const controller = new AbortController();
    execMock.mockImplementation((_cmd, _opts, cb) => {
      childRef.current.pid = 4242;
      queueMicrotask(() => {
        controller.abort();
        cb(new Error('killed'));
      });
    });
    try {
      const out = await runCommand(
        'sleep 100',
        makeApprover(true),
        undefined,
        controller.signal
      );
      expect(out).toBe('Command was cancelled and the process was killed.');
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      killSpy.mockRestore();
    }
  });

  it('caps the model-facing output of a chatty command, keeping head and tail', async () => {
    const cap = settings.runResultMaxChars;
    const big = 'HEAD' + 'x'.repeat(cap) + 'TAIL';
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: big, stderr: '' })
    );
    const out = await runCommand('npm test', makeApprover(true));
    expect(out.length).toBeLessThan(cap + 100);
    expect(out).toContain('…(output truncated)…');
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
  });

  it('caps the output carried by a failed command too', async () => {
    const cap = settings.runResultMaxChars;
    const err = Object.assign(new Error('Command failed: npm test'), {
      stdout: 'x'.repeat(cap + 1_000),
      stderr: 'the final assertion',
    });
    execMock.mockImplementation((_cmd, _opts, cb) => cb(err, undefined));
    const failure = await runCommand('npm test', makeApprover(true)).catch(
      (e) => e as Error
    );
    const out = failure.message;
    expect(out.length).toBeLessThan(cap + 200);
    expect(out).toContain('Command failed: npm test');
    expect(out).toContain('…(output truncated)…');
    // The tail (where the failure usually prints) survives the cap.
    expect(out).toContain('the final assertion');
  });
});

describe('runCommand mirroring', () => {
  /** RunMirror test double recording the lifecycle as ordered entries. */
  function makeMirror(): RunMirror & { entries: string[] } {
    const entries: string[] = [];
    return {
      entries,
      begin: (command) => entries.push(`begin:${command}`),
      output: (chunk) => entries.push(`output:${chunk}`),
      end: (note) => entries.push(`end:${note}`),
    };
  }

  it('streams the lifecycle and live output of a successful command', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      // Emit asynchronously, as a real process would: runCommand must have
      // attached its stream taps by then.
      queueMicrotask(() => {
        childRef.current.stdout.emit('data', 'building...\n');
        childRef.current.stderr.emit('data', 'warn: legacy');
        cb(null, { stdout: 'building...\n', stderr: 'warn: legacy' });
      });
    });
    const mirror = makeMirror();
    const out = await runCommand('npm run build', makeApprover(true), mirror);

    expect(mirror.entries).toEqual([
      'begin:npm run build',
      'output:building...\n',
      'output:warn: legacy',
      'end:(command completed)',
    ]);
    // The buffered result for the model is unchanged by the mirroring.
    expect(out).toBe('building...\n\n[stderr]\nwarn: legacy');
  });

  it('ends the mirror with the failure reason when the command fails', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      queueMicrotask(() => cb(new Error('boom')));
    });
    const mirror = makeMirror();
    // The failure rejects now; the mirror is still ended with the reason first.
    await runCommand('false', makeApprover(true), mirror).catch(() => {});
    expect(mirror.entries).toEqual(['begin:false', 'end:Command failed: boom']);
  });

  it('never reaches the mirror when the user declines', async () => {
    const mirror = makeMirror();
    await runCommand('echo hi', makeApprover(false), mirror);
    expect(mirror.entries).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('writeFile', () => {
  // write is not gated by default (the workspace is git-backed, so a clobber is
  // recoverable); it applies directly, with the path/symlink and cancellation
  // guards still enforced. The opt-in approval gate is covered in its own
  // describe block below.
  it('writes the file and reports byte length', async () => {
    const out = await writeFile('new.ts', 'hello');
    expect(out).toBe('Wrote new.ts (5 bytes).');
    expect(__state.files.get('/ws/new.ts')).toBe('hello');
  });

  it('reports utf8 bytes, not characters, for multi-byte content', async () => {
    // "héllo" is 5 characters but 6 utf8 bytes.
    const out = await writeFile('uni.ts', 'héllo');
    expect(out).toBe('Wrote uni.ts (6 bytes).');
  });

  it('overwrites an existing file with the new contents', async () => {
    __setFile('exists.ts', 'old body');
    await writeFile('exists.ts', 'new body');
    expect(__state.files.get('/ws/exists.ts')).toBe('new body');
  });

  it('rejects a traversal path before touching disk', async () => {
    await expect(writeFile('../evil.ts', 'x')).rejects.toThrow(
      /outside the workspace/
    );
    expect([...__state.files.keys()].some((k) => k.includes('evil'))).toBe(false);
  });

  it('rejects writing through a symbolic link', async () => {
    __setSymlink('link.ts', 'old');
    await expect(writeFile('link.ts', 'new')).rejects.toThrow(/symbolic link/);
    expect(__state.files.get('/ws/link.ts')).toBe('old');
  });

  it('rejects writing into a symlinked directory', async () => {
    // The write target itself does not exist yet, but its parent is a link
    // pointing who-knows-where; the ancestor check must catch it.
    __setSymlinkDir('linkdir');
    await expect(writeFile('linkdir/new.ts', 'x')).rejects.toThrow(/symbolic link/);
    expect(__state.files.has('/ws/linkdir/new.ts')).toBe(false);
  });

  it('does not write when the request was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await writeFile('new.ts', 'hello', controller.signal);
    expect(out).toBe('Write was cancelled; the file was not changed.');
    expect(__state.files.has('/ws/new.ts')).toBe(false);
  });
});

describe('editFile', () => {
  // edit is not gated by default (see writeFile); it locates a unique match and
  // applies it directly. The match-uniqueness and path guards still protect the
  // file. The opt-in approval gate is covered in its own describe block below.
  it('replaces a unique match and reports the edit', async () => {
    __setFile('a.ts', 'const a = 1;\nconst b = 2;\n');
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 42;');
    expect(out).toBe('Edited a.ts (1 replacement).');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 42;\nconst b = 2;\n');
  });

  it('does not interpret $-patterns in the replacement text', async () => {
    // String.replace treats $& and friends as substitutions; model-written
    // code legitimately contains them (regex, shell, templates).
    __setFile('a.ts', 'const re = OLD;');
    await editFile('a.ts', 'OLD', "'$&-$1'");
    expect(__state.files.get('/ws/a.ts')).toBe("const re = '$&-$1';");
  });

  it('refuses a missing file and points the model at the write tool', async () => {
    const out = await editFile('ghost.ts', 'old', 'new');
    expect(out).toBe('File does not exist: ghost.ts. Use the write tool to create a new file.');
  });

  it('reports a missing match with an instruction to re-read the file', async () => {
    __setFile('a.ts', 'const a = 1;');
    const out = await editFile('a.ts', 'const b = 2;', 'x');
    expect(out).toMatch(/not found in a\.ts/);
    expect(out).toMatch(/read the file/i);
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('reports an ambiguous match with the count and asks for more context', async () => {
    __setFile('a.ts', 'let x = 0;\nlet x = 0;\nlet x = 0;');
    const out = await editFile('a.ts', 'let x = 0;', 'let y = 0;');
    expect(out).toContain('matches 3 places in a.ts');
    expect(out).toMatch(/surrounding/);
    expect(__state.files.get('/ws/a.ts')).toBe('let x = 0;\nlet x = 0;\nlet x = 0;');
  });

  it('rejects an edit whose oldText and newText are identical', async () => {
    __setFile('a.ts', 'const a = 1;');
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 1;');
    expect(out).toMatch(/identical/);
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('matches an LF snippet against a CRLF file without rewriting its line endings', async () => {
    // Models usually emit LF; files on Windows are often CRLF. The snippet is
    // adapted to the file, so the match succeeds and the untouched parts of
    // the file keep their endings.
    __setFile('a.ts', 'one\r\ntwo\r\nthree\r\n');
    const out = await editFile('a.ts', 'one\ntwo', 'uno\ndos');
    expect(out).toBe('Edited a.ts (1 replacement).');
    expect(__state.files.get('/ws/a.ts')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('matches a CRLF snippet against an LF file', async () => {
    __setFile('a.ts', 'one\ntwo\nthree\n');
    await editFile('a.ts', 'one\r\ntwo', 'uno\r\ndos');
    expect(__state.files.get('/ws/a.ts')).toBe('uno\ndos\nthree\n');
  });

  it('rejects a traversal path before reading the file', async () => {
    await expect(editFile('../evil.ts', 'a', 'b')).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('rejects editing through a symbolic link', async () => {
    __setSymlink('link.ts', 'old');
    await expect(editFile('link.ts', 'old', 'new')).rejects.toThrow(/symbolic link/);
    expect(__state.files.get('/ws/link.ts')).toBe('old');
  });

  it('does not edit when the request was already cancelled', async () => {
    __setFile('a.ts', 'const a = 1;');
    const controller = new AbortController();
    controller.abort();
    const out = await editFile('a.ts', '1', '2', controller.signal);
    expect(out).toBe('Edit was cancelled; the file was not changed.');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('rejects editing through a symlinked directory', async () => {
    __setSymlinkDir('linkdir');
    __setFile('linkdir/a.ts', 'const a = 1;');
    await expect(editFile('linkdir/a.ts', '1', '2')).rejects.toThrow(/symbolic link/);
    expect(__state.files.get('/ws/linkdir/a.ts')).toBe('const a = 1;');
  });
});

describe('write/edit approval gate (myDevTeam.approval.fileChanges)', () => {
  // Off by default, write/edit never ask. Turned on, every write and edit goes
  // through the same Approver as the run tool: an approve lets the change land,
  // a decline leaves the file untouched and returns a relayed message.
  it('does not consult the approver when the setting is off (the default)', async () => {
    const approver = makeApprover(false);
    const out = await writeFile('new.ts', 'hello', undefined, undefined, approver);
    expect(out).toBe('Wrote new.ts (5 bytes).');
    expect(approver.calls).toHaveLength(0);
    expect(__state.files.get('/ws/new.ts')).toBe('hello');
  });

  it('asks before a write and applies it when approved', async () => {
    __setConfig('myDevTeam.approval.fileChanges', true);
    const approver = makeApprover(true);
    const out = await writeFile('new.ts', 'hello', undefined, undefined, approver);
    expect(approver.calls[0]).toEqual({
      title: 'Write file',
      detail: 'new.ts',
      scope: 'write',
    });
    expect(out).toBe('Wrote new.ts (5 bytes).');
    expect(__state.files.get('/ws/new.ts')).toBe('hello');
  });

  it('leaves the file untouched when a write is declined', async () => {
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('exists.ts', 'old body');
    const out = await writeFile('exists.ts', 'new body', undefined, undefined, makeApprover(false));
    expect(out).toBe('Write was not approved by the user.');
    expect(__state.files.get('/ws/exists.ts')).toBe('old body');
  });

  it('asks before an edit and applies it when approved', async () => {
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('a.ts', 'const a = 1;');
    const approver = makeApprover(true);
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 2;', undefined, undefined, approver);
    expect(approver.calls[0]).toEqual({
      title: 'Edit file',
      detail: 'a.ts',
      scope: 'edit',
    });
    expect(out).toBe('Edited a.ts (1 replacement).');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 2;');
  });

  it('leaves the file untouched when an edit is declined', async () => {
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('a.ts', 'const a = 1;');
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 2;', undefined, undefined, makeApprover(false));
    expect(out).toBe('Edit was not approved by the user.');
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('does not prompt for a protected path even with the gate on', async () => {
    // The protected-path refusal comes before the approval gate, so the user is
    // never asked to approve a write that would be refused anyway.
    __setConfig('myDevTeam.approval.fileChanges', true);
    const approver = makeApprover(true);
    const out = await writeFile('.git/hooks/pre-commit', 'x', undefined, undefined, approver);
    expect(out).toMatch(/Refusing to write/);
    expect(approver.calls).toHaveLength(0);
  });

  it('does not prompt for an edit that cannot locate its target', async () => {
    // The gate is asked only after the edit is known to apply, so a missing
    // match returns its recovery message without a prompt.
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('a.ts', 'const a = 1;');
    const approver = makeApprover(true);
    const out = await editFile('a.ts', 'const b = 2;', 'x', undefined, undefined, approver);
    expect(out).toMatch(/not found in a\.ts/);
    expect(approver.calls).toHaveLength(0);
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 1;');
  });

  it('re-reads after approval so a concurrent edit is not clobbered (B-6)', async () => {
    // The file gains an extra line while the approval prompt is open. The edit
    // is re-located against the current contents, so the concurrent line
    // survives and only the matched text is replaced.
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('a.ts', 'const a = 1;');
    const approver: Approver = {
      async confirm() {
        // Simulate the user (or another tool) editing the file mid-prompt.
        __setFile('a.ts', 'const a = 1;\nconst added = true;');
        return true;
      },
    };
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 2;', undefined, undefined, approver);
    expect(out).toBe('Edited a.ts (1 replacement).');
    // The replacement applied to the fresh contents, keeping the concurrent line.
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 2;\nconst added = true;');
  });

  it('reports a failure when a concurrent edit removes the match during the prompt (B-6)', async () => {
    // The match is deleted while the prompt is open: re-locating against the
    // current contents now fails, so the edit reports it rather than writing
    // stale text that no longer fits the file.
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('a.ts', 'const a = 1;');
    const approver: Approver = {
      async confirm() {
        __setFile('a.ts', 'const a = 999;');
        return true;
      },
    };
    const out = await editFile('a.ts', 'const a = 1;', 'const a = 2;', undefined, undefined, approver);
    expect(out).toMatch(/not found in a\.ts/);
    expect(__state.files.get('/ws/a.ts')).toBe('const a = 999;');
  });
});

describe('symlink re-validation (TOCTOU window)', () => {
  // resolveWorkspaceUri's symlink check is check-then-use, not atomic: a
  // component can be swapped for an escaping link between the resolve and the
  // operation. read re-validates after reading, write/edit re-validate before
  // writing, so a link swapped in mid-operation is still caught.
  it('discards read bytes when a component becomes a symlink during the read', async () => {
    const uri = __setFile('race.ts', 'secret');
    // Simulate the swap: the read itself flips the path to a symlink, so the
    // pre-read check passed but the post-read re-validation rejects it.
    workspace.fs.readFile.mockImplementationOnce(async () => {
      __state.symlinks.add(uri.path);
      return new TextEncoder().encode('secret');
    });
    await expect(readFile('race.ts')).rejects.toThrow(/symbolic link/);
  });

  it('refuses a write when a component becomes a symlink after the resolve', async () => {
    const uri = __setFile('race.ts', 'old');
    const original = workspace.fs.stat.getMockImplementation()!;
    // The first stat (the resolve-time check) reports a normal file, then flips
    // the path to a symlink; the pre-write re-validation's stat catches it.
    workspace.fs.stat.mockImplementationOnce(async (u: any) => {
      const result = await original(u);
      __state.symlinks.add(uri.path);
      return result;
    });
    await expect(writeFile('race.ts', 'new')).rejects.toThrow(/symbolic link/);
    expect(__state.files.get('/ws/race.ts')).toBe('old');
  });

  it('refuses an edit when a component becomes a symlink after the resolve', async () => {
    const uri = __setFile('race.ts', 'const a = 1;');
    // The edit's own read flips the path to a symlink; the pre-write
    // re-validation rejects it before the changed bytes land.
    workspace.fs.readFile.mockImplementationOnce(async () => {
      __state.symlinks.add(uri.path);
      return new TextEncoder().encode('const a = 1;');
    });
    await expect(editFile('race.ts', 'const a = 1;', 'const a = 2;')).rejects.toThrow(
      /symbolic link/
    );
    expect(__state.files.get('/ws/race.ts')).toBe('const a = 1;');
  });
});

describe('protected paths (write/edit)', () => {
  // Locations inside the workspace that can run code on their own (.git hooks,
  // .vscode tasks) are refused by write/edit even though they pass the
  // containment check, so an ungated write cannot sidestep the run gate.
  it('refuses to write inside .git and leaves the file untouched', async () => {
    const out = await writeFile('.git/hooks/pre-commit', '#!/bin/sh\nrm -rf /\n');
    expect(out).toMatch(/Refusing to write \.git\/hooks\/pre-commit/);
    expect(out).toMatch(/protected location/);
    expect(__state.files.has('/ws/.git/hooks/pre-commit')).toBe(false);
  });

  it('refuses to edit a file inside .git', async () => {
    __setFile('.git/config', '[core]\n');
    const out = await editFile('.git/config', '[core]', '[evil]');
    expect(out).toMatch(/Refusing to edit \.git\/config/);
    expect(__state.files.get('/ws/.git/config')).toBe('[core]\n');
  });

  it('matches per segment, so a sibling like .gitignore is not protected', async () => {
    // .git is matched as a whole path segment, so .gitignore is fine to write.
    const out = await writeFile('.gitignore', 'node_modules\n');
    expect(out).toBe('Wrote .gitignore (13 bytes).');
    expect(__state.files.get('/ws/.gitignore')).toBe('node_modules\n');
  });

  it('matches the protected segment case-insensitively', async () => {
    // A case-insensitive filesystem would let .GIT/hooks resolve to .git/hooks.
    const out = await writeFile('.GIT/hooks/pre-push', 'evil');
    expect(out).toMatch(/Refusing to write/);
    expect(__state.files.has('/ws/.GIT/hooks/pre-push')).toBe(false);
  });

  it('refuses .vscode by default (it can auto-run tasks)', async () => {
    const out = await writeFile('.vscode/tasks.json', '{"version":"2.0.0"}');
    expect(out).toMatch(/Refusing to write \.vscode\/tasks\.json/);
    expect(__state.files.has('/ws/.vscode/tasks.json')).toBe(false);
  });

  it('honours a configured protected list, but .git stays protected regardless', async () => {
    // Drop .vscode from the configurable list: it becomes writable, while the
    // hardcoded .git remains refused.
    __setConfig('myDevTeam.write.protectedPaths', ['secrets']);
    expect(await writeFile('.vscode/settings.json', '{}')).toBe(
      'Wrote .vscode/settings.json (2 bytes).'
    );
    expect(await writeFile('secrets/key.txt', 'x')).toMatch(/Refusing to write/);
    expect(await writeFile('.git/hooks/pre-commit', 'x')).toMatch(/Refusing to write/);
  });

  it('still resolves containment before the protected check', async () => {
    // A traversal path is rejected by resolveWorkspaceUri (a throw), not turned
    // into a protected-path message.
    await expect(writeFile('../.git/hooks/pre-commit', 'x')).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('writes a normal source file unaffected', async () => {
    expect(await writeFile('src/app.ts', 'export {};')).toBe(
      'Wrote src/app.ts (10 bytes).'
    );
  });
});

describe('multi-root workspace', () => {
  // In a multi-root workspace asRelativePath prefixes paths with the folder
  // name, so the tools must resolve a `folderName/relative/path` against the
  // named folder. A single-folder workspace is covered by every test above.
  beforeEach(() => {
    __setWorkspaceFolders([
      { name: 'api', path: '/api' },
      { name: 'web', path: '/web' },
    ]);
  });

  it('resolves a folder-prefixed read against the named folder', async () => {
    __setFileIn('api', 'src/a.ts', 'api file');
    __setFileIn('web', 'src/a.ts', 'web file');
    await expect(readFile('api/src/a.ts')).resolves.toBe('api file');
    await expect(readFile('web/src/a.ts')).resolves.toBe('web file');
  });

  it('resolves a bare path against the first folder', async () => {
    __setFileIn('api', 'src/a.ts', 'api file');
    await expect(readFile('src/a.ts')).resolves.toBe('api file');
  });

  it('writes and edits through a folder-prefixed path', async () => {
    await writeFile('web/new.ts', 'hello');
    expect(__state.files.get('/web/new.ts')).toBe('hello');
    __setFileIn('api', 'b.ts', 'const a = 1;');
    await editFile('api/b.ts', 'const a = 1;', 'const a = 2;');
    expect(__state.files.get('/api/b.ts')).toBe('const a = 2;');
  });

  it('lists folder-prefixed paths the read tool can then open', async () => {
    const a = __setFileIn('api', 'src/a.ts', 'alpha');
    const b = __setFileIn('web', 'src/b.ts', 'beta');
    __state.findFilesResult = [a, b];

    const results = await searchFiles('**/*.ts', 'glob');
    expect(results).toEqual(['api/src/a.ts', 'web/src/b.ts']);
    // The whole point: a path search returns is one read can open.
    await expect(readFile(results[1])).resolves.toBe('beta');
  });

  it('still rejects a traversal that escapes the named folder', async () => {
    await expect(readFile('api/../../secret.txt')).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('does not let a same-named root shadow a real directory in the first folder', async () => {
    // The first folder (api) has a real top-level `web/` directory while a
    // `web` root also exists. A path under it must resolve to the real file in
    // the first folder, not be hijacked to the `web` root - otherwise the
    // search tool could list a path read/edit then opens as a different file.
    __setFileIn('api', 'web/x.ts', 'shadowed file in the first root');
    __setFileIn('web', 'x.ts', 'file in the web root');
    await expect(readFile('web/x.ts')).resolves.toBe('shadowed file in the first root');
  });

  it('falls back to the named folder when the first folder has no such path', async () => {
    // No `web/only.ts` in the first folder, so the head still routes to the
    // web root (the asRelativePath-prefixed form).
    __setFileIn('web', 'only.ts', 'web root only');
    await expect(readFile('web/only.ts')).resolves.toBe('web root only');
  });

  it('routes a folder-prefixed write to the named folder when nothing exists yet', async () => {
    // A not-yet-created target has no first-folder path to prefer, so the
    // prefixed form lands in the named folder.
    await writeFile('web/new.ts', 'hello');
    expect(__state.files.get('/web/new.ts')).toBe('hello');
    expect(__state.files.has('/api/web/new.ts')).toBe(false);
  });
});

describe('workspace trust and virtual workspaces', () => {
  it('refuses run in an untrusted workspace without prompting', async () => {
    __setTrusted(false);
    const approver = makeApprover(true);
    const out = await runCommand('npm test', approver);
    expect(out).toMatch(/not trusted/);
    expect(execMock).not.toHaveBeenCalled();
    // No approval prompt for an action that cannot run.
    expect(approver.calls).toEqual([]);
  });

  it('refuses write in an untrusted workspace', async () => {
    __setTrusted(false);
    const out = await writeFile('a.ts', 'x');
    expect(out).toMatch(/not trusted/);
    expect(__state.files.has('/ws/a.ts')).toBe(false);
  });

  it('refuses edit in an untrusted workspace', async () => {
    __setTrusted(false);
    __setFile('a.ts', 'old');
    const out = await editFile('a.ts', 'old', 'new');
    expect(out).toMatch(/not trusted/);
    expect(__state.files.get('/ws/a.ts')).toBe('old');
  });

  it('still allows read and search in an untrusted workspace', async () => {
    __setTrusted(false);
    const a = __setFile('a.ts', 'needle');
    __state.findFilesResult = [a];
    await expect(readFile('a.ts')).resolves.toBe('needle');
    await expect(searchFiles('needle', 'content')).resolves.toEqual(['a.ts:1: needle']);
  });

  it('refuses run in a virtual workspace but keeps write working', async () => {
    __setWorkspaceFolders([{ name: 'remote', path: '/remote', scheme: 'vscode-vfs' }]);
    const out = await runCommand('npm test', makeApprover(true));
    expect(out).toMatch(/virtual workspace/);
    expect(execMock).not.toHaveBeenCalled();
    // Write goes through the filesystem API and keeps working in a trusted
    // virtual workspace.
    await writeFile('a.ts', 'x');
    expect(__state.files.get('/remote/a.ts')).toBe('x');
  });

  it('names the cwd folder in the run approval prompt in a multi-root workspace', async () => {
    __setWorkspaceFolders([
      { name: 'api', path: '/api' },
      { name: 'web', path: '/web' },
    ]);
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: '', stderr: '' })
    );
    const approver = makeApprover(true);
    await runCommand('npm test', approver);
    expect(approver.calls[0].detail).toBe('# cwd: api\n$ npm test');
  });
});
