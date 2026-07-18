/**
 * The single "My Dev Team" status-bar button. Hovering it shows a rich popup (a
 * trusted MarkdownString, the same approach as Copilot's status item) with the
 * live model and session token total plus clickable command links; clicking it
 * opens a quick-pick menu with the same two main actions, delegating to the
 * existing select-model and show-usage commands. It folds together what used to
 * be two separate status-bar items (the model picker and the session token
 * counter): the bar itself is just the brand, while the live figures ride in
 * the hover and the menu rows.
 *
 * It keeps the live state both surfaces show: `add` accumulates each finished
 * run's tokens (independent of the opt-in eval log, exactly as the old counter
 * did), and `refresh` re-reads the engine catalogue for the current model's
 * label; each redraws the hover so it never goes stale.
 */
import * as vscode from 'vscode';
import { UsageEntry } from '../client/evalLog';
import {
  TokenSummary,
  addSummary,
  emptySummary,
  formatTokenCount,
  sumUsage,
} from '../client/usageStats';
import { Engine } from '../protocol/engine';
import { settings } from '../config/settings';
import { messages } from '../config/messages';
import { uiLimits } from '../config/uiLimits';
import {
  currentModelLabel,
  SELECT_MODEL_COMMAND_ID,
  SET_API_KEY_COMMAND_ID,
} from './modelCommands';
import {
  currentVerbosityLabel,
  SELECT_VERBOSITY_COMMAND_ID,
} from './verbosityCommands';
import {
  currentTriageModeLabel,
  SELECT_TRIAGE_MODE_COMMAND_ID,
} from './triageModeCommands';
import { SHOW_USAGE_COMMAND_ID } from './usageView';

/** Command id the status-bar button fires to open its menu. */
export const STATUS_MENU_COMMAND_ID = 'myDevTeam.statusMenu';

interface StatusMenuItem extends vscode.QuickPickItem {
  /** The command this row runs when picked. */
  command: string;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly session: TokenSummary = emptySummary();
  private modelLabel: string = settings.model;

  constructor(
    private readonly engine: Engine,
    menuCommandId: string
  ) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      uiLimits.statusBar.priority
    );
    this.item.command = menuCommandId;
    this.item.text = messages.status.statusBar;
    this.renderTooltip();
    this.item.show();
  }

  /** Fold one finished run's per-step usage into the session total. */
  add(usage: readonly UsageEntry[]): void {
    addSummary(this.session, sumUsage(usage));
    this.renderTooltip();
  }

  /**
   * Redraw the hover without re-reading the catalogue, for a plain-setting change
   * the hover reflects (e.g. `myDevTeam.debug`) where `refresh`'s model lookup is
   * unnecessary.
   */
  redrawTooltip(): void {
    this.renderTooltip();
  }

  /** Re-read the catalogue and remember the current model's label for the menu. */
  async refresh(): Promise<void> {
    try {
      this.modelLabel = currentModelLabel(await this.engine.listModels());
    } catch {
      this.modelLabel = settings.model;
    }
    this.renderTooltip();
  }

  /**
   * Build the hover popup: a trusted MarkdownString (so its `command:` links
   * fire) limited to exactly the three commands it links, with theme-icon
   * support for the `$(icon)` codicons. Rebuilt whenever the model label or the
   * token total changes so the figures stay current.
   */
  private renderTooltip(): void {
    const tooltip = new vscode.MarkdownString(
      messages.status.tooltip({
        model: this.modelLabel,
        tokens: formatTokenCount(this.session.totalTokens),
        estimated: this.session.hasEstimates,
        // Read fresh each redraw: verbosity, triage mode, and the debug flag are
        // plain settings, no live state. The debug line is shown only when on.
        verbosity: currentVerbosityLabel(),
        triageMode: currentTriageModeLabel(),
        debug: settings.debug,
        selectModelCommand: SELECT_MODEL_COMMAND_ID,
        selectTriageModeCommand: SELECT_TRIAGE_MODE_COMMAND_ID,
        usageCommand: SHOW_USAGE_COMMAND_ID,
        setKeyCommand: SET_API_KEY_COMMAND_ID,
      }),
      true // supportThemeIcons
    );
    tooltip.isTrusted = {
      enabledCommands: [
        SELECT_MODEL_COMMAND_ID,
        SELECT_TRIAGE_MODE_COMMAND_ID,
        SHOW_USAGE_COMMAND_ID,
        SET_API_KEY_COMMAND_ID,
      ],
    };
    this.item.tooltip = tooltip;
  }

  /**
   * Open the button's menu: pick a row and run its command. The labels carry
   * the live model label and session token total, read at open time.
   */
  async openMenu(): Promise<void> {
    const items: StatusMenuItem[] = [
      {
        label: messages.status.menuModel(this.modelLabel),
        command: SELECT_MODEL_COMMAND_ID,
      },
      {
        label: messages.status.menuUsage(
          formatTokenCount(this.session.totalTokens),
          this.session.hasEstimates
        ),
        command: SHOW_USAGE_COMMAND_ID,
      },
      {
        // Read fresh at open time: triage mode is a plain setting, no live state.
        label: messages.status.menuTriageMode(currentTriageModeLabel()),
        command: SELECT_TRIAGE_MODE_COMMAND_ID,
      },
      {
        // Read fresh at open time: verbosity is a plain setting, no live state.
        label: messages.status.menuVerbosity(currentVerbosityLabel()),
        command: SELECT_VERBOSITY_COMMAND_ID,
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: messages.status.menuPlaceholder,
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
