import { describe, it, expect, beforeEach, vi } from 'vitest';

// child_process.exec is invoked through util.promisify inside runCommand.
// We replace it with a controllable fake before importing the module under test.
const execMock = vi.fn();
vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: Function) => execMock(cmd, opts, cb),
}));

import { WorkspaceToolHost } from '../src/tools/toolHost';
import { Approver, ChangeReporter, McpInvoker } from '../src/tools/types';
import { clientToolNames } from '../src/protocol/toolContract';
import { __reset, __state, __setFile, __setConfig } from './mocks/vscode';

/** McpInvoker test double recognising a fixed name set and recording calls. */
function makeMcp(
  names: string[],
  result = 'mcp result'
): McpInvoker & { calls: Array<{ name: string; args: unknown; signal?: AbortSignal }> } {
  const calls: Array<{ name: string; args: unknown; signal?: AbortSignal }> = [];
  const set = new Set(names);
  return {
    calls,
    names: () => names,
    has: (name) => set.has(name),
    listToolDefs: async () =>
      names.map((name) => ({ name, description: 'desc', inputSchema: { type: 'object' } })),
    execute: async (name, args, signal) => {
      calls.push({ name, args, signal });
      return result;
    },
  };
}

/** Approver test double recording calls and returning a fixed verdict. */
function makeApprover(verdict: boolean): Approver & {
  calls: Array<{ title: string; detail: string; scope: string }>;
} {
  const calls: Array<{ title: string; detail: string; scope: string }> = [];
  return {
    calls,
    confirm: async (title: string, detail: string, scope: string) => {
      calls.push({ title, detail, scope });
      return verdict;
    },
  };
}

/** ChangeReporter test double recording the before/after of each landed write. */
function makeReporter(): ChangeReporter & {
  calls: Array<{ path: string; before: string; after: string }>;
} {
  const calls: Array<{ path: string; before: string; after: string }> = [];
  return {
    calls,
    report: (path, before, after) => calls.push({ path, before, after }),
  };
}

beforeEach(() => {
  __reset();
  execMock.mockReset();
});

describe('WorkspaceToolHost', () => {
  it('offers exactly the protocol contract tool names', () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    expect([...host.tools]).toEqual([...clientToolNames]);
  });

  it('read returns the file text', async () => {
    __setFile('src/a.ts', 'const a = 1;');
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('read', { path: 'src/a.ts' })).resolves.toBe(
      'const a = 1;'
    );
  });

  it('read forwards a line range to the implementation', async () => {
    __setFile('src/a.ts', 'one\ntwo\nthree\n');
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('read', { path: 'src/a.ts', startLine: 2, endLine: 2 })
    ).resolves.toBe('(lines 2-2 of 3; continue with startLine 3)\ntwo');
  });

  it('read rejects a path outside the workspace', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('read', { path: '../etc/passwd' })).rejects.toThrow(
      /outside the workspace/
    );
  });

  it('search joins matches with newlines', async () => {
    const a = __setFile('src/a.ts', 'x');
    const b = __setFile('src/b.ts', 'x');
    __state.findFilesResult = [a, b];
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('search', { query: '**/*.ts', mode: 'glob' })
    ).resolves.toBe('src/a.ts\nsrc/b.ts');
  });

  it('search reports no matches instead of returning an empty string', async () => {
    __state.findFilesResult = [];
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('search', { query: '**/*.go', mode: 'glob' })
    ).resolves.toBe('(no matches)');
  });

  it('run executes through the given approver and returns the output', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const approver = makeApprover(true);
    const host = new WorkspaceToolHost(approver);

    await expect(host.execute('run', { command: 'echo hi' })).resolves.toBe('hi');
    expect(approver.calls[0]).toEqual({
      title: 'Run command',
      detail: '$ echo hi',
      scope: 'run',
    });
  });

  it('forwards the dangerous flag, escalating the run approval', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'done', stderr: '' })
    );
    const approver = makeApprover(true);
    const host = new WorkspaceToolHost(approver);

    await expect(
      host.execute('run', { command: 'git reset --hard', dangerous: true })
    ).resolves.toBe('done');
    expect(approver.calls[0].title).toBe('⚠️ Run destructive command');
    expect(approver.calls[0].scope).toBe('run:dangerous');
  });

  it('forwards the run correlation id to the approval prompt (B-2)', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const seen: Array<string | undefined> = [];
    const scopes: string[] = [];
    const approver: Approver = {
      confirm: async (_title, _detail, scope, correlationId) => {
        scopes.push(scope);
        seen.push(correlationId);
        return true;
      },
    };
    const host = new WorkspaceToolHost(approver);

    // With an id, the prompt is tagged so the front-end can attribute it...
    await host.execute('run', { command: 'echo hi' }, undefined, 'run-123');
    expect(seen).toEqual(['run-123']);
    // ...and without one (the editor-wide tool path), no id is passed.
    await host.execute('run', { command: 'echo hi' });
    expect(seen).toEqual(['run-123', undefined]);
    // The run tool's "Allow All" scope is forwarded both ways.
    expect(scopes).toEqual(['run', 'run']);
  });

  it('run forwards the shared mirror to runCommand', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'hi', stderr: '' })
    );
    const entries: string[] = [];
    const mirror = {
      begin: (command: string) => entries.push(`begin:${command}`),
      output: () => {},
      end: (note: string) => entries.push(`end:${note}`),
    };
    const host = new WorkspaceToolHost(makeApprover(true), mirror);
    await host.execute('run', { command: 'echo hi' });
    expect(entries).toEqual(['begin:echo hi', 'end:(command completed)']);
  });

  it('run does not execute when the approver declines', async () => {
    const host = new WorkspaceToolHost(makeApprover(false));
    await expect(host.execute('run', { command: 'rm -rf /' })).resolves.toBe(
      'Command was not approved by the user.'
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it('passes the signal to run, so a cancelled request skips it', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('run', { command: 'echo hi' }, controller.signal)
    ).resolves.toBe('Command was cancelled before running.');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('passes the signal to write, so a cancelled request skips it', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute('write', { path: 'src/new.ts', contents: 'x = 1' }, controller.signal)
    ).resolves.toBe('Write was cancelled; the file was not changed.');
    expect(__state.files.has('/ws/src/new.ts')).toBe(false);
  });

  it('write creates the file directly (no approval gate)', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));

    const result = await host.execute('write', {
      path: 'src/new.ts',
      contents: 'x = 1',
    });
    expect(result).toContain('Wrote src/new.ts');
    expect(__state.files.get('/ws/src/new.ts')).toBe('x = 1');
  });

  it('edit replaces the matched text directly (no approval gate)', async () => {
    __setFile('src/a.ts', 'const a = 1;');
    const host = new WorkspaceToolHost(makeApprover(true));

    const result = await host.execute('edit', {
      path: 'src/a.ts',
      oldText: 'a = 1',
      newText: 'a = 2',
    });
    expect(result).toBe('Edited src/a.ts (1 replacement).');
    expect(__state.files.get('/ws/src/a.ts')).toBe('const a = 2;');
  });

  it('passes the signal to edit, so a cancelled request skips it', async () => {
    __setFile('src/a.ts', 'const a = 1;');
    const controller = new AbortController();
    controller.abort();
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(
      host.execute(
        'edit',
        { path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 2' },
        controller.signal
      )
    ).resolves.toBe('Edit was cancelled; the file was not changed.');
    expect(__state.files.get('/ws/src/a.ts')).toBe('const a = 1;');
  });

  it('reports a created file with an empty before to the change reporter', async () => {
    const reporter = makeReporter();
    const host = new WorkspaceToolHost(makeApprover(true), undefined, reporter);
    await host.execute('write', { path: 'src/new.ts', contents: 'a\nb' });
    expect(reporter.calls).toEqual([{ path: 'src/new.ts', before: '', after: 'a\nb' }]);
  });

  it('reports an overwrite with the prior contents as before', async () => {
    __setFile('src/a.ts', 'old\ncontents');
    const reporter = makeReporter();
    const host = new WorkspaceToolHost(makeApprover(true), undefined, reporter);
    await host.execute('write', { path: 'src/a.ts', contents: 'new' });
    expect(reporter.calls).toEqual([
      { path: 'src/a.ts', before: 'old\ncontents', after: 'new' },
    ]);
  });

  it('reports an edit with the before and after of the file', async () => {
    __setFile('src/a.ts', 'const a = 1;');
    const reporter = makeReporter();
    const host = new WorkspaceToolHost(makeApprover(true), undefined, reporter);
    await host.execute('edit', { path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 2' });
    expect(reporter.calls).toEqual([
      { path: 'src/a.ts', before: 'const a = 1;', after: 'const a = 2;' },
    ]);
  });

  it('routes write through the approver when approval.fileChanges is on', async () => {
    // The host hands its Approver to write/edit, so turning the setting on gates
    // file changes the same way it gates run. A decline lands nothing.
    __setConfig('myDevTeam.approval.fileChanges', true);
    const approver = makeApprover(false);
    const host = new WorkspaceToolHost(approver);
    const result = await host.execute('write', { path: 'src/new.ts', contents: 'x' });
    expect(approver.calls[0]).toEqual({
      title: 'Write file',
      detail: 'src/new.ts',
      scope: 'write',
    });
    expect(result).toBe('Write was not approved by the user.');
    expect(__state.files.has('/ws/src/new.ts')).toBe(false);
  });

  it('routes edit through the approver when approval.fileChanges is on', async () => {
    __setConfig('myDevTeam.approval.fileChanges', true);
    __setFile('src/a.ts', 'const a = 1;');
    const approver = makeApprover(true);
    const host = new WorkspaceToolHost(approver);
    const result = await host.execute('edit', {
      path: 'src/a.ts',
      oldText: 'a = 1',
      newText: 'a = 2',
    });
    expect(approver.calls[0]).toEqual({
      title: 'Edit file',
      detail: 'src/a.ts',
      scope: 'edit',
    });
    expect(result).toBe('Edited src/a.ts (1 replacement).');
    expect(__state.files.get('/ws/src/a.ts')).toBe('const a = 2;');
  });

  it('does not report a write refused for a protected path', async () => {
    const reporter = makeReporter();
    const host = new WorkspaceToolHost(makeApprover(true), undefined, reporter);
    const result = await host.execute('write', {
      path: '.git/hooks/pre-commit',
      contents: 'evil',
    });
    expect(result).toMatch(/protected location/);
    expect(reporter.calls).toEqual([]);
  });

  it('does not report a cancelled write', async () => {
    const controller = new AbortController();
    controller.abort();
    const reporter = makeReporter();
    const host = new WorkspaceToolHost(makeApprover(true), undefined, reporter);
    await host.execute(
      'write',
      { path: 'src/new.ts', contents: 'x' },
      controller.signal
    );
    expect(reporter.calls).toEqual([]);
  });

  it('rejects an unknown tool before touching anything', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('delete-everything', {})).rejects.toThrow(
      /Unknown tool/
    );
  });

  it('rejects an inherited property name, not just an unlisted one', async () => {
    // Dispatch is a lookup in the handler map; an Object.prototype member like
    // "constructor" must not resolve to a handler.
    const host = new WorkspaceToolHost(makeApprover(true));
    await expect(host.execute('constructor', {})).rejects.toThrow(/Unknown tool/);
    await expect(host.execute('toString', {})).rejects.toThrow(/Unknown tool/);
  });

  it('dispatches every tool the protocol contract declares', async () => {
    // The host's reachable tools and the contract's names are the same set:
    // no contract tool is missing a handler (would throw "Unknown tool").
    const host = new WorkspaceToolHost(makeApprover(true));
    for (const name of clientToolNames) {
      // Malformed args make the schema throw, but never the unknown-tool guard
      // - which proves the name resolved to a handler.
      await expect(host.execute(name, {})).rejects.not.toThrow(/Unknown tool/);
    }
  });

  it('includes the MCP invoker tool names in the offered tools', () => {
    const mcp = makeMcp(['mcp__fs__read', 'mcp__fs__write']);
    const host = new WorkspaceToolHost(makeApprover(true), undefined, undefined, mcp);
    expect([...host.tools]).toEqual([
      ...clientToolNames,
      'mcp__fs__read',
      'mcp__fs__write',
    ]);
  });

  it('gates an MCP tool call through the approver and forwards it on approve', async () => {
    const approver = makeApprover(true);
    const mcp = makeMcp(['mcp__fs__read'], 'file contents');
    const host = new WorkspaceToolHost(approver, undefined, undefined, mcp);

    const controller = new AbortController();
    const result = await host.execute(
      'mcp__fs__read',
      { path: 'a.txt' },
      controller.signal
    );
    expect(result).toBe('file contents');
    // The prompt names the namespaced tool and previews the args.
    expect(approver.calls[0].title).toBe('Call MCP tool');
    expect(approver.calls[0].detail).toContain('mcp__fs__read');
    expect(approver.calls[0].detail).toContain('"path":"a.txt"');
    // The call (and the run's cancellation signal) reached the invoker.
    expect(mcp.calls[0]).toMatchObject({
      name: 'mcp__fs__read',
      args: { path: 'a.txt' },
      signal: controller.signal,
    });
  });

  it('does not run an MCP tool when the approver declines', async () => {
    const mcp = makeMcp(['mcp__fs__write']);
    const host = new WorkspaceToolHost(makeApprover(false), undefined, undefined, mcp);
    await expect(host.execute('mcp__fs__write', { path: 'a' })).resolves.toBe(
      'MCP tool call was not approved by the user.'
    );
    expect(mcp.calls).toEqual([]);
  });

  it('forwards the correlation id to an MCP approval prompt', async () => {
    const seen: Array<string | undefined> = [];
    const scopes: string[] = [];
    const approver: Approver = {
      confirm: async (_t, _d, scope, correlationId) => {
        scopes.push(scope);
        seen.push(correlationId);
        return true;
      },
    };
    const mcp = makeMcp(['mcp__fs__read']);
    const host = new WorkspaceToolHost(approver, undefined, undefined, mcp);
    await host.execute('mcp__fs__read', {}, undefined, 'run-9');
    expect(seen).toEqual(['run-9']);
    // An MCP call's "Allow All" scope is the exact namespaced tool name, so the
    // allowance never covers a sibling tool on the same server.
    expect(scopes).toEqual(['mcp__fs__read']);
  });

  it('rejects an mcp-shaped name the invoker does not recognise', async () => {
    const mcp = makeMcp(['mcp__fs__read']);
    const host = new WorkspaceToolHost(makeApprover(true), undefined, undefined, mcp);
    await expect(host.execute('mcp__other__tool', {})).rejects.toThrow(/Unknown tool/);
  });

  it('rejects malformed arguments before the implementation runs', async () => {
    const host = new WorkspaceToolHost(makeApprover(true));
    // Missing required field.
    await expect(host.execute('read', {})).rejects.toThrow();
    // Wrong enum value.
    await expect(
      host.execute('search', { query: 'x', mode: 'everywhere' })
    ).rejects.toThrow();
    // The approver was never consulted and nothing executed.
    expect(execMock).not.toHaveBeenCalled();
  });
});
