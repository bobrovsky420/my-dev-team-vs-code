import { describe, it, expect, beforeEach } from 'vitest';
import {
  pickTriageMode,
  currentTriageModeLabel,
  setTriageModeChoice,
} from '../src/ui/triageModeCommands';
import {
  __reset,
  __setConfig,
  __state,
  __setQuickPickResponse,
  window,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

function triageModeSetting(): unknown {
  return __state.configuration.get('myDevTeam.triage.mode');
}

describe('currentTriageModeLabel', () => {
  it('defaults to Classifier and reflects the configured mode', () => {
    expect(currentTriageModeLabel()).toBe('Classifier'); // shipped default
    __setConfig('myDevTeam.triage.mode', 'combined');
    expect(currentTriageModeLabel()).toBe('Combined');
  });
});

describe('setTriageModeChoice', () => {
  it('writes the chosen mode to the setting', async () => {
    await setTriageModeChoice('combined');
    expect(triageModeSetting()).toBe('combined');
  });
});

describe('pickTriageMode', () => {
  it('lists classifier first then combined, and applies the pick', async () => {
    __setQuickPickResponse(1); // "Combined" (classifier is first)
    const label = await pickTriageMode();
    expect(label).toBe('Combined');
    expect(triageModeSetting()).toBe('combined');
    const items = window.showQuickPick.mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((i) => i.label.replace(' (current)', ''))).toEqual([
      'Classifier',
      'Combined',
    ]);
  });

  it('returns undefined for a dismissed picker and writes nothing', async () => {
    __setQuickPickResponse(undefined);
    expect(await pickTriageMode()).toBeUndefined();
    expect(triageModeSetting()).toBeUndefined();
  });
});
