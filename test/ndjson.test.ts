import { describe, expect, it } from 'vitest';
import { createNdjsonReader, ndjsonLine } from '../src/sidecar/ndjson';
import { createChildRuntime } from '../src/sidecar/childRuntime';
import { Engine, RunHandle } from '../src/protocol/engine';
import { ChildMessage, ParentMessage } from '../src/sidecar/transport';
import { PROTOCOL_VERSION } from '../src/protocol/types';

describe('ndjson framing', () => {
  it('frames a message as one JSON line', () => {
    expect(ndjsonLine({ t: 'cancel', runId: 'r1' })).toBe('{"t":"cancel","runId":"r1"}\n');
  });

  it('reassembles messages split across chunks', () => {
    const seen: unknown[] = [];
    const feed = createNdjsonReader((m) => seen.push(m));
    feed('{"t":"can');
    feed('cel","runId":"r1"}\n{"t":"cancel","run');
    expect(seen).toEqual([{ t: 'cancel', runId: 'r1' }]);
    feed('Id":"r2"}\n');
    expect(seen).toEqual([
      { t: 'cancel', runId: 'r1' },
      { t: 'cancel', runId: 'r2' },
    ]);
  });

  it('delivers several messages arriving in one chunk', () => {
    const seen: unknown[] = [];
    const feed = createNdjsonReader((m) => seen.push(m));
    feed('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(seen).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('skips a malformed or blank line and keeps reading', () => {
    const seen: unknown[] = [];
    const feed = createNdjsonReader((m) => seen.push(m));
    feed('not json\n\n{"ok":true}\n');
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe('stdio child runtime over ndjson', () => {
  /** A minimal engine: answers queries, never runs. */
  const fakeEngine: Engine = {
    kind: 'local',
    startRun: (): RunHandle => {
      throw new Error('not under test');
    },
    startupWarnings: () => Promise.resolve(['warn-1']),
    listModels: () => Promise.resolve([]),
  };

  it('answers a framed query with a framed result after the ready handshake', async () => {
    const lines: string[] = [];
    const received: ChildMessage[] = [];
    const readBack = createNdjsonReader((m) => received.push(m as ChildMessage));

    const handle = createChildRuntime((msg) => {
      // The child's post path: frame to a line, then parse it back the way a
      // parent would, so the whole stdio wire is exercised in-process.
      const line = ndjsonLine(msg);
      lines.push(line);
      readBack(line);
    }, () => fakeEngine);

    const feed = createNdjsonReader((msg) => handle(msg as ParentMessage));
    feed(ndjsonLine({ t: 'query', queryId: 'q1', method: 'startupWarnings' }));
    await new Promise((r) => setImmediate(r));

    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    expect(received[0]).toEqual({
      t: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      kind: 'local',
    });
    expect(received[1]).toEqual({
      t: 'query-result',
      queryId: 'q1',
      ok: true,
      value: ['warn-1'],
    });
  });
});
