import { describe, it, expect, beforeEach, vi } from 'vitest';

// The factory's local branch constructs the real agent set; keep Mastra from
// touching a real model.
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = vi.fn();
    stream = vi.fn();
  },
}));

// The sidecar branch forks a child; replace `fork` with a fake so no real
// process spawns. Each fake child records what it was sent and can be killed.
const { forkMock, forkedChildren } = vi.hoisted(() => {
  type FakeChild = {
    sent: unknown[];
    killed: boolean;
    emit: (event: string, ...args: unknown[]) => void;
  };
  const forkedChildren: FakeChild[] = [];
  const forkMock = vi.fn(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const child: FakeChild = {
      sent: [] as unknown[],
      killed: false,
      emit: (event, ...args) => handlers[event]?.(...args),
    };
    forkedChildren.push(child);
    return {
      on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
        handlers[event] = h;
      }),
      send: vi.fn((m: unknown) => child.sent.push(m)),
      kill: vi.fn(() => {
        child.killed = true;
      }),
    };
  });
  return { forkMock, forkedChildren };
});
vi.mock('node:child_process', () => ({ fork: forkMock }));

import { createEngineProvider } from '../src/client/engineFactory';
import { AnonymousAuthProvider } from '../src/client/auth';
import { LocalEngine } from '../src/engine/localEngine';
import { SidecarEngine } from '../src/client/sidecarEngine';
import { DebugChannel } from '../src/client/debugLog';
import { setApiKey } from '../src/client/secrets';
import { __reset, __setConfig, window, secrets } from './mocks/vscode';

const SIDECAR_PATH = '/ext/dist/sidecar.js';

/** The debug channel the provider requires; with `myDevTeam.debug` off (the test
 *  default) the engine tracer is a pass-through, so engine identity is preserved. */
function debug(): DebugChannel {
  return new DebugChannel(window.createOutputChannel('test'));
}

beforeEach(async () => {
  __reset();
  vi.mocked(window.showWarningMessage).mockClear();
  forkMock.mockClear();
  forkedChildren.length = 0;
  // The sidecar secret-source cache is module state; clear it and the env so a
  // test only sees the keys it sets.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  await setApiKey(secrets, 'openai', '');
  await setApiKey(secrets, 'anthropic', '');
  await setApiKey(secrets, 'groq', '');
});

describe('createEngineProvider', () => {
  it('returns the local engine by default and memoises it', () => {
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());
    const first = getEngine();
    expect(first).toBeInstanceOf(LocalEngine);
    expect(first.kind).toBe('local');
    expect(getEngine()).toBe(first);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('falls back to local with one warning while remote is unavailable', () => {
    __setConfig('myDevTeam.engine', 'remote');
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());

    expect(getEngine().kind).toBe('local');
    getEngine();
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain('myDevTeam.engine');
  });

  it('warns again only after switching away and back to remote', () => {
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());
    __setConfig('myDevTeam.engine', 'remote');
    getEngine();
    getEngine();
    __setConfig('myDevTeam.engine', 'local');
    getEngine();
    __setConfig('myDevTeam.engine', 'remote');
    getEngine();

    expect(window.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it('builds and reuses a sidecar engine when selected, and disposes it', () => {
    __setConfig('myDevTeam.engine', 'sidecar');
    const provider = createEngineProvider(SIDECAR_PATH, debug());

    const engine = provider.getEngine();
    expect(engine).toBeInstanceOf(SidecarEngine);
    expect(engine.kind).toBe('sidecar');
    // Forked exactly once and reused on the next request.
    expect(provider.getEngine()).toBe(engine);
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledWith(SIDECAR_PATH, [], expect.anything());
    // It sent the runtime config to the child up front.
    expect(forkedChildren[0].sent.some((m: any) => m.t === 'config')).toBe(true);

    provider.dispose();
    expect(forkedChildren[0].killed).toBe(true);
  });

  it('respawns a fresh child after a crash, then gives up after repeated crashes', () => {
    __setConfig('myDevTeam.engine', 'sidecar');
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());

    expect(getEngine().kind).toBe('sidecar'); // fork 1
    forkedChildren[0].emit('exit', 1, null); // crash
    // The memoised instance was dropped, so the next request forks afresh.
    expect(getEngine().kind).toBe('sidecar'); // fork 2
    expect(forkMock).toHaveBeenCalledTimes(2);

    forkedChildren[1].emit('exit', 1, null);
    expect(getEngine().kind).toBe('sidecar'); // fork 3
    forkedChildren[2].emit('exit', 1, null);

    // Three crashes in the window hits the cap: give up, warn once, fall back.
    expect(getEngine().kind).toBe('local');
    expect(getEngine().kind).toBe('local');
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain('keeps crashing');
  });

  it('re-arms the sidecar after the user switches engine away and back', () => {
    __setConfig('myDevTeam.engine', 'sidecar');
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());
    getEngine();
    forkedChildren[0].emit('exit', 1, null);
    getEngine();
    forkedChildren[1].emit('exit', 1, null);
    getEngine();
    forkedChildren[2].emit('exit', 1, null);
    expect(getEngine().kind).toBe('local'); // gave up

    __setConfig('myDevTeam.engine', 'local');
    getEngine();
    __setConfig('myDevTeam.engine', 'sidecar');
    // Re-armed: a fresh child is forked again.
    expect(getEngine().kind).toBe('sidecar');
    expect(forkMock).toHaveBeenCalledTimes(4);
  });

  it('warns once that the sidecar ignores a SecretStorage-only key', async () => {
    await setApiKey(secrets, 'openai', 'sk-stored'); // stored, no env var
    __setConfig('myDevTeam.engine', 'sidecar');
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());

    getEngine();
    getEngine();
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(window.showWarningMessage).mock.calls[0][0] as string;
    expect(warning).toContain('OpenAI');
    expect(warning).toContain('OPENAI_API_KEY');
  });

  it('does not warn when the key is also in the environment', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    await setApiKey(secrets, 'openai', 'sk-stored');
    __setConfig('myDevTeam.engine', 'sidecar');
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());

    getEngine();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('warns again only after switching away from and back to sidecar', async () => {
    await setApiKey(secrets, 'openai', 'sk-stored');
    const { getEngine } = createEngineProvider(SIDECAR_PATH, debug());
    __setConfig('myDevTeam.engine', 'sidecar');
    getEngine();
    getEngine();
    __setConfig('myDevTeam.engine', 'local');
    getEngine();
    __setConfig('myDevTeam.engine', 'sidecar');
    getEngine();

    expect(window.showWarningMessage).toHaveBeenCalledTimes(2);
  });
});

describe('AnonymousAuthProvider', () => {
  it('supplies the anonymous credential', async () => {
    await expect(new AnonymousAuthProvider().getCredentials()).resolves.toEqual({
      kind: 'anonymous',
    });
  });
});
