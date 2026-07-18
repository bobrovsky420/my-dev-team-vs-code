import { describe, it, expect, beforeEach } from 'vitest';
import { StatusBar, STATUS_MENU_COMMAND_ID } from '../src/ui/statusBar';
import { SELECT_MODEL_COMMAND_ID } from '../src/ui/modelCommands';
import { SELECT_TRIAGE_MODE_COMMAND_ID } from '../src/ui/triageModeCommands';
import { SHOW_USAGE_COMMAND_ID } from '../src/ui/usageView';
import { Engine } from '../src/protocol/engine';
import { ModelChoice } from '../src/protocol/types';
import { SET_API_KEY_COMMAND_ID } from '../src/ui/modelCommands';
import {
  __reset,
  __setConfig,
  __state,
  __setQuickPickResponse,
  commands,
  window,
  MarkdownString,
} from './mocks/vscode';

beforeEach(() => {
  __reset();
});

const choices: ModelChoice[] = [
  { id: 'auto', label: 'Auto', description: 'router', available: true },
  { id: 'qwen3-coder', label: 'Qwen3 Coder (Ollama)', description: 'code', available: true },
];

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

/** The single status-bar item the constructor created. */
function theItem() {
  return __state.statusBarItems[0];
}

/** The labels of the menu items passed to the last showQuickPick call. */
function lastMenuLabels(): string[] {
  const items = window.showQuickPick.mock.calls.at(-1)![0] as Array<{ label: string }>;
  return items.map((i) => i.label);
}

describe('StatusBar', () => {
  it('creates one branded button bound to the menu command', () => {
    new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    expect(__state.statusBarItems).toHaveLength(1);
    expect(theItem().command).toBe(STATUS_MENU_COMMAND_ID);
    expect(theItem().text).toContain('My Dev Team');
  });

  it('shows the active model label in the menu and runs select-model when picked', async () => {
    __setConfig('myDevTeam.model', 'qwen3-coder');
    __state.registeredCommands.set(SELECT_MODEL_COMMAND_ID, () => {});
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    await bar.refresh();

    __setQuickPickResponse(0); // the "Select model" row
    await bar.openMenu();

    expect(lastMenuLabels()[0]).toContain('Qwen3 Coder (Ollama)');
    expect(commands.executeCommand).toHaveBeenCalledWith(SELECT_MODEL_COMMAND_ID);
  });

  it('accumulates run usage into the menu total and opens the report when picked', async () => {
    __state.registeredCommands.set(SHOW_USAGE_COMMAND_ID, () => {});
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    bar.add([{ step: 'execute', inputTokens: 200, outputTokens: 150 }]);

    __setQuickPickResponse(1); // the "Token usage" row
    await bar.openMenu();

    const usageLabel = lastMenuLabels()[1];
    expect(usageLabel).toContain('350'); // 200 in + 150 out, exact under 1,000
    expect(usageLabel).toContain('this session');
    expect(commands.executeCommand).toHaveBeenCalledWith(SHOW_USAGE_COMMAND_ID);
  });

  it('runs nothing when the menu is dismissed', async () => {
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    __setQuickPickResponse(undefined);
    await bar.openMenu();
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('hovers a trusted markdown tooltip with command links for each action', async () => {
    __setConfig('myDevTeam.model', 'qwen3-coder');
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    await bar.refresh();

    const tooltip = theItem().tooltip as MarkdownString;
    expect(tooltip).toBeInstanceOf(MarkdownString);
    expect(tooltip.supportThemeIcons).toBe(true);
    // Trusted, but only for the commands it links - nothing else.
    expect(tooltip.isTrusted).toEqual({
      enabledCommands: [
        SELECT_MODEL_COMMAND_ID,
        SELECT_TRIAGE_MODE_COMMAND_ID,
        SHOW_USAGE_COMMAND_ID,
        SET_API_KEY_COMMAND_ID,
      ],
    });
    expect(tooltip.value).toContain('Qwen3 Coder (Ollama)');
    // The current output mode (verbosity) rides in the hover alongside the model.
    expect(tooltip.value).toContain('Output mode: **Verbose**');
    // The current routing (triage) mode rides in the hover too.
    expect(tooltip.value).toContain('Routing: **Classifier**');
    // A separator under the title and another before the action links.
    expect((tooltip.value.match(/\n---\n/g) ?? []).length).toBe(2);
    expect(tooltip.value).toContain(`command:${SELECT_MODEL_COMMAND_ID}`);
    expect(tooltip.value).toContain(`command:${SELECT_TRIAGE_MODE_COMMAND_ID}`);
    expect(tooltip.value).toContain(`command:${SHOW_USAGE_COMMAND_ID}`);
    expect(tooltip.value).toContain(`command:${SET_API_KEY_COMMAND_ID}`);
    // Each link carries a title so the hover shows meaningful text, not the URI.
    expect(tooltip.value).toContain('"Choose the model for @devteam"');
    // With myDevTeam.debug off (the default), no debug line is shown.
    expect(tooltip.value).not.toContain('Debug mode');
  });

  it('shows a "Debug mode: on" line in the hover only while myDevTeam.debug is on', () => {
    __setConfig('myDevTeam.debug', true);
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    expect((theItem().tooltip as MarkdownString).value).toContain('Debug mode: **on**');

    // Flipping it off and redrawing drops the line again.
    __setConfig('myDevTeam.debug', false);
    bar.redrawTooltip();
    expect((theItem().tooltip as MarkdownString).value).not.toContain('Debug mode');
  });

  it('reflects the combined routing mode in the hover when the setting is set', async () => {
    __setConfig('myDevTeam.triage.mode', 'combined');
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    const tooltip = theItem().tooltip as MarkdownString;
    expect(tooltip.value).toContain('Routing: **Combined**');
  });

  it('offers a routing-mode row and runs select-triage-mode when picked', async () => {
    __state.registeredCommands.set(SELECT_TRIAGE_MODE_COMMAND_ID, () => {});
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);

    __setQuickPickResponse(2); // model(0), usage(1), routing(2), output(3)
    await bar.openMenu();

    expect(lastMenuLabels()[2]).toContain('Routing mode');
    expect(lastMenuLabels()[2]).toContain('Classifier');
    expect(commands.executeCommand).toHaveBeenCalledWith(SELECT_TRIAGE_MODE_COMMAND_ID);
  });

  it('redraws the hover token total as runs accumulate', () => {
    const bar = new StatusBar(fakeEngine(), STATUS_MENU_COMMAND_ID);
    bar.add([{ step: 'execute', inputTokens: 200, outputTokens: 150 }]);
    const tooltip = theItem().tooltip as MarkdownString;
    expect(tooltip.value).toContain('350'); // 200 in + 150 out
  });
});
