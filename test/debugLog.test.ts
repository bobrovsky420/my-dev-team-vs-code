import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setDebugSink,
  emitDebug,
  stringifyDetail,
  DebugEntry,
} from '../src/config/debugLog';
import { DebugChannel, traceEngine } from '../src/client/debugLog';
import { Engine, RunClient, RunHandle } from '../src/protocol/engine';
import { makeClientHost } from '../src/protocol/capabilities';
import { RunRequest, Reply } from '../src/protocol/types';
import { __reset, __setConfig } from './mocks/vscode';

/** A fake output channel that records the lines written to it. */
function fakeChannel(): { channel: any; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    channel: {
      name: 'test',
      appendLine: (line: string) => lines.push(line),
      append: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      replace: () => {},
      dispose: () => {},
    },
  };
}

beforeEach(() => {
  __reset();
  setDebugSink(undefined);
});

describe('engine debug seam (config/debugLog)', () => {
  it('routes entries to the injected sink and is a no-op once cleared', () => {
    const seen: DebugEntry[] = [];
    setDebugSink({ write: (e) => seen.push(e) });
    emitDebug({ source: 'provider', label: 'request', detail: 'x' });
    expect(seen).toEqual([{ source: 'provider', label: 'request', detail: 'x' }]);

    setDebugSink(undefined);
    emitDebug({ source: 'provider', label: 'ignored' });
    expect(seen).toHaveLength(1);
  });

  it('never throws when the sink throws', () => {
    setDebugSink({
      write: () => {
        throw new Error('boom');
      },
    });
    expect(() => emitDebug({ source: 'backend', label: 'safe' })).not.toThrow();
  });

  it('stringifyDetail renders plain data, strings, and errors legibly', () => {
    expect(stringifyDetail('hello')).toBe('hello');
    expect(stringifyDetail({ a: 1 })).toContain('"a": 1');
    expect(stringifyDetail(new Error('nope'))).toContain('nope');
    expect(stringifyDetail(undefined)).toBe('');
  });
});

describe('DebugChannel', () => {
  it('writes nothing while myDevTeam.debug is off', () => {
    const { channel, lines } = fakeChannel();
    const debug = new DebugChannel(channel);
    expect(debug.enabled()).toBe(false);
    debug.write({ source: 'client', label: 'hi', detail: 'd' });
    expect(lines).toHaveLength(0);
  });

  it('writes a header and an indented detail block when on', () => {
    __setConfig('myDevTeam.debug', true);
    const { channel, lines } = fakeChannel();
    const debug = new DebugChannel(channel);
    expect(debug.enabled()).toBe(true);
    debug.write({ source: 'provider', label: 'request', detail: 'line1\nline2' });
    expect(lines[0]).toContain('[provider] request');
    expect(lines[1]).toBe('    line1');
    expect(lines[2]).toBe('    line2');
  });
});

const REQUEST = { protocolVersion: 1, prompt: 'hi', offeredTools: ['read'] } as RunRequest;
const REPLY = { intent: 'oneshot', answer: 'done' } as unknown as Reply;

/** An engine that, on startRun, drives the client (an event and a tool invoke). */
class DrivingEngine implements Engine {
  readonly kind = 'local';
  startRun(_req: RunRequest, client: RunClient): RunHandle {
    const result = (async () => {
      client.onEvent({ type: 'triaged', intent: 'oneshot', reason: 'r' } as any);
      await client.invoke('tool', { tool: 'read', args: { path: 'a.ts' } });
      return REPLY;
    })();
    return { result, cancel: () => {} };
  }
  async listModels() {
    return [];
  }
  async startupWarnings() {
    return [];
  }
}

describe('traceEngine', () => {
  it('returns the engine untouched when debug is off (identity preserved)', () => {
    const { channel } = fakeChannel();
    const engine = new DrivingEngine();
    expect(traceEngine(engine, new DebugChannel(channel))).toBe(engine);
  });

  it('logs the request, events, and invoke inversions when debug is on', async () => {
    __setConfig('myDevTeam.debug', true);
    const { channel, lines } = fakeChannel();
    const traced = traceEngine(new DrivingEngine(), new DebugChannel(channel));
    // The tracer must not change behaviour: it still passes through to the kind.
    expect(traced.kind).toBe('local');

    const execute = vi.fn(async () => 'file body');
    const handle = traced.startRun(REQUEST, {
      onEvent: () => {},
      ...makeClientHost({ toolNames: ['read'], executeTool: execute }),
    });
    await handle.result;

    // The underlying tool implementation still ran (the trace only observes).
    expect(execute).toHaveBeenCalledWith('read', { path: 'a.ts' }, undefined, undefined);
    const headers = lines.filter((l) => /\] \[/.test(l));
    expect(headers.some((l) => l.includes('-> start run'))).toBe(true);
    expect(headers.some((l) => l.includes('<- event triaged'))).toBe(true);
    expect(headers.some((l) => l.includes('<- invoke tool'))).toBe(true);
    expect(headers.some((l) => l.includes('-> invoke-result tool'))).toBe(true);
    expect(headers.some((l) => l.includes('<- result (ok)'))).toBe(true);
  });
});
