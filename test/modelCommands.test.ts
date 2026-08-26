import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleModelChatCommand,
  pickModel,
  resolveModelArg,
  currentModelLabel,
  runSetApiKeyCommand,
} from '../src/ui/modelCommands';
import { Engine } from '../src/protocol/engine';
import { ModelChoice } from '../src/protocol/types';
import {
  __reset,
  __setConfig,
  __state,
  __setQuickPickResponse,
  __setInputBoxResponse,
  secrets,
  window,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

const choices: ModelChoice[] = [
  { id: 'auto', label: 'Auto', description: 'router', available: true },
  { id: 'provider:anthropic', label: 'Anthropic (best available)', description: 'cloud', available: false },
  { id: 'qwen3-coder', label: 'Qwen3 Coder (Ollama)', description: 'code', available: true },
  { id: 'anthropic-opus', label: 'Claude Opus 5 (Anthropic)', description: 'best', available: false },
];

/** A stub engine that only answers listModels. */
function fakeEngine(list: ModelChoice[] = choices): Engine {
  return {
    kind: 'local',
    startRun: () => {
      throw new Error('not used');
    },
    startupWarnings: async () => [],
    listModels: async () => list,
  };
}

function fakeStream() {
  return { markdown: vi.fn() };
}

function modelSetting(): unknown {
  return __state.configuration.get('myDevTeam.model');
}

function triageSetting(): unknown {
  return __state.configuration.get('myDevTeam.triage.model');
}

describe('resolveModelArg', () => {
  it('matches by id or label, case-insensitively', () => {
    expect(resolveModelArg(choices, 'qwen3-coder')?.id).toBe('qwen3-coder');
    expect(resolveModelArg(choices, 'Claude Opus 5 (Anthropic)')?.id).toBe('anthropic-opus');
    expect(resolveModelArg(choices, 'AUTO')?.id).toBe('auto');
    expect(resolveModelArg(choices, 'nope')).toBeUndefined();
  });

  it('matches a bare provider name to its provider choice', () => {
    expect(resolveModelArg(choices, 'anthropic')?.id).toBe('provider:anthropic');
    expect(resolveModelArg(choices, 'ANTHROPIC')?.id).toBe('provider:anthropic');
  });
});

describe('currentModelLabel', () => {
  it('returns the label of the configured id, falling back to the id', () => {
    __setConfig('myDevTeam.model', 'qwen3-coder');
    expect(currentModelLabel(choices)).toBe('Qwen3 Coder (Ollama)');
    __setConfig('myDevTeam.model', 'unlisted');
    expect(currentModelLabel(choices)).toBe('unlisted');
  });
});

describe('handleModelChatCommand', () => {
  it('pins the work agents from a specific-model argument, leaving triage', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'qwen3-coder', stream as any);
    expect(modelSetting()).toBe('qwen3-coder');
    expect(triageSetting()).toBeUndefined();
    expect(stream.markdown.mock.calls[0][0]).toContain('Qwen3 Coder (Ollama)');
    expect(stream.markdown.mock.calls[0][0]).toContain('triage unchanged');
  });

  it('points the whole team from a bare provider name', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'anthropic', stream as any);
    expect(modelSetting()).toBe('provider:anthropic');
    expect(triageSetting()).toBe('provider:anthropic');
    expect(stream.markdown.mock.calls[0][0]).toContain('Anthropic (best available)');
    expect(stream.markdown.mock.calls[0][0]).toContain('Triage and all agents');
  });

  it('points the whole team from an "auto" argument', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'auto', stream as any);
    expect(modelSetting()).toBe('auto');
    expect(triageSetting()).toBe('auto');
  });

  it('reports an unknown argument without changing the setting', async () => {
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), 'gpt-9', stream as any);
    expect(modelSetting()).toBeUndefined();
    expect(stream.markdown.mock.calls[0][0]).toContain('No model "gpt-9"');
  });

  it('with no argument opens the picker and pins the chosen work model', async () => {
    __setQuickPickResponse(4); // the qwen3-coder (work) entry
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), '   ', stream as any);
    expect(modelSetting()).toBe('qwen3-coder');
    expect(triageSetting()).toBeUndefined();
    expect(stream.markdown.mock.calls[0][0]).toContain('Qwen3 Coder (Ollama)');
  });

  it('with no argument and a dismissed picker writes nothing', async () => {
    __setQuickPickResponse(undefined);
    const stream = fakeStream();
    await handleModelChatCommand(fakeEngine(), '', stream as any);
    expect(modelSetting()).toBeUndefined();
    expect(stream.markdown).not.toHaveBeenCalled();
  });
});

// Picker layout (separators included), used to address rows by index below:
//   0 sep "everything"   1 auto(both)        2 provider:anthropic(both)
//   3 sep "specific"     4 qwen3-coder(work) 5 anthropic-opus(work)
//   6 sep "triage"       7 auto(triage)      8 provider:anthropic(triage)
//   9 qwen3-coder(triage) 10 anthropic-opus(triage)
describe('pickModel', () => {
  it('pins a specific work model and returns the work scope', async () => {
    __setQuickPickResponse(5); // anthropic-opus (work)
    const picked = await pickModel(fakeEngine());
    expect(picked).toEqual({ label: 'Claude Opus 5 (Anthropic)', scope: 'work' });
    expect(modelSetting()).toBe('anthropic-opus');
    expect(triageSetting()).toBeUndefined();
  });

  it('points the whole team when a provider row is picked', async () => {
    __setQuickPickResponse(2); // provider:anthropic (both)
    const picked = await pickModel(fakeEngine());
    expect(picked?.scope).toBe('both');
    expect(modelSetting()).toBe('provider:anthropic');
    expect(triageSetting()).toBe('provider:anthropic');
  });

  it('sets triage alone from the advanced group', async () => {
    __setQuickPickResponse(9); // qwen3-coder (triage)
    const picked = await pickModel(fakeEngine());
    expect(picked?.scope).toBe('triage');
    expect(triageSetting()).toBe('qwen3-coder');
    expect(modelSetting()).toBeUndefined();
  });

  it('returns undefined for a dismissed picker', async () => {
    __setQuickPickResponse(undefined);
    expect(await pickModel(fakeEngine())).toBeUndefined();
    expect(modelSetting()).toBeUndefined();
  });

  it('shows the disabled detail for a disabled choice', async () => {
    const list: ModelChoice[] = [
      { id: 'auto', label: 'Auto', description: 'router', available: true },
      {
        id: 'qwen3-coder',
        label: 'Qwen3 Coder (Ollama)',
        description: 'code',
        available: false,
        disabled: true,
      },
    ];
    __setQuickPickResponse(undefined);
    await pickModel(fakeEngine(list));
    const items = window.showQuickPick.mock.calls[0][0] as {
      choice?: ModelChoice;
      detail?: string;
    }[];
    const coder = items.find((i) => i.choice?.id === 'qwen3-coder' && i.detail)!;
    expect(coder.detail).toContain('Disabled');
  });
});

describe('runSetApiKeyCommand', () => {
  it('stores the entered key for the chosen provider', async () => {
    __setQuickPickResponse(0); // OpenAI
    __setInputBoxResponse('sk-test');
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.get('myDevTeam.openai.apiKey')).toBe('sk-test');
    expect(window.showInformationMessage).toHaveBeenCalled();
  });

  it('stores the entered key for Groq', async () => {
    __setQuickPickResponse(2); // Groq
    __setInputBoxResponse('gsk-test');
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.get('myDevTeam.groq.apiKey')).toBe('gsk-test');
  });

  it('does nothing when the provider pick is dismissed', async () => {
    __setQuickPickResponse(undefined);
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.size).toBe(0);
  });

  it('does nothing when the key input is dismissed', async () => {
    __setQuickPickResponse(0);
    __setInputBoxResponse(undefined);
    await runSetApiKeyCommand(secrets);
    expect(__state.secrets.size).toBe(0);
  });
});

