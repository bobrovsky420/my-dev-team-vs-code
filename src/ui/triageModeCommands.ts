/**
 * Request-routing (triage mode) UI: the command-palette picker and the
 * status-bar menu row/hover link. The mode is the `myDevTeam.triage.mode`
 * setting - `classifier` (the cheap triage step, then the answerer or planner)
 * or `combined` (one responder that triages and answers-or-plans in a single
 * call). Unlike verbosity this is not a pure rendering choice: the engine reads
 * it live (through the runtime-config seam) and routes accordingly, so a change
 * takes effect on the next run with no run in flight.
 */
import * as vscode from 'vscode';
import { settings } from '../config/settings';
import { messages } from '../config/messages';

const CONFIG_SECTION = 'myDevTeam';
const TRIAGE_MODE_KEY = 'triage.mode';

type TriageMode = 'classifier' | 'combined';

/** The two modes, in the order the picker lists them. */
const MODES: readonly TriageMode[] = ['classifier', 'combined'];

/** Command id the status-bar menu and palette use to open the routing picker. */
export const SELECT_TRIAGE_MODE_COMMAND_ID = 'myDevTeam.selectTriageMode';

/** Persist the chosen mode to the user (global) settings. */
export async function setTriageModeChoice(mode: TriageMode): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(TRIAGE_MODE_KEY, mode, vscode.ConfigurationTarget.Global);
}

/** The human label for the currently-selected mode (for the status-bar menu). */
export function currentTriageModeLabel(): string {
  return messages.triageMode.label(settings.triageMode);
}

interface TriageModeQuickPickItem extends vscode.QuickPickItem {
  mode: TriageMode;
}

/**
 * Open the routing-mode quick pick and apply the choice. Returns the applied
 * mode's label, or undefined when dismissed.
 */
export async function pickTriageMode(): Promise<string | undefined> {
  const current = settings.triageMode;
  const items: TriageModeQuickPickItem[] = MODES.map((mode) => ({
    label:
      messages.triageMode.label(mode) +
      (mode === current ? messages.triageMode.currentSuffix : ''),
    detail: messages.triageMode.detail(mode),
    mode,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: messages.triageMode.pickerPlaceholder,
  });
  if (!picked) {
    return undefined;
  }
  await setTriageModeChoice(picked.mode);
  return messages.triageMode.label(picked.mode);
}
