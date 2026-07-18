import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the agent core from touching a real model when the wired handler runs.
const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    generate = generateMock;
  },
}));

import { activate, deactivate } from '../src/extension';
import { EVAL_LOG_FILENAME } from '../src/client/evalLog';
import {
  __reset,
  __setConfig,
  __state,
  chat,
  ChatResultFeedbackKind,
  secrets,
  Uri,
} from './mocks/vscode';

// activate() fires the Ollama startup health check; stub fetch so tests never
// touch the network. The fake server reports no pulled models, which the
// check only ever turns into a warning - activation must not depend on it.
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) }));
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  __reset();
  generateMock.mockReset();
  fetchMock.mockClear();
  vi.mocked(chat.createChatParticipant).mockClear();
});

function fakeContext() {
  return {
    subscriptions: [] as unknown[],
    globalStorageUri: Uri.file('/global'),
    extensionUri: Uri.file('/ext'),
    secrets,
  };
}

describe('activate', () => {
  it('creates the chat participant and registers no editor-wide tools', () => {
    const context = fakeContext();
    activate(context as any);

    // The workspace tools are private to @devteam now: they are dispatched
    // through the run's ClientHost, not contributed as editor-wide Language
    // Model Tools, so nothing is registered with `vscode.lm.registerTool`.
    expect([...__state.registeredTools.keys()]).toHaveLength(0);
    expect(chat.createChatParticipant).toHaveBeenCalledWith(
      'myDevTeam.agent',
      expect.any(Function)
    );
    // The debug output channel + the approval command + the plan-review command +
    // the continue-review (check-in) command + the plan-preview seam (its content
    // provider and the change emitter) + the MCP hub disposable + the run-mirror
    // terminal + the participant, plus the unified status-bar button
    // and its status-menu command, the engine-provider disposable, the
    // select-model, set-api-key, select-verbosity, and select-triage-mode
    // commands, the config-change listener, the show-usage command, the "Compact
    // now" command, and the five editor entry points (three shim commands + the
    // code-action and CodeLens providers), get pushed for disposal.
    expect(context.subscriptions).toHaveLength(24);
    expect(__state.registeredCommands.has('myDevTeam.approval')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.compactNow')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.planReview')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.continueReview')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.statusMenu')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.selectModel')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.setApiKey')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.selectVerbosity')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.selectTriageMode')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.showUsage')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.quickQuestion')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.fixDiagnostic')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.explainSelection')).toBe(true);
    expect(__state.registeredCommands.has('myDevTeam.writeOrRepairTests')).toBe(true);
  });

  it('fires the Ollama health check without blocking activation', () => {
    activate(fakeContext() as any);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tags'),
      expect.anything()
    );
  });

  it('wires a feedback listener that classifies helpful vs unhelpful', () => {
    const participant = {
      followupProvider: undefined as unknown,
      onDidReceiveFeedback: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(chat.createChatParticipant).mockReturnValueOnce(participant as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    activate(fakeContext() as any);

    const feedbackCb = participant.onDidReceiveFeedback.mock.calls[0][0] as (
      fb: unknown
    ) => void;
    feedbackCb({ kind: ChatResultFeedbackKind.Helpful });
    feedbackCb({ kind: ChatResultFeedbackKind.Unhelpful });

    expect(logSpy).toHaveBeenCalledWith('[My Dev Team] feedback: helpful');
    expect(logSpy).toHaveBeenCalledWith('[My Dev Team] feedback: unhelpful');
    logSpy.mockRestore();
  });

  it('forwards feedback to the eval log, paired through the result metadata', async () => {
    __setConfig('myDevTeam.telemetry.evalLog', true);
    const participant = {
      followupProvider: undefined as unknown,
      onDidReceiveFeedback: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(chat.createChatParticipant).mockReturnValueOnce(participant as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    activate(fakeContext() as any);

    const feedbackCb = participant.onDidReceiveFeedback.mock.calls[0][0] as (
      fb: unknown
    ) => void;
    feedbackCb({
      kind: ChatResultFeedbackKind.Helpful,
      result: { metadata: { command: 'explain', runId: 'r1', intent: 'planning' } },
    });
    // The record write is fire-and-forget; let its microtasks drain.
    await new Promise((resolve) => setImmediate(resolve));

    const stored = __state.files.get(`/global/${EVAL_LOG_FILENAME}`);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.trim())).toMatchObject({
      record: 'feedback',
      kind: 'helpful',
      runId: 'r1',
      intent: 'planning',
      command: 'explain',
    });
    logSpy.mockRestore();
  });

  it('the wired handler drives the workflow and streams the reply', async () => {
    generateMock.mockResolvedValue({
      object: { intent: 'oneshot', complexity: 'simple', reason: 'simple' },
    });
    const participant = {
      followupProvider: undefined as unknown,
      onDidReceiveFeedback: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(chat.createChatParticipant).mockReturnValueOnce(participant as any);

    activate(fakeContext() as any);
    const handler = vi.mocked(chat.createChatParticipant).mock.calls[0][1] as Function;

    const stream = { markdown: vi.fn(), progress: vi.fn() };
    await handler(
      { prompt: 'what is x', references: [] },
      { history: [] },
      stream,
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      }
    );

    expect(stream.markdown).toHaveBeenCalled();
    const emitted = stream.markdown.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(emitted).toContain('Detected intent');
  });
});

describe('deactivate', () => {
  it('is a no-op that does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
