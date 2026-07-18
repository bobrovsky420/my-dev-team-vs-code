/**
 * User-facing copy for the chat UI: error text and the markdown templates
 * the reply renderer uses. Kept out of the logic so the wording can be tuned
 * without editing control flow. Functions take only the dynamic bits; static
 * prose lives here.
 *
 * Knows nothing about agents and almost nothing about models: the error
 * templates render a detail the protocol delivered, and the troubleshooting
 * hints are templates the LocalEngine fills in - which model is routed where
 * is engine knowledge the client does not have. The exception is the `model`
 * section: model selection is a user-facing choice (the user picks one and is
 * told which ran), so those labels travel on the protocol and this copy frames
 * them.
 */
import type { ModelSelection, ProgressStatus } from '../protocol/types';
import { providerDescriptor, type ProviderName } from './providers';

/**
 * Wrap untrusted content (a command, a file path, a written-file snippet) in a
 * fenced code block whose backtick run is longer than any run inside the
 * content, so the content cannot break out of the fence and inject markdown.
 * `min` is the baseline fence length (3 for a plain block, 4 where a snippet
 * may itself contain a triple-backtick fence).
 */
function fence(content: string, min: number): string {
  const longestRun = (content.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  );
  const ticks = '`'.repeat(Math.max(min, longestRun + 1));
  return `${ticks}\n${content}\n${ticks}`;
}

/**
 * The marker appended to text cut short for display, on its own line so it never
 * runs into the last surviving line. One copy, since the client truncates inlined
 * text - attachments, history turns, instruction/skill/MCP bodies, the read
 * tool's output - in several places and they should read identically.
 */
export const TRUNCATED_SUFFIX = '\n. . . (truncated)';

/**
 * Cut `text` to at most `maxChars` characters for display, appending
 * `TRUNCATED_SUFFIX` when it was over. The budget stays the caller's (each reads
 * its own `settings.*` cap); this only shares the cut-and-mark, so every place
 * that inlines bounded text does it the same way. Returns the text unchanged when
 * it already fits.
 */
export function truncateForDisplay(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + TRUNCATED_SUFFIX : text;
}

export const messages = {
  /**
   * Hint the LocalEngine appends to a step failure, naming the model the
   * router actually selected for the failing agent and the endpoint the
   * provider wiring actually uses, so the troubleshooting text can never
   * drift from either. Travels to the UI as the protocol error's `hint`.
   */
  ollamaHint: (endpoint: string, model: string) =>
    `Is Ollama running on ${endpoint} with \`${model}\` pulled?\n\n`,

  /**
   * Hint for a step failure whose agent used the local llama.cpp provider: the
   * keyless analogue of the Ollama hint, pointing at the resolved `llama-server`
   * endpoint instead of a missing API key.
   */
  llamacppHint: (endpoint: string) =>
    `Is a llama.cpp server (llama-server) running on ${endpoint} with a model ` +
    `loaded? Start one (install llama-server from llama.cpp) or set ` +
    `"myDevTeam.llamacpp.endpoint" to its address, then try again.\n\n`,

  /**
   * Hint appended to a step failure whose agent used a cloud model: the model
   * needs an API key. The provider names which environment-variable fallback
   * applies. Travels to the UI as the protocol error's `hint`, like the Ollama
   * one.
   */
  cloudKeyHint: (label: string, provider: ProviderName) => {
    // The env var name comes from the provider registry, so a newly wired cloud
    // provider needs no edit here (and the hint can never name a stale var).
    const envVar = providerDescriptor(provider).envKey ?? 'provider API key';
    return (
      `\`${label}\` needs an API key. Set the ${envVar} environment variable ` +
      `(in the environment VS Code is launched from), or - for the local ` +
      `engine - run the "My Dev Team: Set API Key" command, then try again.\n\n`
    );
  },

  /**
   * Hint appended when a step failed because the provider kept rate-limiting
   * the request even after the automatic retries. Points at the throttle
   * setting so the user can stay under their quota. Travels to the UI as the
   * protocol error's `hint`.
   */
  rateLimitHint: (label: string) =>
    `\`${label}\` was rate limited by its provider and the automatic retries ` +
    `were exhausted. Lower the request rate with the ` +
    `"myDevTeam.provider.requestsPerMinute" setting, or upgrade your provider ` +
    `plan, then try again.\n\n`,

  /**
   * Copy for model selection: the "which model ran" line in the reply, and the
   * `/model` picker. This is the one place the UI names a concrete model - the
   * user chose it (or asked what Auto picked), so the identity is deliberately
   * surfaced here rather than hidden like the rest of the engine internals.
   */
  model: {
    /** The "Auto" choice shown first in the picker. */
    autoLabel: 'Auto',
    autoDescription: 'Let My Dev Team pick the best available model for each step.',
    /** A "best model within this provider" choice in the picker. */
    providerLabel: (provider: string) => `${provider} (best available)`,
    providerDescription: (provider: string) =>
      `Use ${provider} models; the best one is picked per task.`,
    /** Suffix marking the model that is currently selected, in the picker. */
    currentSuffix: ' (current)',
    /**
     * Separator headers grouping the picker. The first group's rows point the
     * whole team (triage + the work agents) at one provider/Auto; the second
     * pins a single model for the work agents only; the third overrides triage
     * alone, for the rare split setup.
     */
    everythingSeparator: 'Use one provider for everything (triage + agents)',
    specificModelSeparator: 'Or pin one model (agents only)',
    triageSeparator: 'Triage only (advanced)',
    /** Prefix marking a picker row that sets the triage model alone. */
    triageLabel: (label: string) => `Triage: ${label}`,
    /** Detail shown on a picker entry whose model cannot run yet. */
    unavailableDetail: 'Not available - set its API key or pull the model first.',
    /**
     * Detail shown on a picker entry switched off by config (the build's floor
     * or your `myDevTeam.disabled*` settings); it never runs even if pinned.
     */
    disabledDetail: 'Disabled by configuration - it will not run.',
    /** Placeholder in the `/model` quick pick. */
    pickerPlaceholder: 'Choose models for @devteam (the top rows set the whole team)',
    /** Reply to a `/model` turn that pointed the whole team at one provider/Auto. */
    confirmationBoth: (label: string) =>
      `Triage and all agents set to **${label}**. It applies to your next @devteam request.`,
    /** Reply to a `/model` turn that pinned the work agents' model (triage unchanged). */
    confirmation: (label: string) =>
      `All agents set to **${label}** (triage unchanged). It applies to your next @devteam request.`,
    /** Reply to a `/model` turn that set the triage model alone. */
    confirmationTriage: (label: string) =>
      `Triage set to **${label}**. It applies to your next @devteam request.`,
    /** The reply when `/model <name>` named something not in the catalogue. */
    unknown: (name: string) =>
      `No model "${name}". Run /model with no argument to pick from the list.`,
    /**
     * The "which model ran" line under the triage block. In pinned mode it
     * names the chosen model; in Auto mode it lists the work agents' models so
     * the user sees what Auto picked (triage is always a fast local model and
     * is omitted to keep the line short). The **executor** is omitted here on
     * purpose: its model is sized by the planner's post-exploration complexity,
     * settled only once the plan is drafted, so reporting it in this upfront
     * block (which renders before the plan) would force the streamed output to
     * retract an already-shown model. It rides in the execution header instead
     * (see `execution.header`), where its value is final and the render stays
     * append-only.
     */
    block: (selection: ModelSelection): string => {
      const roleNames: Record<string, string> = {
        plan: 'Planner',
        answer: 'Answerer',
        execute: 'Executor',
      };
      // Normally the executor is omitted here (its tier settles late, so showing
      // it upfront would force a retraction) - it rides in the execution header.
      // But the direct route has no plan/answer step, so the executor is the only
      // working model and its tier is settled (a direct change is simple); fall
      // back to it so the line is not empty.
      const nonExecutor = selection.models.filter(
        (m) => m.step !== 'triage' && m.step !== 'execute'
      );
      const work =
        nonExecutor.length > 0
          ? nonExecutor
          : selection.models.filter((m) => m.step === 'execute');
      if (selection.mode === 'pinned') {
        const label = (work[0] ?? selection.models[0])?.label ?? '';
        return `**Model:** ${label} _(pinned)_\n\n`;
      }
      const parts = work.map((m) => `${roleNames[m.step] ?? m.step}: ${m.label}`);
      if (selection.mode === 'provider') {
        return `**Model:** ${selection.provider ?? 'Provider'} - ${parts.join(', ')} _(provider)_\n\n`;
      }
      return `**Model:** Auto - ${parts.join(', ')}\n\n`;
    },
    /** Prompt for the Set API Key command's provider pick. */
    setKeyProviderPlaceholder: 'Which provider is the API key for?',
    /** Prompt for the Set API Key command's key input. */
    setKeyInputPrompt: (provider: string) =>
      `Paste your ${provider} API key (stored securely; used by the local engine; leave empty to clear)`,
    /** Confirmation toast after a key is stored or cleared. */
    keyStored: (provider: string) => `My Dev Team: ${provider} API key stored.`,
    keyCleared: (provider: string) => `My Dev Team: ${provider} API key cleared.`,
  },

  /**
   * Token-usage copy: the per-reply line, the status-bar session counter, and
   * the "Show Token Usage" report. The counts are already formatted compactly
   * by usageStats.formatTokenCount before they reach these templates - this is
   * only the framing. The `~` prefix marks a figure that includes a
   * length-based estimate (a model call the provider gave no counts for).
   */
  changes: {
    /**
     * The `**Changes:**` line appended under a reply that wrote files (gated by
     * the setting; omitted when nothing changed), e.g.
     * "1 file changed, +12 -0" or "4 files changed, +120 -30".
     */
    summary: (files: number, added: number, removed: number) =>
      `\n\n**Changes:** ${files} ${files === 1 ? 'file' : 'files'} changed, ` +
      `+${added} -${removed}`,
  },

  usage: {
    /** The `**Tokens:**` line appended under a reply (gated by the setting). */
    chatLine: (input: string, output: string, estimated: boolean) =>
      `\n\n**Tokens:** ${estimated ? '~' : ''}${input} in / ${output} out`,
    /** The whole "Show Token Usage" report when no runs have been recorded. */
    empty:
      '# My Dev Team - token usage\n\n' +
      'No runs have been recorded yet. Turn on **myDevTeam.telemetry.evalLog** ' +
      'to collect per-run token statistics (route, per-step model, and token ' +
      'counts) for analysis here. Nothing leaves your machine.\n',
    /** Header of the usage report; `runs` is how many runs it summarizes. */
    reportHeader: (runs: number) =>
      `# My Dev Team - token usage\n\n_${runs} run${runs === 1 ? '' : 's'} recorded._\n`,
  },

  /**
   * Copy for the single "My Dev Team" status-bar button: its text, the rich
   * hover (a trusted MarkdownString with command links, like Copilot's), and
   * the quick-pick menu a click opens. The one item replaces the former
   * separate model and token-counter items: the bar is just the brand, and the
   * live model label and running session token total ride in the hover and the
   * two menu rows.
   */
  status: {
    /** The status-bar button text - the brand, no live figures. */
    statusBar: '$(rocket) My Dev Team',
    /**
     * The rich hover shown over the button: the live model and session token
     * total, then clickable command links. The caller passes the command ids
     * so the copy stays free of UI wiring; each link is a `command:` URI the
     * trusted MarkdownString is allowed to invoke. Markdown, with `$(icon)`
     * codicons (the hover sets `supportThemeIcons`).
     */
    tooltip: (opts: {
      model: string;
      tokens: string;
      estimated: boolean;
      verbosity: string;
      triageMode: string;
      debug: boolean;
      selectModelCommand: string;
      selectTriageModeCommand: string;
      usageCommand: string;
      setKeyCommand: string;
    }): string =>
      `**My Dev Team**\n\n` +
      `---\n\n` +
      `Model: **${opts.model}**  \n` +
      `Routing: **${opts.triageMode}**  \n` +
      `Output mode: **${opts.verbosity}**  \n` +
      `Tokens this session: **${opts.estimated ? '~' : ''}${opts.tokens}**  \n` +
      // Shown only while debug logging is on, so the line is a quiet reminder that
      // the verbose "My Dev Team (Debug)" log is being written.
      (opts.debug ? `Debug mode: **on**\n\n` : `\n`) +
      `---\n\n` +
      `[$(sparkle) Select model](command:${opts.selectModelCommand} "Choose the model for @devteam")\n\n` +
      `[$(git-branch) Select routing mode](command:${opts.selectTriageModeCommand} "Choose how @devteam routes a request")\n\n` +
      `[$(symbol-number) Token usage report](command:${opts.usageCommand} "Open the token usage report")\n\n` +
      `[$(key) Set API key](command:${opts.setKeyCommand} "Store a cloud provider API key (local engine)")`,
    /** Placeholder atop the quick-pick menu the button opens. */
    menuPlaceholder: 'My Dev Team',
    /** The "change model" row, showing the currently-active model. */
    menuModel: (label: string) => `$(sparkle) Select model  -  current: ${label}`,
    /** The "open usage report" row, showing this session's running token total. */
    menuUsage: (total: string, estimated: boolean) =>
      `$(symbol-number) Token usage  -  ${estimated ? '~' : ''}${total} this session`,
    /** The "change output verbosity" row, showing the current mode. */
    menuVerbosity: (label: string) => `$(list-selection) Output mode  -  current: ${label}`,
    /** The "change routing mode" row, showing the current triage mode. */
    menuTriageMode: (label: string) => `$(git-branch) Routing mode  -  current: ${label}`,
  },

  /**
   * Copy for the output-verbosity switcher: the `/verbose` chat command, the
   * command-palette/status-bar quick pick, and the chat confirmations. The mode
   * controls only how much of each agent's block the chat renders (see the
   * `Verbosity` type); the engine is untouched.
   */
  verbosity: {
    /** Human label for each mode, used in the picker and the status-bar menu. */
    label: (mode: 'default' | 'verbose') =>
      mode === 'verbose' ? 'Verbose' : 'Default',
    /** Detail line under each mode in the picker. */
    detail: (mode: 'default' | 'verbose') =>
      mode === 'verbose'
        ? 'Show everything: triage intent, reason, and complexity; full plan with step details; each tool call with its output.'
        : 'Terser: triage intent only; plan summary and step titles; tool calls show just the tool name and what it acted on.',
    /** Suffix marking the mode that is currently selected, in the picker. */
    currentSuffix: ' (current)',
    /** Placeholder atop the verbosity quick pick. */
    pickerPlaceholder: 'Choose how much @devteam shows in the chat',
    /** Reply to a `/verbose` turn (or a menu pick) confirming the new mode. */
    confirmation: (label: string) =>
      `Output mode set to **${label}**. It applies to your next @devteam reply.`,
    /** The reply when `/verbose <arg>` named something other than a known mode. */
    unknown: (arg: string) =>
      `No output mode "${arg}". Use /verbose with no argument to pick, or "default"/"verbose".`,
  },

  /**
   * Copy for the request-routing (triage mode) switcher: the status-bar menu row
   * and the command-palette quick pick. The mode is the `myDevTeam.triage.mode`
   * setting - `classifier` (a quick triage call, then the answerer or planner) or
   * `combined` (one responder that triages and answers-or-plans in a single
   * call) - read live by the engine, so a change takes effect on the next run.
   */
  triageMode: {
    /** Human label for each mode, used in the picker and the status-bar menu. */
    label: (mode: 'classifier' | 'combined') =>
      mode === 'combined' ? 'Combined' : 'Classifier',
    /** Detail line under each mode in the picker. */
    detail: (mode: 'classifier' | 'combined') =>
      mode === 'combined'
        ? 'One agent decides the route and answers or plans in a single call on your work model - one fewer round-trip, no misroute dead-ends. Slash commands are unaffected.'
        : 'A quick triage step routes the request, then the answerer or the planner runs - the default three-agent path.',
    /** Suffix marking the mode that is currently selected, in the picker. */
    currentSuffix: ' (current)',
    /** Placeholder atop the routing-mode quick pick. */
    pickerPlaceholder: 'Choose how @devteam routes a request',
  },

  /**
   * Copy for the tool approval gates. `run` is always gated; `write` and `edit`
   * are gated only when the user turns on `myDevTeam.approval.fileChanges` (off
   * by default, since the workspace is git-backed - see docs/DESIGN.md).
   */
  approval: {
    runCommandTitle: 'Run command',
    /**
     * Title of the run approval prompt for a command the agent flagged
     * `dangerous` (destructive or irreversible). The warning icon and wording
     * make the heightened risk obvious before the user approves, and its
     * separate "Allow All" scope (`run:dangerous`) is never satisfied by an
     * allowance granted for an ordinary command.
     */
    runCommandDangerousTitle: '⚠️ Run destructive command',
    /** Title of the write approval prompt (gated by myDevTeam.approval.fileChanges). */
    writeFileTitle: 'Write file',
    /** Title of the edit approval prompt (gated by myDevTeam.approval.fileChanges). */
    editFileTitle: 'Edit file',
    /** The preview shown for a write/edit approval: the target file path. */
    fileChangeDetail: (path: string) => path,
    /**
     * The preview shown for a run approval: the command, prefixed with a
     * shell-comment naming its cwd folder in a multi-root workspace (where the
     * command runs in the first folder). A single-folder workspace omits the
     * line, so the preview is just the command as before. When the agent flagged
     * the command `dangerous`, a leading warning comment is added so the risk is
     * visible inside the previewed command too, not only in the title.
     */
    runCommandDetail: (command: string, cwdFolder?: string, dangerous?: boolean) => {
      const lines: string[] = [];
      if (dangerous) {
        lines.push('# WARNING: flagged as destructive or irreversible');
      }
      if (cwdFolder) {
        lines.push(`# cwd: ${cwdFolder}`);
      }
      lines.push(`$ ${command}`);
      return lines.join('\n');
    },
    /** Title of an MCP tool-call approval prompt (every MCP call is gated). */
    mcpToolTitle: 'Call MCP tool',
    /**
     * The preview shown for an MCP tool-call approval: the namespaced tool name
     * (which carries the server name) and a compact preview of its arguments.
     */
    mcpToolDetail: (tool: string, argsPreview: string) => `${tool}\n${argsPreview}`,
    /** The in-chat approval question: the action title plus its preview. */
    block: (title: string, detail: string) =>
      `\n\n**${title}?**\n\n${fence(detail, 3)}\n`,
    /** Labels of the approval choices (the modal fallback uses Approve / Allow All). */
    approve: 'Approve',
    decline: 'Decline',
    /**
     * "Allow All" approves this action and every later one with the same scope
     * (the same tool) for the rest of the chat conversation, so a routine run of
     * many similar calls is not gated one by one. It is per scope (per tool) and
     * per conversation: it never carries to a different tool, and a new chat (or
     * /clear) starts asking again. Destructive `run` commands carry a distinct
     * scope (`run:dangerous`), so allowing ordinary commands never auto-approves
     * a destructive one - it asks again, with its own allowance. See ChatApprover
     * in ui/chatParticipant.ts.
     */
    allowAll: 'Allow All',
    /**
     * Label of the optional "always allow commands like this" choice on a `run`
     * approval (see AlwaysAllowOption). Unlike "Allow All" (in-memory, this
     * conversation only), picking it persists `prefix` to
     * `myDevTeam.run.allowedCommands`, so later matching commands skip the
     * prompt for good. Offered only for an ordinary (non-destructive) command.
     */
    alwaysAllow: (prefix: string) => `Always allow \`${prefix}\``,
    /**
     * The Approve / Allow All / Decline choices (plus an optional persistent
     * "always allow" choice) rendered as inline trusted-markdown command links,
     * so they appear on one line instead of as VS Code's stacked buttons.
     * `command` is the approval command id and `id` identifies the pending
     * approval; each link invokes the same command with the approval id and the
     * chosen verdict. `alwaysAllowLabel`, when given, inserts the persistent
     * choice. Command-link arguments must be URI-encoded JSON.
     */
    links: (command: string, id: string, alwaysAllowLabel?: string) => {
      const arg = (verdict: 'approve' | 'allow-all' | 'always-allow' | 'decline') =>
        encodeURIComponent(JSON.stringify([id, verdict]));
      const alwaysAllowLink = alwaysAllowLabel
        ? `[**${alwaysAllowLabel}**](command:${command}?${arg('always-allow')}) | `
        : '';
      return (
        `[**${messages.approval.approve}**](command:${command}?${arg('approve')}) | ` +
        `[**${messages.approval.allowAll}**](command:${command}?${arg('allow-all')}) | ` +
        alwaysAllowLink +
        `[**${messages.approval.decline}**](command:${command}?${arg('decline')})\n`
      );
    },
  },

  /** Returned to the model when the user declines a gated tool. */
  notApproved: {
    run: 'Command was not approved by the user.',
    write: 'Write was not approved by the user.',
    edit: 'Edit was not approved by the user.',
    mcp: 'MCP tool call was not approved by the user.',
  },

  /**
   * Returned to the model when a side-effecting tool is disabled by the
   * workspace mode rather than declined. An untrusted folder (VS Code
   * Restricted Mode) disables run/write/edit; a virtual workspace (no local
   * filesystem) disables run. Read and search stay available in both. The
   * model relays the reason instead of reporting an opaque failure, and no
   * approval prompt is shown for an action that cannot run.
   */
  restricted: {
    run:
      'This workspace is not trusted, so the run tool is disabled. Trust the ' +
      'workspace (Restricted Mode banner, or the "Workspaces: Manage Workspace ' +
      'Trust" command) and try again.',
    write:
      'This workspace is not trusted, so the write tool is disabled. Trust the ' +
      'workspace (Restricted Mode banner, or the "Workspaces: Manage Workspace ' +
      'Trust" command) and try again.',
    edit:
      'This workspace is not trusted, so the edit tool is disabled. Trust the ' +
      'workspace (Restricted Mode banner, or the "Workspaces: Manage Workspace ' +
      'Trust" command) and try again.',
  },

  /**
   * Returned to the model when `write`/`edit` refuse a path that, although
   * inside the workspace, falls in a protected location (`.git/`, `.vscode/`,
   * ...). These can run code on their own (git hooks, VS Code tasks) without
   * passing the run tool's approval gate, so the agent must not change them; the
   * model relays the reason and leaves the change to the user.
   */
  protected: {
    write: (path: string) =>
      `Refusing to write ${path}: it is in a protected location (it can run ` +
      'code automatically, e.g. git hooks or VS Code tasks). If this change is ' +
      'really needed, tell the user to make it themselves.',
    edit: (path: string) =>
      `Refusing to edit ${path}: it is in a protected location (it can run ` +
      'code automatically, e.g. git hooks or VS Code tasks). If this change is ' +
      'really needed, tell the user to make it themselves.',
  },

  /** Returned to the model when a tool cannot run in a virtual workspace. */
  virtual: {
    run:
      'This is a virtual workspace with no local filesystem, so the run tool ' +
      '(which starts a shell process) is not available here. Reading, ' +
      'searching, writing, and editing files still work.',
  },

  /**
   * Returned to the model when the request was cancelled before a tool
   * applied, so it can note the skip in its report. `run` is the only gated
   * tool, but `write`/`edit` are still cancellable mid-run by the stop button.
   */
  cancelled: {
    run: 'Command was cancelled before running.',
    write: 'Write was cancelled; the file was not changed.',
    edit: 'Edit was cancelled; the file was not changed.',
  },

  /**
   * Header prepended to a read result that does not cover the whole file: the
   * range shown, the file's total line count, and (when the file goes on)
   * where the next call should continue.
   */
  read: {
    range: (start: number, end: number, total: number) =>
      `(lines ${start}-${end} of ${total}` +
      (end < total ? `; continue with startLine ${end + 1})` : ')'),
  },

  /**
   * Returned to the model when a read range cannot be satisfied. Each message
   * says how to recover, so the executor's loop self-corrects instead of
   * retrying the same failing call.
   */
  readFailed: {
    notFound: (path: string) =>
      `No such file or directory: ${path}. Use the search tool to find the ` +
      'file you meant, or the write tool to create it.',
    pastEnd: (path: string, start: number, total: number) =>
      `${path} has only ${total} lines; startLine ${start} is past the end ` +
      'of the file.',
    emptyRange: (start: number, end: number) =>
      `endLine ${end} is before startLine ${start}; nothing was read. ` +
      'Use an endLine at or after startLine.',
    tooLarge: (path: string, bytes: number, cap: number) =>
      `${path} is ${bytes} bytes, over the ${cap}-byte read limit; reading it ` +
      'whole would risk the editor\'s memory. Use the search tool to find the ' +
      'lines you need in it.',
  },

  /**
   * Returned to the model when an edit cannot be applied. Each message says
   * how to recover, so the executor's loop self-corrects instead of retrying
   * the same failing call.
   */
  editFailed: {
    missingFile: (path: string) =>
      `File does not exist: ${path}. Use the write tool to create a new file.`,
    notFound: (path: string) =>
      `oldText was not found in ${path}. Read the file and copy the text to ` +
      'replace exactly, including whitespace and indentation.',
    multipleMatches: (count: number, path: string) =>
      `oldText matches ${count} places in ${path}. Include more surrounding ` +
      'lines so it matches exactly one place.',
    identical:
      'oldText and newText are identical after decoding, so this edit would ' +
      'change nothing. If you intended a change, it may be in special characters ' +
      '(a literal backslash, or straight vs. curly quotes) that were lost - ' +
      're-read the file and retry, or use the write tool with the complete new ' +
      'contents.',
  },

  /** Copy for the terminal mirroring the run tool's commands (ui/runTerminal.ts). */
  terminal: {
    /** Tab name of the mirror terminal in the terminal panel. */
    name: 'Dev Team',
    /** Header line echoed before each command's output. */
    prompt: (command: string) => `$ ${command}`,
    /** Outcome note written after a command that finished cleanly. */
    completed: '(command completed)',
  },

  /** Copy for the `search` tool. */
  search: {
    /**
     * Appended to a content search that stopped at the files-examined budget
     * with candidate files still unscanned, so the model knows a short or empty
     * result on a large repo is not authoritative and can narrow its query.
     */
    contentTruncated: (scanned: number) =>
      `(search stopped after scanning ${scanned} files; more files were not ` +
      'searched - narrow the query or use a glob search to look in fewer files)',
  },

  /** Copy for the chat handler's attachment resolution. */
  attachments: {
    /** Stands in for an attached file too large to inline (or even read). */
    tooLarge: (bytes: number) =>
      `(attachment skipped: the file is ${bytes} bytes, too large to inline; ` +
      'attach a selection from it instead)',
  },

  /** Copy for the inline prompt references the client resolves (client/references.ts). */
  references: {
    /** Stands in for an attached reference of a kind we cannot inline. */
    unsupported: '(a reference of an unsupported type was attached and skipped)',
    /** Label of the `#codebase` attachment, naming the search terms used. */
    codebaseLabel: (terms: string) => `Codebase search: ${terms}`,
    /** Heading above the list of files a `#codebase` search matched. */
    codebaseHeader: (terms: string) => `Files matching ${terms}:\n`,
    /** Body when no distinctive search terms could be derived from the prompt. */
    codebaseNoTerms:
      '(no distinctive search terms could be derived from your message; ' +
      'mention a name, symbol, or keyword to search for)',
    /** Body when the search terms matched no files in the workspace. */
    codebaseNoMatches: (terms: string) =>
      `(no files in the workspace matched: ${terms})`,
    /** Label of the `#changes` attachment. */
    changesLabel: 'Uncommitted git changes',
    /** Body when there are no uncommitted changes (or git is unavailable). */
    changesEmpty: '(no uncommitted git changes, or git is not available here)',
    /**
     * Notice prepended when the full diff overflowed the read buffer and only a
     * `--stat` summary could be inlined. Distinguishes a genuinely large working
     * tree from an empty one, so `#changes` never misreports a big diff as "no
     * changes".
     */
    changesTooLarge:
      '(the uncommitted diff is too large to include in full - only a file ' +
      'summary is shown below; review the changes in source control, or stage ' +
      'or narrow them to inline the detail)',
  },

  /**
   * Copy for the editor entry points (ui/editorEntryPoints.ts): the quick fix
   * on a diagnostic, the "explain selection" context-menu action, and the
   * test-file CodeLens. Each is a thin shim that opens the chat with a pinned
   * slash command, so the strings here are the chat prompt the shim submits
   * (framed for the downstream agents) and the action/lens titles - the slash
   * command itself is prepended by the shim, not spelled out here.
   */
  editor: {
    /** Title of the "Fix with Dev Team" quick fix offered on a diagnostic. */
    fixActionTitle: 'Fix with Dev Team',
    /** One problem line for fixPrompt: where the diagnostic is and what it says. */
    fixProblem: (line: number, message: string) => `line ${line}: ${message}`,
    /**
     * The chat prompt the fix action submits (behind `/fix`): names the file and
     * each reported problem, and pulls in the uncommitted diff with `#changes`
     * so the agent diagnoses against what actually changed.
     */
    fixPrompt: (relPath: string, problems: readonly string[]) =>
      `#changes Fix the following problem${problems.length === 1 ? '' : 's'} ` +
      `reported in ${relPath}:\n` +
      problems.map((p) => `- ${p}`).join('\n'),
    /** Title of the "Explain with Dev Team" editor context-menu action. */
    explainActionTitle: 'Explain with Dev Team',
    /** Shown when explain is invoked with nothing selected in the editor. */
    explainNoSelection: 'My Dev Team: select some code first, then run Explain with Dev Team.',
    /**
     * The chat prompt the explain action submits (behind `/explain`), carrying
     * the selected code inline so the answerer sees exactly what to explain.
     */
    explainPrompt: (relPath: string, startLine: number, endLine: number, code: string) => {
      const where =
        endLine > startLine
          ? `${relPath} (lines ${startLine}-${endLine})`
          : `${relPath} (line ${startLine})`;
      return `Explain this code from ${where}:\n\n${fence(code, 3)}`;
    },
    /** Title of the test CodeLens when the file has no current failures. */
    testLensWrite: '$(beaker) Write/update tests with Dev Team',
    /** Title of the test CodeLens when the file has failing diagnostics. */
    testLensRepair: '$(beaker) Repair tests with Dev Team',
    /**
     * The chat prompt the test CodeLens submits (behind `/test`): repair when
     * the file currently has error diagnostics, otherwise write or update.
     */
    testPrompt: (relPath: string, failing: boolean) =>
      failing
        ? `Some tests in ${relPath} are failing. Diagnose why each fails and ` +
          `repair them, then run them to confirm.`
        : `Write or update the tests in ${relPath}, then run them.`,
  },

  /**
   * Copy for the quick-question command (ui/quickQuestion.ts): the hotkey path
   * for asking a side question while a chat run is busy. The input box takes
   * the question, a cancellable progress notification covers the run, and the
   * answer renders into a read-only markdown preview beside the editor (the
   * chat input may be blocked by the ongoing turn, so the answer cannot land
   * there). Like a "btw" chat turn it runs the /ask route with no history.
   */
  quickAsk: {
    /** Prompt of the question input box. */
    inputPrompt:
      'Ask a quick question - answered on the side, it never joins the chat conversation.',
    /** Placeholder of the question input box. */
    inputPlaceholder: 'e.g. how do I sort an array in Python?',
    /** Title of the cancellable progress notification shown while answering. */
    progressTitle: 'My Dev Team: answering your question',
    /** Tab/file name of the answer preview (the id keeps concurrent asks apart). */
    fileName: (id: string) => `Quick answer ${id}.md`,
    /** Document title of the answer preview. */
    title: '# Quick answer\n',
    /** The question, quoted under the title (each line, so multi-line quotes hold). */
    question: (question: string) =>
      '\n' +
      question
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n') +
      '\n\n',
    /** Body shown while the answer is still streaming in. */
    working: '_Working..._\n',
    /** Body when the run failed; `detail` is the protocol error's message. */
    failed: (detail: string) => `**The question failed:** ${detail}\n\n`,
    /**
     * Returned to the model should a quick-question run ever call a tool: the
     * run offers none (the /ask route answers in one model call), so this is
     * the structural backstop, not an expected path.
     */
    noTools: 'Tools are not available for a quick question; answer from knowledge.',
  },

  /** Copy for the client-side /clear command (it never starts a run). */
  clear: {
    /** The whole reply to a /clear turn. */
    confirmation:
      'Context cleared - the conversation so far will not accompany future requests.',
    /** Appended when the /clear turn also carried a message. */
    ignoredPrompt:
      ' Your message was not processed; send it again as the next request.',
  },

  triage: {
    /**
     * The detected intent line - the routing decision, shown in both modes (the
     * one piece the terse `default` mode keeps).
     */
    intent: (intent: string) => `**Detected intent:** \`${intent}\`\n\n`,
    /** Triage's justification, shown only in `verbose` mode. */
    reason: (reason: string) => `**Reason:** ${reason}\n\n`,
    /**
     * Triage's complexity judgement, shown only in `verbose` mode. This is
     * triage's pre-exploration read; the planner's post-exploration one rides in
     * the plan block (see `plan.complexity`).
     */
    complexity: (complexity: string) => `**Complexity:** \`${complexity}\`\n\n`,
    error: (detail: string) => `**Triage error:** ${detail}\n\n`,
  },

  answer: {
    error: (detail: string) => `**Answerer error:** ${detail}\n\n`,
    // A prefix rather than a template: the renderer streams the answer text
    // in behind it while the model is still writing it.
    header: '**Answer:**\n\n',
  },

  /**
   * The clarify route's copy: a heading, then each question with its options as a
   * numbered list and an optional "answer in your own words" note. The questions
   * arrive whole at the end of the run (not streamed), so this renders once; the
   * leading blank line keeps it appended cleanly after the intent/model block.
   * The suggested answers are also offered as clickable follow-ups (extension.ts),
   * so clicking one or typing a reply both carry the work forward on the next turn.
   */
  clarify: {
    header: (plural: boolean): string =>
      plural
        ? '\n\n**A couple of questions before I continue:**\n\n'
        : '\n\n**A quick question before I continue:**\n\n',
    question: (question: string): string => `${question}\n`,
    option: (n: number, label: string): string => `${n}. ${label}\n`,
    otherNote: '_Or reply in your own words._\n',
    /**
     * The in-run note the planner's `clarify` tool renders before it asks (see
     * ChatClarifyPrompt): unlike the route above, the question is answered live
     * in a pop-up and the run continues, so this is a short record in the
     * transcript, with the chosen answer appended once given.
     */
    asking: (plural: boolean): string =>
      plural
        ? '\n\n**Pausing to ask a couple of questions before drafting the plan:**\n\n'
        : '\n\n**Pausing to ask a question before drafting the plan:**\n\n',
    answered: (question: string, answer: string): string =>
      `- ${question} **${answer}**\n`,
    /** Shown when the user dismissed the question without answering. */
    skipped: (question: string): string =>
      `- ${question} _(skipped - drafting from a reasonable assumption)_\n`,
    /** Placeholder/label for the "answer in your own words" pop-up choice. */
    otherChoice: 'Answer in my own words...',
    /**
     * The model-facing result the `clarify` tool returns into the planner loop
     * (distinct from the transcript notes above): the user's answers, or a note
     * to assume when they answered nothing. `clarify` is a client tool now, so
     * the client composes this string the model reads.
     */
    toolResult: (answers: readonly { question: string; answer: string }[]): string =>
      answers.length === 0
        ? 'The user did not answer. Draft a plan using your best reasonable assumption.'
        : `The user answered:\n${answers
            .map((a) => `- "${a.question}": ${a.answer}`)
            .join('\n')}`,
  },

  /** Model-facing strings the client's `skill` tool returns to the model. */
  skill: {
    /** Returned when a `skill` call names a skill the client does not have. */
    notFound: (name: string): string =>
      `No skill named "${name}" is available. Use one of the names in the ` +
      `"Available skills" list, exactly as written.`,
  },

  plan: {
    error: (detail: string) => `**Planner error:** ${detail}\n\n`,
    // A prefix rather than a template: the renderer streams the summary in
    // behind it while the planner is still writing it.
    header: '**Plan:** ',
    /**
     * The planner's complexity judgement, rendered as a line after the plan's
     * steps (an append-only position, so a value that streams in late never
     * breaks the prefix-extension the chat stream relies on). This is the one
     * complexity shown - the planner's, not triage's.
     */
    complexity: (complexity: string) => `\n\n**Complexity:** \`${complexity}\``,
    /**
     * Appended to a finished reply that drafted a plan but never executed it
     * (the /plan command, or a plan cancelled at the approval gate), so the
     * user knows nothing has happened yet and how to proceed.
     */
    notExecuted:
      '\n\n_Plan only - nothing was executed. Say "go ahead" to carry it out._',
  },

  /**
   * Copy for the plan-approval gate (`myDevTeam.planApproval`): the question
   * shown after a plan that needs approving, its inline Approve/Cancel/Revise
   * command links, and the input box the Revise choice opens. Mirrors the
   * `approval` copy used for the run tool.
   */
  planApproval: {
    /** The gate question, naming the planner's complexity judgement. */
    block: (complexity: string) =>
      `\n\n**Approve this plan before it runs?** (complexity: \`${complexity}\`)\n`,
    approve: 'Approve',
    cancel: 'Cancel',
    revise: 'Revise',
    /**
     * The three choices as inline trusted-markdown command links (one line, like
     * the run approval). `command` is the plan-review command id and `id`
     * identifies the pending review; each link invokes the command with the id
     * and the chosen action. Command-link arguments must be URI-encoded JSON.
     */
    links: (command: string, id: string) => {
      const arg = (choice: 'approve' | 'cancel' | 'revise') =>
        encodeURIComponent(JSON.stringify([id, choice]));
      return (
        `[${messages.planApproval.approve}](command:${command}?${arg('approve')}) | ` +
        `[${messages.planApproval.cancel}](command:${command}?${arg('cancel')}) | ` +
        `[${messages.planApproval.revise}](command:${command}?${arg('revise')})\n`
      );
    },
    /** Title/placeholder of the input box the Revise choice opens. */
    revisePrompt: 'How should the plan change?',
    revisePlaceholder: 'Describe what to do differently; the plan is redrafted and shown again.',
    /**
     * The note shown in the chat, above the Approve/Cancel/Revise links, when a
     * big plan has also been opened as a read-only editor preview - so the user
     * knows where to read the full plan while the terse checklist stays in chat.
     */
    previewNote: '\n_The full plan opened in a preview to the side for review._\n',
  },

  /**
   * Copy for the executor check-in (`myDevTeam.executor.checkpoint*`): the
   * "still working" question shown after a long stretch of execution, and its
   * inline Keep going / Stop command links. Mirrors `planApproval`.
   */
  checkpoint: {
    /** The check-in question, naming how much work has happened so far. */
    block: (stepsDone: number, secondsElapsed: number, lastAction?: string) => {
      const did = lastAction ? `, last action: \`${lastAction}\`` : '';
      return (
        `\n\n**Still working** - ${stepsDone} steps, ${secondsElapsed}s so far${did}.\n` +
        `Keep going, or stop here and summarize what I have?\n`
      );
    },
    keepGoing: 'Keep going',
    stop: 'Stop & summarize',
    /**
     * The two choices as inline trusted-markdown command links (one line, like
     * the plan-review links). `command` is the check-in command id and `id`
     * identifies the pending check-in; each link invokes the command with the id
     * and the chosen action. Command-link arguments must be URI-encoded JSON.
     */
    links: (command: string, id: string) => {
      const arg = (choice: 'continue' | 'stop') =>
        encodeURIComponent(JSON.stringify([id, choice]));
      return (
        `[${messages.checkpoint.keepGoing}](command:${command}?${arg('continue')}) | ` +
        `[${messages.checkpoint.stop}](command:${command}?${arg('stop')})\n`
      );
    },
  },

  /**
   * Copy for the context-usage caution (`myDevTeam.executor.contextWarnThresholds`):
   * a one-line blockquote shown when a run's context first crosses a threshold of
   * the model's window, so the user can see it is filling up. `~` and the
   * "estimated" note mark a count that is a length-based estimate rather than a
   * provider-reported one.
   */
  context: {
    warning: (
      percent: number,
      usedTokens: number,
      contextWindow: number,
      model: string,
      estimated: boolean
    ): string => {
      const k = (n: number) => `${Math.round(n / 1000)}k`;
      const approx = estimated ? '~' : '';
      const note = estimated ? ', estimated' : '';
      return (
        `\n\n> ⚠️ Context ${approx}${percent}% full ` +
        `(${approx}${k(usedTokens)} / ${k(contextWindow)} tokens${note}) for ${model}. ` +
        `Reading much more may overflow its window - consider stopping at the next check-in.\n\n`
      );
    },
    /**
     * The inline "Compact now" action appended to a context warning below the
     * auto-compact threshold: a trusted command link that runs /compact (the
     * command opens the chat with `@devteam /compact`). The caller scopes the
     * MarkdownString's `isTrusted` to just this command id.
     */
    compactAction: (command: string): string =>
      `> [**Compact now**](command:${command}) to summarize the conversation so far and free up the window.\n\n`,
    /**
     * The notice shown when context crosses the auto-compact threshold and
     * auto-compaction is on: the conversation will compact itself on the next
     * message, so the user knows why the next turn opens with a summary.
     */
    autoCompacted: (model: string): string =>
      `> 🧹 Context for ${model} is nearly full; the conversation will be compacted automatically on your next message.\n\n`,
    /** Shown at the start of a turn while the automatic /compact pass runs. */
    autoCompacting: 'Compacting the conversation to free up context...',
    /**
     * Progress shown during an intermediate pass of a multi-pass compaction (a
     * conversation too large for the compacter model's window, summarized in a
     * rolling refine). The final pass streams the summary itself, so only the
     * earlier passes show this.
     */
    compactingPass: (pass: number, total: number): string =>
      `Compacting the conversation (pass ${pass} of ${total})...`,
  },

  /**
   * Copy for the read-only plan preview document (ui/planPreview.ts): the
   * markdown a big or design-bearing plan renders into when it opens beside the
   * chat for approval. This is a standalone document the user reads, not a chat
   * fragment, so it carries its own headings; the Approve/Cancel/Revise choices
   * stay in the chat, not here.
   */
  planDocument: {
    /** Tab/file name of the preview (the id keeps concurrent reviews apart). */
    fileName: (id: string) => `Plan review ${id}.md`,
    /** Document title. */
    title: '# Plan review\n',
    /** The one-sentence goal restatement, under the title. */
    summary: (summary: string) => `\n${summary}\n`,
    /** Heading above the design-decision list (omitted when there are none). */
    decisionsHeading: '\n## Key design decisions\n',
    /** One decision line: the choice in bold, then its rationale. */
    decision: (n: number, decision: string, rationale: string) =>
      `${n}. **${decision}** - ${rationale}`,
    /** Heading above the numbered steps. */
    stepsHeading: '\n## Steps\n',
    /** One step line: the title in bold, then its detail. */
    step: (n: number, title: string, detail: string) => `${n}. **${title}** - ${detail}`,
    /** The planner's complexity judgement, at the foot of the document. */
    complexity: (complexity: string) => `\n**Complexity:** \`${complexity}\`\n`,
  },

  execution: {
    error: (detail: string) => `**Executor error:** ${detail}\n\n`,
    // A prefix rather than a template: the transcript streams in behind it
    // while the executor is still working. The executor's model (when known)
    // rides in the header rather than the upfront "Model:" block: it is sized by
    // the planner's post-exploration complexity, settled only as execution
    // starts, so rendering it here - below the now-final plan - keeps the
    // streamed output append-only (the model block above it never changes).
    header: (model?: string): string =>
      '**Execution:**' + (model ? ` _(${model})_` : ''),
    /**
     * One transcript line per tool call (no bullet, the bolded display name
     * leads the line); the result is appended when it lands.
     */
    call: (tool: string, input: string) => `\n\n**${tool}** \`${input}\``,
    result: (preview: string, failed: boolean) =>
      failed ? ` → **failed** \`${preview}\`` : ` → \`${preview}\``,
    /**
     * Fenced snippet of a call's content argument (e.g. the first lines of a
     * written file), shown under the call line. The fence is at least four
     * backticks, grown longer when the snippet itself contains a run that long,
     * so snippet lines containing ``` (or more) cannot break out of it.
     */
    snippet: (snippet: string) => '\n\n' + fence(snippet, 4),
    /** Shown in a result slot when the tool produced no output at all. */
    emptyResult: '(no output)',
    /**
     * A self-reported progress snapshot the executor prints from time to time:
     * a markdown checklist of plan steps with their status. The caller resolves
     * each reported step number to its plan title before calling this; a "done"
     * step is checked, an "in_progress" step is noted, a "pending" step is bare.
     */
    progress: (items: readonly { title: string; status: ProgressStatus }[]) =>
      '\n\n**Progress:**\n' +
      items
        .map((item) => {
          const box = item.status === 'done' ? '[x]' : '[ ]';
          const note = item.status === 'in_progress' ? ' _(in progress)_' : '';
          return `- ${box} ${item.title}${note}`;
        })
        .join('\n'),
  },

  summary: {
    // Prefixes rather than templates: each section streams in behind its
    // header while the summarizer is still writing it, so successive renders
    // stay prefix-extensions of one another (the append-only streamer's
    // requirement). All start with a blank line so the section sits apart from
    // the execution transcript above and the previous section.
    header: '\n\n**Summary:**',
    whatShips: '\n\n**What ships:** ',
    howItsBuilt: "\n\n**How it's built:** ",
    testsAndDocs: '\n\n**Tests and docs:** ',
  },

  run: {
    /** Shown when a run fails without a step the protocol could attribute it to. */
    error: (detail: string) => `**The run failed:** ${detail}\n\n`,
  },

  thinking: {
    /**
     * The `_Thought for 12s_` line appended under a reply when a reasoning model
     * spent time thinking (gated by `myDevTeam.thinking.showDuration`). Under a
     * minute reads as `12s`; a minute or more as `1m 3s`.
     */
    duration: (seconds: number) =>
      `\n\n_Thought for ${
        seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
      }_`,
  },

  /** Copy for the engine switch (client/engineFactory.ts). */
  engine: {
    remoteUnavailable:
      'My Dev Team: the remote engine is not available yet; using the local engine. ' +
      'Set "myDevTeam.engine" back to "local" to hide this warning.',
    /** `keys` is the comma-joined "Provider (set ENV_VAR)" list of affected providers. */
    sidecarSecretKeysIgnored: (keys: string) =>
      'My Dev Team: the sidecar engine reads cloud API keys from environment ' +
      `variables only, so a key you set with "Set API Key" will not be used: ${keys}. ` +
      'Set the matching environment variable before launching VS Code, or switch ' +
      '"myDevTeam.engine" back to "local" to use the stored key.',
    /** The sidecar child crashed repeatedly, so the provider gave up reforking it. */
    sidecarCrashed:
      'My Dev Team: the sidecar engine keeps crashing, so it has been switched off ' +
      'for now and the local engine is being used instead. Reload the window to try ' +
      'the sidecar again, or set "myDevTeam.engine" to "local" to hide this warning.',
  },

  /**
   * Reasons the sidecar client (client/sidecarEngine.ts) settles a run or query
   * with when the child does not cooperate - distinct from a real run failure.
   */
  sidecar: {
    /**
     * The child's `ready` handshake reported a different protocol version than
     * this build speaks - a stale `dist/sidecar.js`. `childVersion`/`ourVersion`
     * are the two protocol numbers.
     */
    versionMismatch: (childVersion: number, ourVersion: number) =>
      `The engine sidecar bundle is out of date (it speaks protocol ${childVersion}, ` +
      `this build speaks ${ourVersion}). Reload the window to rebuild it, or set ` +
      '"myDevTeam.engine" to "local".',
    /** The child never sent its `ready` handshake within the timeout. */
    notReady: 'The engine sidecar did not start in time.',
    /** A `listModels`/`startupWarnings` query failed or timed out; `detail` is why. */
    probeFailed: (detail: string) =>
      `My Dev Team: could not reach the engine sidecar (${detail}). ` +
      'Reload the window, or set "myDevTeam.engine" to "local".',
    /** A one-shot query exceeded `settings.sidecar.queryTimeoutMs`. */
    queryTimeout: 'the engine sidecar did not answer in time',
    /**
     * The parent received a `tool-call` for a run it no longer tracks (a late or
     * duplicate message), so it answers with this rather than leaving the child's
     * tool-call promise pending forever.
     */
    orphanToolCall: 'The engine sidecar requested a tool for a run that is no longer active.',
  },

  /** Warnings the engines' startup probes may surface (ui/startupCheck.ts). */
  startup: {
    unreachable: (endpoint: string) =>
      `My Dev Team: cannot reach Ollama at ${endpoint}. ` +
      'Start it with "ollama serve", or point the "myDevTeam.ollama.endpoint" setting at your server.',
    missingModels: (models: readonly string[]) =>
      `My Dev Team: Ollama is missing the model(s) the router selected: ${models.join(', ')}. ` +
      'Pull them with "ollama pull <model>".',
  },
} as const;
