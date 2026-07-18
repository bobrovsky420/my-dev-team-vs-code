import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  SidecarEngine,
  createStreamChannel,
  traceChannel,
  ChannelStats,
} from '../src/client/sidecarEngine';
import { createChildRuntime } from '../src/sidecar/childRuntime';
import { SidecarChannel, ParentMessage, ChildMessage } from '../src/sidecar/transport';
import {
  Engine,
  RunClient,
  RunHandle,
  RunFailedError,
  RunCancelledError,
} from '../src/protocol/engine';
import {
  RunRequest,
  Reply,
  ModelChoice,
  PlanDecision,
  Plan,
  ContinueDecision,
  PROTOCOL_VERSION,
} from '../src/protocol/types';
import { makeClientHost } from '../src/protocol/capabilities';
import { RuntimeConfig } from '../src/config/runtimeConfig';
import { emitDebug, DebugEntry } from '../src/config/debugLog';

/**
 * Wire a SidecarEngine to a child runtime hosting `engine`, entirely in-process
 * (no fork), so the full message round trip and the tool/plan inversions are
 * exercised without spawning anything. Parent posts reach the child handler;
 * child posts reach the SidecarEngine's message handler.
 */
function connect(
  engine: Engine,
  onDebug?: (entry: DebugEntry) => void
): { sidecar: SidecarEngine; configs: RuntimeConfig[] } {
  const configs: RuntimeConfig[] = [];
  let onChildMessage: (m: ChildMessage) => void = () => {};
  const childHandle = createChildRuntime(
    (m: ChildMessage) => onChildMessage(m),
    () => engine
  );
  const channel: SidecarChannel = {
    post: (m: ParentMessage) => {
      if (m.t === 'config') {
        configs.push(m.config);
      }
      childHandle(m);
    },
    onMessage: (h) => {
      onChildMessage = h;
    },
    onClose: () => {},
    dispose: () => {},
  };
  const getConfig = (): RuntimeConfig => ({
    ollamaEndpoint: undefined,
    providerBaseUrls: {},
    disabledProviders: [],
    disabledModels: [],
    triageModel: '',
    complexityRoutingEnabled: true,
    requestsPerMinute: undefined,
    toolSnippetLines: 5,
    planApproval: 'auto',
    thinkingShowInChat: true,
    summaryShowInChat: true,
  });
  return { sidecar: new SidecarEngine(channel, getConfig, onDebug), configs };
}

const REPLY = { intent: 'planning', reason: 'r', answer: 'done' } as unknown as Reply;

function request(): RunRequest {
  return { protocolVersion: 1, prompt: 'hi', offeredTools: ['read'] } as RunRequest;
}

/** A controllable engine for the child to host. */
class FakeEngine implements Engine {
  readonly kind = 'local';
  constructor(
    private readonly run: (request: RunRequest, client: RunClient) => Promise<Reply>
  ) {}
  startRun(req: RunRequest, client: RunClient): RunHandle {
    const controller = new AbortController();
    const result = this.run(req, { ...client });
    return { result, cancel: () => controller.abort() };
  }
  async listModels(): Promise<ModelChoice[]> {
    return [{ id: 'auto', label: 'Auto', available: true } as ModelChoice];
  }
  async startupWarnings(): Promise<string[]> {
    return ['ollama down'];
  }
}

describe('sidecar round trip', () => {
  it('injects the runtime config to the child on connect', () => {
    const { configs } = connect(new FakeEngine(async () => REPLY));
    expect(configs).toHaveLength(1);
    expect(configs[0].planApproval).toBe('auto');
  });

  it('streams events and settles the result with the reply', async () => {
    const engine = new FakeEngine(async (_req, client) => {
      client.onEvent({ type: 'triaged', intent: 'planning', reason: 'r' });
      client.onEvent({ type: 'answer-delta', text: 'hello' });
      client.onEvent({ type: 'done', reply: REPLY });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const events: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => events.push(e.type),
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    await expect(handle.result).resolves.toEqual(REPLY);
    expect(events).toEqual(['triaged', 'answer-delta', 'done']);
  });

  it('inverts a tool call through the tool capability', async () => {
    const execute = vi.fn(async (tool: string) => `ran:${tool}`);
    const engine = new FakeEngine(async (_req, client) => {
      const out = await client.invoke('tool', { tool: 'read', args: { path: 'a.ts' } });
      client.onEvent({ type: 'answer-delta', text: out });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const deltas: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => {
        if (e.type === 'answer-delta') deltas.push(e.text);
      },
      ...makeClientHost({ toolNames: ['read'], executeTool: execute }),
    });
    await handle.result;
    // The engine's tool call ran on the client side and the result came back.
    expect(execute).toHaveBeenCalledWith('read', { path: 'a.ts' }, expect.anything(), expect.any(String));
    expect(deltas).toEqual(['ran:read']);
  });

  it('inverts a plan review through the reviewPlan capability', async () => {
    const reviewPlan = vi.fn(async (): Promise<PlanDecision> => ({ kind: 'approve' }));
    const engine = new FakeEngine(async (_req, client) => {
      const decision = await client.invoke('reviewPlan', {
        plan: { summary: 's', steps: [] } as unknown as Plan,
        complexity: 'complex',
      });
      client.onEvent({ type: 'answer-delta', text: decision.kind });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const deltas: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => {
        if (e.type === 'answer-delta') deltas.push(e.text);
      },
      ...makeClientHost({ toolNames: [], executeTool: async () => '', reviewPlan }),
    });
    await handle.result;
    expect(reviewPlan).toHaveBeenCalledWith(expect.objectContaining({ summary: 's' }), 'complex');
    expect(deltas).toEqual(['approve']);
  });

  it('inverts an executor check-in through the confirmContinue capability', async () => {
    const confirmContinue = vi.fn(async (): Promise<ContinueDecision> => ({ kind: 'stop' }));
    const engine = new FakeEngine(async (_req, client) => {
      const decision = await client.invoke('confirmContinue', {
        info: { stepsDone: 10, secondsElapsed: 42 },
      });
      client.onEvent({ type: 'answer-delta', text: decision.kind });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const deltas: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => {
        if (e.type === 'answer-delta') deltas.push(e.text);
      },
      ...makeClientHost({ toolNames: [], executeTool: async () => '', confirmContinue }),
    });
    await handle.result;
    expect(confirmContinue).toHaveBeenCalledWith(
      expect.objectContaining({ stepsDone: 10, secondsElapsed: 42 })
    );
    expect(deltas).toEqual(['stop']);
  });

  it('does not advertise the check-in capability when the client lacks it', async () => {
    const engine = new FakeEngine(async (_req, client) => {
      expect(client.capabilities).not.toContain('confirmContinue');
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    await handle.result;
  });

  it('keeps two concurrent invokes for one run distinct (no resolver clobber)', async () => {
    // Each invoke is keyed by its own call id, so issuing two for one run
    // resolves both; keying by runId alone would overwrite the first resolver
    // and hang it.
    const reviewPlan = vi.fn(
      async (_plan: Plan, complexity: string): Promise<PlanDecision> =>
        complexity === 'simple' ? { kind: 'approve' } : { kind: 'revise', comment: 'c' }
    );
    const engine = new FakeEngine(async (_req, client) => {
      const [a, b] = await Promise.all([
        client.invoke('reviewPlan', {
          plan: { summary: 'a', steps: [] } as unknown as Plan,
          complexity: 'simple',
        }),
        client.invoke('reviewPlan', {
          plan: { summary: 'b', steps: [] } as unknown as Plan,
          complexity: 'complex',
        }),
      ]);
      client.onEvent({ type: 'answer-delta', text: `${a.kind}/${b.kind}` });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const deltas: string[] = [];
    const handle = sidecar.startRun(request(), {
      onEvent: (e) => {
        if (e.type === 'answer-delta') deltas.push(e.text);
      },
      ...makeClientHost({ toolNames: [], executeTool: async () => '', reviewPlan }),
    });
    await handle.result;
    expect(deltas).toEqual(['approve/revise']);
  });

  it('rejects an invoke left pending when the run settles', async () => {
    // The engine fires a tool invoke but the run settles before the parent
    // answers it: the child must reject the orphaned promise rather than leak it.
    // The parent's host never resolves, so only the run-settle cleanup can.
    let toolPromise: Promise<string> | undefined;
    const engine = new FakeEngine(async (_req, client) => {
      toolPromise = client.invoke('tool', { tool: 'read', args: { path: 'a.ts' } });
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: ['read'], executeTool: () => new Promise<string>(() => {}) }),
    });
    await handle.result;
    await expect(toolPromise!).rejects.toBeInstanceOf(RunCancelledError);
  });

  it('does not advertise the plan-review capability when the client lacks it', async () => {
    const engine = new FakeEngine(async (_req, client) => {
      expect(client.capabilities).not.toContain('reviewPlan');
      return REPLY;
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    await expect(handle.result).resolves.toEqual(REPLY);
  });

  it('rethrows a RunFailedError with its step and hint preserved', async () => {
    const engine = new FakeEngine(async () => {
      throw new RunFailedError('plan', 'model not found', 'pull the model');
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    const err = await handle.result.catch((e) => e as RunFailedError);
    expect(err).toBeInstanceOf(RunFailedError);
    expect(err.step).toBe('plan');
    expect(err.hint).toBe('pull the model');
  });

  it('rethrows a RunCancelledError', async () => {
    const engine = new FakeEngine(async () => {
      throw new RunCancelledError();
    });
    const { sidecar } = connect(engine);
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    await expect(handle.result).rejects.toBeInstanceOf(RunCancelledError);
  });

  it('forwards the child engine debug entries to the parent onDebug', async () => {
    // The child injects a debug sink that posts each entry over the wire; the
    // parent hands it to onDebug, which the engine factory points at the output
    // channel. An engine that emits during a run has its entry surfaced here.
    const seen: DebugEntry[] = [];
    const engine = new FakeEngine(async (_req, client) => {
      emitDebug({ source: 'provider', label: 'request', detail: 'raw' });
      client.onEvent({ type: 'done', reply: REPLY });
      return REPLY;
    });
    const { sidecar } = connect(engine, (entry) => seen.push(entry));
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    await handle.result;
    expect(seen).toContainEqual({ source: 'provider', label: 'request', detail: 'raw' });
  });

  it('round-trips listModels and startupWarnings', async () => {
    const { sidecar } = connect(new FakeEngine(async () => REPLY));
    await expect(sidecar.listModels()).resolves.toEqual([
      { id: 'auto', label: 'Auto', available: true },
    ]);
    await expect(sidecar.startupWarnings()).resolves.toEqual(['ollama down']);
  });
});

/**
 * Drive a SidecarEngine over a hand-controlled channel: capture what it posts,
 * and feed it child messages and a close on demand. Lets the readiness, version,
 * and timeout behaviour be exercised without a child runtime sending `ready`.
 */
function manual(): {
  sidecar: SidecarEngine;
  posted: ParentMessage[];
  emit: (m: ChildMessage) => void;
  close: (reason: string) => void;
} {
  let onMsg: (m: ChildMessage) => void = () => {};
  let onClose: (r: string) => void = () => {};
  const posted: ParentMessage[] = [];
  const channel: SidecarChannel = {
    post: (m) => posted.push(m),
    onMessage: (h) => {
      onMsg = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    dispose: () => {},
  };
  const getConfig = (): RuntimeConfig =>
    ({ planApproval: 'auto' } as unknown as RuntimeConfig);
  return {
    sidecar: new SidecarEngine(channel, getConfig),
    posted,
    emit: (m) => onMsg(m),
    close: (r) => onClose(r),
  };
}

const ready = (version: number): ChildMessage => ({
  t: 'ready',
  protocolVersion: version,
  kind: 'local',
});

function startBare(sidecar: SidecarEngine): Promise<Reply> {
  return sidecar.startRun(request(), {
    onEvent: () => {},
    ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
  }).result;
}

describe('sidecar readiness and version handshake', () => {
  it('holds the first run until the child reports ready', async () => {
    const { sidecar, posted, emit } = manual();
    void startBare(sidecar);
    await Promise.resolve();
    // Config was sent, but no run started yet - the child has not said it is up.
    expect(posted.some((m) => m.t === 'start')).toBe(false);

    emit(ready(PROTOCOL_VERSION));
    await Promise.resolve();
    expect(posted.some((m) => m.t === 'start')).toBe(true);
  });

  it('rejects a run when the child speaks a different protocol version', async () => {
    const { sidecar, posted, emit } = manual();
    const result = startBare(sidecar);
    emit(ready(1));
    const err = await result.catch((e) => e as RunFailedError);
    expect(err).toBeInstanceOf(RunFailedError);
    expect(err.message).toContain('out of date');
    // Never started the run against a mismatched child.
    expect(posted.some((m) => m.t === 'start')).toBe(false);
  });

  it('fails the first run if the child never reports ready', async () => {
    vi.useFakeTimers();
    try {
      const { sidecar } = manual();
      const result = startBare(sidecar);
      const settled = result.catch((e) => e as RunFailedError);
      await vi.advanceTimersByTimeAsync(11_000);
      const err = await settled;
      expect(err).toBeInstanceOf(RunFailedError);
      expect(err.message).toContain('did not start in time');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a run that was cancelled before the child was ready', async () => {
    const { sidecar, posted, emit } = manual();
    const handle = sidecar.startRun(request(), {
      onEvent: () => {},
      ...makeClientHost({ toolNames: [], executeTool: async () => '' }),
    });
    handle.cancel();
    emit(ready(PROTOCOL_VERSION));
    await expect(handle.result).rejects.toBeInstanceOf(RunCancelledError);
    expect(posted.some((m) => m.t === 'start')).toBe(false);
  });
});

describe('sidecar wire timeouts and probe failures', () => {
  it('times out a query and falls back (empty models, a startup warning)', async () => {
    vi.useFakeTimers();
    try {
      const { sidecar } = manual();
      const models = sidecar.listModels();
      const warnings = sidecar.startupWarnings();
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(models).resolves.toEqual([]);
      const w = await warnings;
      expect(w).toHaveLength(1);
      expect(w[0]).toContain('could not reach the engine sidecar');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a query failure as a startup warning instead of hiding it', async () => {
    const { sidecar, posted, emit } = manual();
    const warnings = sidecar.startupWarnings();
    const q = posted.find((m) => m.t === 'query');
    expect(q).toBeTruthy();
    emit({
      t: 'query-result',
      queryId: (q as { queryId: string }).queryId,
      ok: false,
      error: 'ollama unreachable',
    });
    const w = await warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('ollama unreachable');
  });

  it('answers an orphan invoke (unknown run) with an error result', () => {
    const { posted, emit } = manual();
    emit(ready(PROTOCOL_VERSION));
    emit({
      t: 'invoke',
      runId: 'run-unknown',
      callId: 'c1',
      capability: 'tool',
      payload: { tool: 'read', args: {} },
    });
    const result = posted.find((m) => m.t === 'invoke-result');
    // Rather than dropping it (leaving the child's promise pending forever), the
    // parent answers with a failure so the child settles.
    expect(result).toMatchObject({ t: 'invoke-result', callId: 'c1', ok: false });
  });

  it('fails pending runs and queries when the channel closes', async () => {
    const { sidecar, emit, close } = manual();
    emit(ready(PROTOCOL_VERSION));
    const run = startBare(sidecar);
    const models = sidecar.listModels();
    close('The engine sidecar exited unexpectedly (code 1).');
    await expect(run).rejects.toBeInstanceOf(RunFailedError);
    await expect(models).resolves.toEqual([]);
  });
});

describe('createStreamChannel (NDJSON)', () => {
  it('frames posts as NDJSON and parses incoming lines', async () => {
    const out = new PassThrough();
    const inc = new PassThrough();
    const channel = createStreamChannel(out, inc);
    const received: ChildMessage[] = [];
    channel.onMessage((m) => received.push(m));

    channel.post({ t: 'cancel', runId: 'run-0' });
    const line = await new Promise<string>((r) => out.once('data', (c) => r(c.toString())));
    expect(JSON.parse(line.trim())).toEqual({ t: 'cancel', runId: 'run-0' });

    inc.write(
      `${JSON.stringify({ t: 'event', runId: 'run-0', event: { type: 'answer-delta', text: 'hi' } })}\n`
    );
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0].t).toBe('event');
  });

  it('skips a malformed frame and still reads the next', async () => {
    const out = new PassThrough();
    const inc = new PassThrough();
    const channel = createStreamChannel(out, inc);
    const received: ChildMessage[] = [];
    channel.onMessage((m) => received.push(m));
    inc.write(`not json\n${JSON.stringify({ t: 'ready', protocolVersion: 2, kind: 'local' })}\n`);
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0].t).toBe('ready');
  });

  it('closes when the incoming stream ends', async () => {
    const inc = new PassThrough();
    const channel = createStreamChannel(new PassThrough(), inc);
    let reason = '';
    channel.onClose((r) => {
      reason = r;
    });
    inc.end();
    await new Promise((r) => setImmediate(r));
    expect(reason).toContain('stream ended');
  });
});

describe('traceChannel', () => {
  it('counts messages and bytes both ways and reports on dispose', () => {
    const posted: ParentMessage[] = [];
    let onMsg: (m: ChildMessage) => void = () => {};
    const base: SidecarChannel = {
      post: (m) => posted.push(m),
      onMessage: (h) => {
        onMsg = h;
      },
      onClose: () => {},
      dispose: () => {},
    };
    let stats: ChannelStats | undefined;
    const traced = traceChannel(base, (s) => {
      stats = s;
    });
    const received: ChildMessage[] = [];
    traced.onMessage((m) => received.push(m));

    traced.post({ t: 'cancel', runId: 'r' });
    onMsg({ t: 'ready', protocolVersion: 2, kind: 'local' });
    traced.dispose();

    expect(posted).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(stats).toMatchObject({ sent: 1, received: 1 });
    expect(stats!.bytesSent).toBeGreaterThan(0);
    expect(stats!.bytesReceived).toBeGreaterThan(0);
  });
});
