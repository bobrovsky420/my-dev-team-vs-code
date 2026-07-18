/**
 * Operational limits - the tunable numbers that govern how much work the tools
 * and UI will do. The user-tunable subset (Ollama endpoint, run-command
 * timeout, search caps) is read live from VS Code settings (the
 * `contributes.configuration` section in package.json, `myDevTeam.*`), with
 * the constants in `defaults` as fallbacks; invalid user values (wrong type,
 * non-positive numbers, non-http endpoints) fall back too, so the rest of the
 * code can always trust what it reads here. The remaining limits are
 * compile-time constants: change them here without touching the code that
 * enforces them.
 */
import * as vscode from 'vscode';
import { limits } from './limits';
import { providerDescriptors } from './providers';
import { RuntimeConfig, CustomModelInput } from './runtimeConfig';

/** The settings namespace contributed in package.json. */
const CONFIG_SECTION = 'myDevTeam';

/**
 * How much the chat renders for each agent's block (`myDevTeam.verbosity`):
 * `verbose` (the shipped default) shows everything the agents produce; `default`
 * is the terser mode (triage shows only the detected intent; the plan shows the
 * summary and step titles, no per-step detail or complexity). A pure rendering
 * choice - the engine never sees it (the full data crosses the protocol either
 * way), so it does not ride the runtime-config seam.
 */
export type Verbosity = 'default' | 'verbose';

/**
 * One configured MCP server (stdio transport): a name (used to namespace its
 * tools and to label its approval prompts) plus the command, arguments, and
 * environment to launch it with. Parsed from the `myDevTeam.mcp.servers` object
 * map by `settings.mcp.servers`.
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Fallbacks for the user-tunable settings. Keep these in sync with the
 * `default` values declared in package.json `contributes.configuration` so
 * the Settings UI shows the values actually in effect.
 */
export const defaults = {
  engine: 'local' as const,
  model: 'auto',
  triageModel: '',
  triageMode: 'classifier' as const,
  complexityRouting: true,
  planApproval: 'auto' as const,
  planApprovalPreview: 'auto' as const,
  verbosity: 'verbose' as Verbosity,
  attachActiveEditor: true,
  approval: {
    fileChanges: false,
  },
  disabledProviders: [] as readonly string[],
  disabledModels: [] as readonly string[],
  customModels: [] as readonly CustomModelInput[],
  ollamaEndpoint: limits.defaultOllamaEndpoint,
  runCommandTimeoutMs: 60_000,
  run: {
    allowedCommands: [] as readonly string[],
    /**
     * The non-removable denylist floor for the `run` tool (always prompts,
     * escalated to the destructive scope, regardless of the model's `dangerous`
     * flag). `settings.run.deniedCommands` unions this with the user's
     * `myDevTeam.run.deniedCommands` additions; the floor is in code, not the
     * setting, so a user cannot shrink the safety net by clearing the setting.
     * Two threat classes: irreversible/destructive commands and ones that reach
     * the network (which could exfiltrate or fetch-and-run). Matching is
     * case-insensitive, so the PowerShell cmdlets are caught however they are
     * cased. The covered shells are the ones the run tool actually uses
     * (config/environment.ts): PowerShell on Windows, /bin/sh elsewhere - hence
     * both the POSIX names and the PowerShell cmdlets/aliases below (some POSIX
     * names like `rm`/`del`/`curl` are also PowerShell aliases, so they double up).
     */
    deniedCommandsFloor: [
      // POSIX / cross-platform destructive
      'rm',
      'rmdir',
      'rd',
      'del',
      'dd',
      'mkfs',
      'format',
      'sudo',
      'doas',
      'chmod',
      'chown',
      'shutdown',
      'reboot',
      // git history/state rewrites
      'git push',
      'git reset',
      'git clean',
      'git checkout',
      'git rebase',
      'npm publish',
      // network (exfiltration / fetch-and-run)
      'curl',
      'wget',
      'iwr',
      'irm',
      'invoke-webrequest',
      'invoke-restmethod',
      'start-bitstransfer',
      // PowerShell destructive cmdlets (and their common aliases). Canonical
      // Verb-Noun names cover the obscure short aliases; only the widely used
      // aliases (`kill`) are listed on their own.
      'remove-item',
      'remove-itemproperty',
      'clear-content',
      'clear-item',
      'set-content',
      'stop-process',
      'kill',
      'stop-computer',
      'restart-computer',
      'format-volume',
      'clear-disk',
      // PowerShell arbitrary-code execution (the classic fetch | iex vector)
      'invoke-expression',
      'iex',
    ] as readonly string[],
  },
  read: {
    maxLines: 200,
  },
  search: {
    globMaxResults: 200,
    contentScanLimit: 500,
    contentMaxMatches: 50,
  },
  chat: {
    toolSnippetLines: 5,
  },
  executor: {
    checkpointEverySteps: 100,
    checkpointEverySeconds: 600,
    contextWarnThresholds: [75, 85, 95] as readonly number[],
  },
  history: {
    autoCompact: true,
    autoCompactThreshold: 95,
  },
  modelContextWindows: {} as Readonly<Record<string, number>>,
  write: {
    protectedPaths: ['.vscode'],
  },
  usage: {
    showInChat: true,
  },
  changes: {
    showInChat: true,
  },
  summary: {
    showInChat: true,
  },
  thinking: {
    showInChat: true,
  },
  clarify: {
    enabled: true,
  },
  instructions: {
    files: ['AGENTS.md', 'CLAUDE.md'],
  },
  skills: {
    directories: ['.devteam/skills', '.claude/skills'],
  },
  mcp: {
    servers: {} as Readonly<Record<string, unknown>>,
  },
  telemetry: {
    evalLog: false,
    shadowTriage: false,
  },
  debug: false,
} as const;

/** Read a user-set integer (at least `min`), falling back when unset or invalid. */
function userLimit(key: string, fallback: number, min = 1): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

/**
 * The user's explicit Ollama endpoint (`myDevTeam.ollama.endpoint`): an http(s)
 * origin without the `/api` suffix, normalised without a trailing slash, or
 * `undefined` when the user has not set a valid one. Undefined (unset, blank, or
 * a non-http(s)/non-string value) means "defer to the operator default, then the
 * built-in localhost" - the fallback chain lives in core/models.ts'
 * `ollamaEndpoint()`, so this getter reports only what the user chose.
 */
function userEndpoint(): string | undefined {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<unknown>('ollama.endpoint');
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/.test(trimmed) ? trimmed : undefined;
}

/**
 * An optional custom base URL for a cloud provider (`myDevTeam.<provider>.baseUrl`),
 * for Azure / OpenAI-compatible gateways or an Anthropic proxy. An http(s)
 * origin, trailing slash trimmed; anything else (including unset) yields
 * undefined so the SDK falls back to the provider's own default endpoint.
 */
function userBaseUrl(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/.+/.test(trimmed) ? trimmed : undefined;
}

/**
 * Read a user-set list of identifiers (provider names / model ids), keeping only
 * the non-blank string entries and trimming them. A non-array (unset or wrong
 * type) yields the empty list, so a typo can never disable everything by
 * accident - the caller then treats nothing as disabled.
 */
function userStringList(key: string): readonly string[] {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(key);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

export const settings = {
  /**
   * Which engine handles `@devteam` runs (`myDevTeam.engine`): the in-process
   * local engine, a `sidecar` child process running the same engine, or (Phase
   * B) a remote backend speaking the same protocol. Read live per request, so
   * switching takes effect on the next request. An unknown value falls back to
   * "local" - the safe default.
   */
  get engine(): 'local' | 'remote' | 'sidecar' {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('engine');
    return value === 'remote' || value === 'sidecar' ? value : defaults.engine;
  },

  /**
   * What the user chose for the planner, answerer, and executor
   * (`myDevTeam.model`): a registry id (pin one model), a "provider:<name>"
   * (route within one provider), or "auto" to let the capability router pick
   * the best available model per agent. Read live and sent on every run
   * request; triage is configured separately by `triageModel`, not this. The
   * `/model` command and the status-bar item write this setting.
   */
  get model(): string {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('model');
    return typeof value === 'string' && value.trim() ? value.trim() : defaults.model;
  },

  /**
   * What the quick triage step uses (`myDevTeam.triage.model`), kept separate
   * from `model` so the cheap classifier need not ride on the executor's model.
   * A registry id pins one model, "provider:<name>" routes within a provider,
   * "auto" routes among all available models; empty (the default) cascades to the
   * work model (`myDevTeam.model`) when that is concrete, then the build's
   * `agents.triage.model` floor (the "ollama" provider unless changed). Read live
   * and resolved in engine/core/models.ts (`triageRouting`), where the disable
   * layers still apply - this can never reach a disabled provider/model.
   */
  get triageModel(): string {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('triage.model');
    return typeof value === 'string' ? value.trim() : defaults.triageModel;
  },

  /**
   * How a request is routed (`myDevTeam.triage.mode`). `classifier` (the
   * default) keeps the three-agent path: a cheap triage call routes the request,
   * then the answerer or the planner runs. `combined` replaces that first call
   * with a single responder that does triage and produces the answer or the plan
   * in one model call - one fewer round-trip, and a request can never be
   * misrouted into a dead-end answer (the same model that would answer decides to
   * plan instead). Only the unpinned path changes: a slash command still pins the
   * route and uses the dedicated agents. Read live; only the literal `combined`
   * switches off `classifier`.
   */
  get triageMode(): 'classifier' | 'combined' {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('triage.mode');
    return value === 'combined' ? 'combined' : defaults.triageMode;
  },

  /**
   * Whether triage's complexity judgement sizes the executor's model
   * (`myDevTeam.complexityRouting`). On by default: simple work routes to a
   * cheaper/smaller model and complex work to the strongest in the candidate
   * pool (the model registry's `tier`). When off, the executor routes by
   * capability alone, as before. A pinned model bypasses it regardless. Read
   * live; anything but the literal `false` counts as on.
   */
  get complexityRoutingEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('complexityRouting') !== false
    );
  },

  /**
   * When a drafted plan must be approved before it executes
   * (`myDevTeam.planApproval`). `auto` (the default) pauses only when the
   * planner judged the work `complex`; `always` pauses on every plan; `never`
   * runs straight through (the pre-gate behaviour). The gate offers Approve,
   * Cancel, and Revise (re-plan with a comment). Read live; only the literal
   * `always`/`never` switch off `auto`, so a typo is the safe default.
   */
  get planApproval(): 'auto' | 'always' | 'never' {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('planApproval');
    return value === 'always' || value === 'never' ? value : defaults.planApproval;
  },

  /**
   * When a paused plan also opens as a read-only editor preview
   * (`myDevTeam.planApproval.preview`). `auto` (the default) opens it only for a
   * big plan (complex, or carrying design decisions, many steps, or a long
   * write-up); `always` opens it whenever a plan is paused; `never` keeps review
   * in the chat only. Client-only - the engine never sees it (the preview is a
   * pure rendering choice), so it does not ride on the runtime-config seam. Read
   * live; only the literal `always`/`never` switch off `auto`.
   */
  get planApprovalPreview(): 'auto' | 'always' | 'never' {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('planApproval.preview');
    return value === 'always' || value === 'never'
      ? value
      : defaults.planApprovalPreview;
  },

  /**
   * How verbosely the chat renders each agent's block (`myDevTeam.verbosity`):
   * `verbose` (the shipped default) shows everything; `default` is terser (see
   * the `Verbosity` type). Client-only - the engine never sees it, the full data
   * crosses the protocol regardless and the renderer filters. The
   * `/verbose` command and the status-bar menu write this setting. Read live, so
   * switching takes effect on the next reply; only the literal `default` switches
   * off `verbose`.
   */
  get verbosity(): Verbosity {
    const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('verbosity');
    return value === 'default' ? 'default' : defaults.verbosity;
  },

  /**
   * Whether the active editor is automatically attached as context on every
   * @devteam request (`myDevTeam.attachActiveEditor`), so a bare "analyse the
   * current file" / "explain this selection" has a referent without the user
   * attaching anything: the whole open file, or just the selected text when
   * there is a selection. On by default - mirroring how Copilot always includes
   * the open editor - so the model never has to guess what "the current file"
   * means. Turn it off to attach nothing implicitly (e.g. to keep a small local
   * model's context window clear, or for privacy). Client-only: the engine just
   * receives the resulting attachment, so it does not ride the runtime-config
   * seam. Read live; anything but the literal `false` counts as on.
   */
  get attachActiveEditorEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('attachActiveEditor') !== false
    );
  },

  /**
   * Approval gates the user can switch on. Only `run` is gated unconditionally
   * (a shell command reaches outside the workspace and is not git-recoverable);
   * the file-changing tools are gated only when the user opts in here.
   */
  approval: {
    /**
     * Whether `write`/`edit` must be approved before they change a file
     * (`myDevTeam.approval.fileChanges`). Off by default: a git-backed workspace
     * makes a write recoverable, and prompting on every file would make a
     * routine multi-file change unusable, so changes apply straight away. Turn
     * it on to confirm every write and edit with the same Approve/Decline prompt
     * the `run` tool uses. Read live, so flipping it takes effect on the next
     * request; anything but the literal `true` counts as off.
     */
    get fileChanges(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('approval.fileChanges') === true
      );
    },
  },

  /**
   * Providers the user switched off (`myDevTeam.disabledProviders`): the router
   * never routes to their models and the `/model` picker shows them disabled,
   * even when a key is set. This is the per-user layer on top of the backend's
   * own floor (config/backend.json); it narrows further but can never
   * re-enable a provider the backend disabled. Read live. Names that are not
   * registered providers are simply harmless.
   */
  get disabledProviders(): readonly string[] {
    return userStringList('disabledProviders');
  },

  /**
   * Individual model ids the user switched off (`myDevTeam.disabledModels`),
   * same two-layer semantics as `disabledProviders` but per model. A disabled
   * model never runs even if pinned; the run falls back to Auto. Read live.
   */
  get disabledModels(): readonly string[] {
    return userStringList('disabledModels');
  },

  /**
   * Extra models the user registered (`myDevTeam.customModels`): a JSON array of
   * model definitions (the same fields as a built-in model - id, label,
   * provider, model, optional tier/capabilities), merged on top of the built-in
   * registry so a newly released model can be used without republishing the
   * extension. Only the shape is checked here (each entry must be a plain
   * object); the full schema validation - provider must be one that is wired,
   * ids must not collide with a built-in - lives in the engine (engine/config/
   * models.ts), the single owner of the model schema, so it applies identically
   * to the sidecar. A non-array (unset or wrong type) yields the empty list.
   * Read live.
   */
  get customModels(): readonly CustomModelInput[] {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('customModels');
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is CustomModelInput =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    );
  },

  /**
   * Per-model context-window overrides keyed by registry id
   * (`myDevTeam.modelContextWindows`, e.g. `{ "qwen3-coder": 32768 }`). It wins
   * over a model's built-in `contextWindow`, so a user can set the real window a
   * local model was launched with (its `num_ctx`), which the built-in value -
   * the theoretical maximum - cannot know. Only positive whole-number entries
   * are kept; anything else is dropped.
   */
  get modelContextWindows(): Readonly<Record<string, number>> {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<unknown>('modelContextWindows');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {};
    }
    const out: Record<string, number> = {};
    for (const [id, n] of Object.entries(value as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        out[id] = Math.floor(n);
      }
    }
    return out;
  },

  /**
   * The user's chosen Ollama endpoint (`myDevTeam.ollama.endpoint`), or
   * `undefined` when unset. The resolved endpoint the provider wiring
   * (core/models.ts), the chat error hints (messages.ts), and the activation
   * health check (ui/startupCheck.ts) actually use is `ollamaEndpoint()` in
   * core/models.ts, which prefers this user value, then the operator default in
   * `config/backend.json`, then the built-in localhost - so they can never
   * disagree.
   */
  get ollamaEndpoint(): string | undefined {
    return userEndpoint();
  },

  /**
   * Optional custom base URL for a cloud provider, read from the VS Code
   * setting named by the provider descriptor's `baseUrlSetting`
   * (`myDevTeam.<provider>.baseUrl`): an Azure / OpenAI-compatible gateway or a
   * proxy. Undefined (unset or invalid) defers to the operator default in
   * `config/backend.json`, then the provider's own default endpoint. Generic
   * over the provider so adding one needs no new getter - the provider wiring
   * (engine/core/models.ts) passes the descriptor's key.
   */
  providerBaseUrl(settingKey: string): string | undefined {
    return userBaseUrl(settingKey);
  },

  /** Outgoing model-request rate limiting and rate-limit retry behaviour. */
  provider: {
    /**
     * The user's explicit override of the model-request rate, in requests per
     * minute (`myDevTeam.provider.requestsPerMinute`), or `undefined` when the
     * user has not set it - in which case the per-provider operator floor from
     * `config/backend.json` applies (resolved in core/rateLimiter.ts'
     * `resolveRequestsPerMinute`). When the user does set it, the user's value
     * wins outright, in either direction (raise or lower) and across every
     * provider: it is the user's machine and the user's call. `0` is a valid
     * explicit value (the user turning throttling off); a negative or non-number
     * value is invalid and read as unset (defer to the floor). The setting's
     * package.json default is `null`, so an untouched setting reads as undefined
     * here rather than masking the floor with a `0`. Read live.
     */
    get requestsPerMinute(): number | undefined {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('provider.requestsPerMinute');
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    },
    /** Re-exposed from config/limits.ts (engine-read constants, single source). */
    maxRateLimitRetries: limits.provider.maxRateLimitRetries,
    maxRetryWaitMs: limits.provider.maxRetryWaitMs,
    retryBufferMs: limits.provider.retryBufferMs,
  },

  /** Shell command timeout for the `run` tool, in milliseconds (`myDevTeam.run.commandTimeoutMs`). */
  get runCommandTimeoutMs(): number {
    return userLimit('run.commandTimeoutMs', defaults.runCommandTimeoutMs);
  },

  /**
   * The `run` tool's command policy (tools/commandPolicy.ts): which commands
   * skip the approval prompt and which always prompt as destructive.
   */
  run: {
    /**
     * Prefix/glob patterns the user has marked safe to run without a prompt
     * (`myDevTeam.run.allowedCommands`, e.g. `git status`, `npm test`,
     * `npm run *`). Only a single, non-chained command can match; a denylisted
     * command never does. Invalid entries (non-string or empty) are dropped, so
     * one bad entry does not discard the rest. The "Always allow commands like
     * this" approval choice appends to this list.
     */
    get allowedCommands(): readonly string[] {
      return userStringList('run.allowedCommands');
    },
    /**
     * The denylist that always prompts and is treated as destructive: the
     * built-in floor (`defaults.run.deniedCommandsFloor`, not user-removable)
     * unioned with the user's `myDevTeam.run.deniedCommands` additions. Patterns
     * use the same prefix/glob form as the allowlist.
     */
    get deniedCommands(): readonly string[] {
      return [...defaults.run.deniedCommandsFloor, ...userStringList('run.deniedCommands')];
    },
  },

  /** Output buffer cap for the `run` tool, in bytes. */
  runCommandMaxBufferBytes: 10 * 1024 * 1024,

  /**
   * Cap on the `run` tool's model-facing result, in characters. The buffer
   * above bounds what is captured from the process; this bounds what is
   * handed back to the model, so one chatty command cannot flood a small
   * model's context window. The output's head and tail are kept around a
   * truncation marker.
   */
  runResultMaxChars: 200_000,

  /**
   * Cap on the session log the "Dev Team" terminal mirror keeps, in
   * characters. The backlog replays the full run history when the user first
   * opens (or reopens) the terminal; beyond the cap the oldest output is
   * dropped.
   */
  runMirrorBacklogMaxChars: 200_000,

  /** Caps on the `read` tool's output. */
  read: {
    /** Max lines one `read` call returns (`myDevTeam.read.maxLines`). */
    get maxLines(): number {
      return userLimit('read.maxLines', defaults.read.maxLines);
    },
    /** Backstop in characters, so a few enormous lines cannot flood the context. */
    maxChars: 200_000,
    /**
     * Max size, in bytes, of a file the `read` tool will load. The line/char
     * caps bound the *result*, but the whole file is read into the extension
     * host before they apply, so without this a `read` of a multi-GB or giant
     * minified file (the executor can be steered to one by injected workspace
     * text) would exhaust memory. Over this, `read` refuses by its stat instead
     * of loading the file, mirroring the attachment reader and the content scan.
     * Generous (10 MB) so every ordinary source file passes; compile-time.
     */
    maxFileSizeBytes: 10 * 1024 * 1024,
  },

  /** Caps on the `search` tool's file scans. */
  search: {
    /** Max files returned by a glob search (`myDevTeam.search.globMaxResults`). */
    get globMaxResults(): number {
      return userLimit('search.globMaxResults', defaults.search.globMaxResults);
    },
    /** Max files scanned when searching file contents (`myDevTeam.search.contentScanLimit`). */
    get contentScanLimit(): number {
      return userLimit('search.contentScanLimit', defaults.search.contentScanLimit);
    },
    /** Max match lines collected before a content search stops early (`myDevTeam.search.contentMaxMatches`). */
    get contentMaxMatches(): number {
      return userLimit('search.contentMaxMatches', defaults.search.contentMaxMatches);
    },
    /**
     * Max match lines reported from a single file, so one busy file (e.g. a log)
     * cannot eat the whole `contentMaxMatches` budget. Compile-time.
     */
    contentMaxMatchesPerFile: 5,
    /**
     * Max characters of a matched line kept in a content-search preview; a
     * longer line is trimmed (a `…` marker appended). Compile-time.
     */
    contentPreviewMaxChars: 200,
    /**
     * Folders the `search` tool never looks into. Passing an explicit exclude
     * to findFiles replaces VS Code's default excludes, so the usual noise
     * folders are listed here.
     */
    excludeGlob: '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/coverage/**}',
    /** Files larger than this are skipped by a content search. */
    maxFileSizeBytes: 1024 * 1024,
    /**
     * Ceiling on the candidate file list the JavaScript content scan (the
     * no-ripgrep fallback) materialises from `findFiles`. The files-examined
     * budget (`contentScanLimit`) bounds the *work*, but `findFiles('**\/*')`
     * with no `maxResults` first builds one Uri per workspace file, so on a very
     * large repo the array itself is the cost. Generous (far above the scan
     * budget) so it never drops files the budget would have reached; when the
     * candidate list is capped here the scan reports `truncated`. Compile-time.
     */
    scanCandidateLimit: 25_000,
  },

  /**
   * Self-repair for the structured-output steps (triage, the planner). Small
   * local models routinely emit JSON that fails schema validation; rather than
   * fail the whole run on one bad generation, the step re-asks the same agent
   * with the validation error appended. Compile-time: the cost is bounded model
   * calls, not something an end user tunes.
   */
  /** Re-exposed from config/limits.ts (the engine reads it from there). */
  structuredOutput: limits.structuredOutput,

  /** Limits on the executor's tool-calling loop and its transcript previews. */
  executor: {
    /** Re-exposed from config/limits.ts (engine-read constants, single source). */
    maxSteps: limits.executor.maxSteps,
    inputPreviewMaxChars: limits.executor.inputPreviewMaxChars,
    resultPreviewMaxChars: limits.executor.resultPreviewMaxChars,
    /**
     * Leading lines of a snippet-bearing argument (config `snippetArg`, e.g.
     * the file contents for write) shown beneath the call line in the
     * transcript (`myDevTeam.chat.toolSnippetLines`; 0 hides snippets).
     */
    get snippetLines(): number {
      return userLimit('chat.toolSnippetLines', defaults.chat.toolSnippetLines, 0);
    },
    /**
     * Steps between executor check-ins (`myDevTeam.executor.checkpointEverySteps`;
     * 0 turns the step trigger off). The executor pauses and asks the user
     * whether to keep going after this many tool-calling steps.
     */
    get checkpointEverySteps(): number {
      return userLimit(
        'executor.checkpointEverySteps',
        defaults.executor.checkpointEverySteps,
        0
      );
    },
    /**
     * Seconds between executor check-ins
     * (`myDevTeam.executor.checkpointEverySeconds`; 0 turns the time trigger off).
     * Whichever of steps/seconds is reached first triggers the check-in.
     */
    get checkpointEverySeconds(): number {
      return userLimit(
        'executor.checkpointEverySeconds',
        defaults.executor.checkpointEverySeconds,
        0
      );
    },
    /**
     * Context-usage warning thresholds, as percentages of a model's window
     * (`myDevTeam.executor.contextWarnThresholds`). A notice fires once each time
     * a run's context first crosses one. Cleaned to whole percents in (0, 100],
     * de-duplicated and sorted ascending; an empty or all-invalid list falls back
     * to the default, so the warnings cannot be silently lost to a typo.
     */
    get contextWarnThresholds(): readonly number[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('executor.contextWarnThresholds');
      if (!Array.isArray(value)) {
        return defaults.executor.contextWarnThresholds;
      }
      const cleaned = value
        .filter(
          (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100
        )
        .map((n) => Math.floor(n));
      const unique = [...new Set(cleaned)].sort((a, b) => a - b);
      return unique.length > 0 ? unique : defaults.executor.contextWarnThresholds;
    },
  },

  /**
   * Containment for the ungated `write`/`edit` tools (tools/workspaceTools.ts).
   * The tools are deliberately ungated because a git-backed workspace makes
   * their changes recoverable - but that reasoning fails for locations that are
   * not git-tracked and that the system executes on its own, so those are
   * refused outright regardless of approval.
   */
  write: {
    /**
     * Root-relative path prefixes `write`/`edit` refuse to touch
     * (`myDevTeam.write.protectedPaths`), *in addition to* the always-protected
     * `.git/` (hardcoded in workspaceTools.ts, not user-removable: a write to
     * `.git/hooks/*` runs on the next git command, code execution that never
     * passes the run tool's approval gate). The configurable entries cover the
     * other auto-running locations (the default `.vscode`, whose tasks.json can
     * run on folder open). Each entry is matched segment by segment, so `.git`
     * does not catch `.gitignore`. Invalid entries (non-string, empty, or
     * containing `..`) make the whole list fall back to the default. An empty
     * array drops the configurable prefixes but keeps `.git` protected.
     */
    get protectedPaths(): readonly string[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('write.protectedPaths');
      if (!Array.isArray(value)) {
        return defaults.write.protectedPaths;
      }
      const valid = value.every(
        (entry) =>
          typeof entry === 'string' && entry.trim().length > 0 && !entry.includes('..')
      );
      return valid
        ? (value as string[]).map((entry) => entry.trim())
        : defaults.write.protectedPaths;
    },
  },

  /** How per-run token usage is surfaced to the user (client/usageStats.ts). */
  usage: {
    /**
     * Whether each reply ends with a `**Tokens:**` line summing the run's
     * model calls (`myDevTeam.usage.showInChat`). On by default; the
     * status-bar session total and the "Show Token Usage" report are
     * independent of this flag. Anything but the literal `false` counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('usage.showInChat') !== false
      );
    },
  },

  changes: {
    /**
     * Whether a reply that changed files ends with a `**Changes:**` line
     * summing them ("N files changed, +X -Y", `myDevTeam.changes.showInChat`).
     * On by default; the line only appears when a turn actually wrote files, so
     * it is far less chatty than the per-turn token line. Anything but the
     * literal `false` counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('changes.showInChat') !== false
      );
    },
  },

  summary: {
    /**
     * Whether an executed plan ends with a three-section **Summary** recap
     * (what ships / how it's built / tests and docs, `myDevTeam.summary.showInChat`).
     * On by default. This gates the work, not just the display: when off, the
     * engine skips the extra summarizer model call entirely, and it is skipped
     * anyway on a run that changed no files. Anything but the literal `false`
     * counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('summary.showInChat') !== false
      );
    },
  },

  thinking: {
    /**
     * Whether a reasoning model's thinking is captured while `@devteam` works
     * (`myDevTeam.thinking.showInChat`). On by default. The live "is reasoning"
     * indicator is now VS Code's own built-in progress (the rotating
     * "Thinking"/"Generating"/… verbs), shown whether or not this is on - we no
     * longer emit a custom label or the reasoning text. What this gates is the
     * work, like the summary flag: when off, the executor and answerer skip
     * capturing reasoning entirely, so there is nothing to time and no "Thought
     * for Ns" line either. Anything but the literal `false` counts as on.
     */
    get showInChatEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('thinking.showInChat') !== false
      );
    },
    /**
     * Whether to append a `_Thought for Ns_` line under a reply once a reasoning
     * model has finished thinking (`myDevTeam.thinking.showDuration`). On by
     * default. The time is measured client-side from the thinking it surfaces,
     * so it shows nothing when `thinking.showInChat` is off (no reasoning was
     * captured to time). Anything but the literal `false` counts as on.
     */
    get showDurationEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('thinking.showDuration') !== false
      );
    },
    /** Re-exposed from config/limits.ts (the engine reads it from there). */
    lineMaxChars: limits.thinking.lineMaxChars,
  },

  clarify: {
    /**
     * Whether @devteam may end a run by asking a clarifying question instead of
     * guessing on a genuinely ambiguous request (`myDevTeam.clarify.enabled`).
     * On by default; this gates the route, not just the display - when off, the
     * engine coerces a clarify decision to a normal answer so the run always
     * produces work. Anything but the literal `false` counts as on.
     */
    get enabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('clarify.enabled') !== false
      );
    },
  },

  /** The local eval log run/feedback records land in (client/evalLog.ts). */
  telemetry: {
    /**
     * Whether finished runs and 👍/👎 feedback are appended to the local eval
     * log (`myDevTeam.telemetry.evalLog`). Off by default - storing the
     * signal is opt-in. Anything but the literal `true` counts as off.
     */
    get evalLogEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('telemetry.evalLog') === true
      );
    },
    /** Cap on the eval log file, in characters; the oldest records are dropped past it. */
    evalLogMaxChars: 1_000_000,

    /**
     * Whether a slash-command run also runs triage in the background to record
     * what it would have decided (`myDevTeam.telemetry.shadowTriage`), so the
     * usage report can score triage against the pinned route. Off by default -
     * it adds one local triage call per pinned run. Only meaningful with the
     * eval log on (that is where the signal lands); the client sets the run's
     * shadow flag only when both are true. Anything but the literal `true` is off.
     */
    get shadowTriageEnabled(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('telemetry.shadowTriage') === true
      );
    },
  },

  /**
   * Whether debug logging is on (`myDevTeam.debug`). Off by default. When on,
   * every layer of a run is traced to the "My Dev Team (Debug)" output channel:
   * the client logs the client<->backend protocol traffic (the run request, the
   * stream of run events, and every `invoke` inversion - a tool, a plan review,
   * a check-in, a clarify, a skill body), and the engine logs each provider-API call (the raw request
   * messages and the response) through the injected debug sink. Read live, so
   * flipping it takes effect on the next request; only the literal `true` is on.
   * Diagnostic only - the log is verbose and carries the run's raw content, all
   * of which stays on the user's machine.
   */
  get debug(): boolean {
    return (
      vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>('debug') === true
    );
  },

  /**
   * The workspace's standing instruction file (AGENTS.md/CLAUDE.md), read by
   * the client per request and folded into the agent prompts.
   */
  instructions: {
    /**
     * Root-relative file names probed in order; the first that exists wins
     * (`myDevTeam.instructions.files`). An empty array disables the feature.
     * Only plain names are accepted - a path separator or ".." would escape
     * the workspace root, so such entries fall back to the default list.
     */
    get files(): readonly string[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('instructions.files');
      if (!Array.isArray(value)) {
        return defaults.instructions.files;
      }
      const valid = value.every(
        (name) =>
          typeof name === 'string' &&
          name.trim().length > 0 &&
          !/[\\/]/.test(name) &&
          !name.includes('..')
      );
      return valid ? (value as string[]).map((name) => name.trim()) : defaults.instructions.files;
    },
    /**
     * Max characters of the instruction file inlined into the prompts; kept
     * small because the standing rules ride along on every agent call of a
     * small local model.
     */
    maxChars: 8_000,
  },

  /**
   * The workspace's skills (named, described instruction packages the executor
   * loads on demand), read by the client per request from the configured
   * directories and shipped on the run request.
   */
  skills: {
    /**
     * Root-relative directories scanned for `<dir>/<name>/SKILL.md` files
     * (`myDevTeam.skills.directories`). An empty array disables workspace
     * skills (the built-in skills still ship). An entry that is absolute or
     * contains ".." would escape the workspace, so such a list falls back to
     * the default.
     */
    get directories(): readonly string[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('skills.directories');
      if (!Array.isArray(value)) {
        return defaults.skills.directories;
      }
      const valid = value.every(
        (dir) =>
          typeof dir === 'string' &&
          dir.trim().length > 0 &&
          !dir.includes('..') &&
          !/^([a-zA-Z]:[\\/]|[\\/])/.test(dir.trim())
      );
      return valid
        ? (value as string[]).map((dir) => dir.trim().replace(/[\\/]+$/, ''))
        : defaults.skills.directories;
    },
    /** Max skills read from the workspace in one request. */
    maxSkills: 24,
    /**
     * Max characters of one skill file: the client caps the raw text it ships
     * and the engine caps the parsed body, so a large skill cannot crowd the
     * executor's context window. Re-exposed from config/limits.ts (the engine
     * reads it from there).
     */
    maxChars: limits.skills.maxChars,
  },

  /**
   * User-configured MCP (Model Context Protocol) servers whose tools the
   * executor may call (client/mcp.ts). Servers are launched over stdio, their
   * tools discovered and offered to the model, and every call is approved
   * through the same gate as the `run` tool. Untrusted input, so no server is
   * contacted in an untrusted workspace.
   */
  mcp: {
    /**
     * The configured servers (`myDevTeam.mcp.servers`): a name -> definition
     * object map (Claude-Desktop-shaped). Each value must carry a non-empty
     * string `command`, with optional string-array `args` and string-map `env`;
     * the name must be a plain identifier (letters, digits, `_`, `-`) so it can
     * namespace the server's tools cleanly. Invalid entries are dropped rather
     * than failing - a typo in one server must not disable the rest. Empty (the
     * default, or a non-object value) turns the feature off. Read live; new
     * servers take effect on a window reload (a server is a launched process the
     * hub connects once and reuses).
     */
    get servers(): readonly McpServerConfig[] {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('mcp.servers');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [];
      }
      const out: McpServerConfig[] = [];
      for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
        const trimmed = name.trim();
        if (!/^[\w-]+$/.test(trimmed) || typeof raw !== 'object' || raw === null) {
          continue;
        }
        const entry = raw as Record<string, unknown>;
        if (typeof entry.command !== 'string' || !entry.command.trim()) {
          continue;
        }
        const args =
          Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string')
            ? (entry.args as string[])
            : undefined;
        const env =
          entry.env &&
          typeof entry.env === 'object' &&
          !Array.isArray(entry.env) &&
          Object.values(entry.env).every((v) => typeof v === 'string')
            ? (entry.env as Record<string, string>)
            : undefined;
        out.push({
          name: trimmed,
          command: entry.command.trim(),
          ...(args ? { args } : {}),
          ...(env ? { env } : {}),
        });
      }
      return out;
    },
    /** Max MCP tools offered to the model across all servers in one run. */
    maxTools: 64,
    /** How long to wait for a server to connect before skipping it, in ms. */
    connectTimeoutMs: 10_000,
    /** How long a single MCP tool call may run before it is abandoned, in ms. */
    callTimeoutMs: 60_000,
    /** Cap on an MCP tool result handed back to the model, in characters. */
    resultMaxChars: 50_000,
  },

  /**
   * Caps on the inline prompt references the client resolves into context
   * (`client/references.ts`): `#codebase` (a quick workspace search) and
   * `#changes` (the uncommitted git diff). Compile-time constants - resolving
   * is opt-in (the user types the marker), so these bound the opt-in cost.
   */
  references: {
    /** Most distinctive search terms derived from the prompt for `#codebase`. */
    codebaseMaxTerms: 4,
    /** Max matching files a `#codebase` search lists. */
    codebaseMaxFiles: 8,
    /** Of the listed files, how many include a head snippet. */
    codebaseSnippetFiles: 3,
    /** Head lines per `#codebase` snippet. */
    codebaseSnippetLines: 20,
    /** Max characters of the assembled `#codebase` attachment text. */
    codebaseMaxChars: 8_000,
    /** Max characters of the `#changes` (git diff) attachment text. */
    changesMaxChars: 12_000,
  },

  /** Max characters of an attached file/selection inlined into the prompt. */
  maxAttachmentChars: 20_000,

  /**
   * Max size, in bytes, of an attached file the handler will read at all.
   * Only `maxAttachmentChars` of it survive into the prompt anyway, so a
   * file beyond this cap is answered with a too-large notice instead of
   * being pulled fully into memory just to be thrown away.
   */
  maxAttachmentReadBytes: 10_000_000,

  /**
   * Caps on the conversation history folded into the agent prompts. The chat
   * handler keeps only the most recent turns and truncates each turn's text,
   * so a long session can never crowd a small local model's context window.
   */
  history: {
    /** Most recent prior turns kept (user prompts + the participant's replies). */
    maxTurns: 10,
    /** Max characters of one prior turn's text inlined into the prompt. */
    maxTurnChars: 2_000,
    /**
     * Coarse safety ceiling on the characters of conversation the client ships
     * for a /compact request - just so a runaway session cannot send an absurd
     * payload. It is deliberately generous: the engine does the real, window-aware
     * trim, sizing the input to the compacter model's context window (which
     * prefers a big window), so this only ever caps the truly pathological case.
     * Whole turns, untruncated, most-recent-first - far richer than the standing
     * 10x2000 follow-up view the summary used to be built from.
     */
    compactInputMaxChars: 120_000,
    /**
     * Characters of a compaction summary preserved as the standing opening turn.
     * Larger than `maxTurnChars` so the one turn that stands in for the whole
     * earlier conversation is not re-truncated to a normal turn's size - that
     * would throw away exactly the detail the compaction worked to keep.
     */
    compactSummaryMaxChars: 8_000,
    /**
     * Whether the conversation compacts itself automatically when its context
     * nears the model's window (`myDevTeam.history.autoCompact`). On by default:
     * once a run's context crosses `autoCompactThreshold`, the next turn first
     * runs /compact and proceeds against the summary, so a long session cannot
     * silently overflow. Off leaves the "Compact now" action the warnings offer
     * as the only path. Read live; anything but the literal `false` counts as on.
     */
    get autoCompact(): boolean {
      return (
        vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get<unknown>('history.autoCompact') !== false
      );
    },
    /**
     * Percent of the model's window at or above which auto-compaction triggers
     * (`myDevTeam.history.autoCompactThreshold`). Below it, a crossed
     * `executor.contextWarnThresholds` only offers a manual "Compact now"
     * action; at or above it (with `autoCompact` on) the next turn compacts
     * automatically. Cleaned to a whole percent in (0, 100], falling back to the
     * default when unset or invalid so the trigger cannot be lost to a typo.
     */
    get autoCompactThreshold(): number {
      const value = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<unknown>('history.autoCompactThreshold');
      return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
        ? Math.floor(value)
        : defaults.history.autoCompactThreshold;
    },
  },

  /** How long the activation health check waits for Ollama, in milliseconds (config/limits.ts). */
  startupProbeTimeoutMs: limits.startupProbeTimeoutMs,

  /**
   * Bounds on the sidecar engine's wire and lifecycle (client/sidecarEngine.ts,
   * client/engineFactory.ts). Compile-time constants: these protect the editor
   * from a hung or crash-looping child, not something an end user tunes.
   */
  sidecar: {
    /**
     * How long a one-shot query (`listModels`/`startupWarnings`) waits for the
     * child before rejecting, so a wedged child cannot hang the `/model` picker
     * or the activation health check forever. On a timeout the caller falls back
     * (an empty picker, or a "could not reach the engine" startup warning).
     */
    queryTimeoutMs: 10_000,
    /**
     * How long the parent holds the first run waiting for the child's `ready`
     * handshake before failing it with a clear "engine did not start" message
     * (rather than a run that hangs because the child died during module load).
     */
    readyTimeoutMs: 10_000,
    /**
     * Sliding window over which rapid child crashes are counted toward the
     * give-up threshold. A crash older than this no longer counts, so an engine
     * that ran fine for a while and then crashes once still gets respawned.
     */
    respawnWindowMs: 60_000,
    /**
     * How many child crashes within `respawnWindowMs` are tolerated before the
     * provider stops reforking and falls back to the local engine (warning
     * once), so a genuinely broken bundle cannot fork-loop. Re-armed when the
     * user switches the engine away from `sidecar` and back.
     */
    maxRespawns: 3,
  },
};

/**
 * A live view of the user-tunable settings the engine reads, shaped as the
 * injected `RuntimeConfig` (config/runtimeConfig.ts). The getters delegate to
 * `settings`, so a settings change is reflected on the next access - the
 * in-process local engine stays exactly as live as before the injection seam
 * existed. The sidecar client serializes a plain snapshot of this (the getter
 * values) to the child and re-sends it when a setting changes.
 */
export function liveRuntimeConfig(): RuntimeConfig {
  return {
    get ollamaEndpoint() {
      return settings.ollamaEndpoint;
    },
    get providerBaseUrls() {
      const map: Record<string, string | undefined> = {};
      for (const d of providerDescriptors) {
        map[d.baseUrlSetting] = settings.providerBaseUrl(d.baseUrlSetting);
      }
      return map;
    },
    get disabledProviders() {
      return settings.disabledProviders;
    },
    get disabledModels() {
      return settings.disabledModels;
    },
    get customModels() {
      return settings.customModels;
    },
    get workModel() {
      return settings.model;
    },
    get triageModel() {
      return settings.triageModel;
    },
    get triageMode() {
      return settings.triageMode;
    },
    get complexityRoutingEnabled() {
      return settings.complexityRoutingEnabled;
    },
    get requestsPerMinute() {
      return settings.provider.requestsPerMinute;
    },
    get toolSnippetLines() {
      return settings.executor.snippetLines;
    },
    get checkpointEverySteps() {
      return settings.executor.checkpointEverySteps;
    },
    get checkpointEverySeconds() {
      return settings.executor.checkpointEverySeconds;
    },
    get contextWarnThresholds() {
      return settings.executor.contextWarnThresholds;
    },
    get modelContextWindows() {
      return settings.modelContextWindows;
    },
    get planApproval() {
      return settings.planApproval;
    },
    get thinkingShowInChat() {
      return settings.thinking.showInChatEnabled;
    },
    get summaryShowInChat() {
      return settings.summary.showInChatEnabled;
    },
    get clarifyEnabled() {
      return settings.clarify.enabled;
    },
    get debugEnabled() {
      return settings.debug;
    },
  };
}

/** A plain, serializable snapshot of the live runtime config (for the sidecar). */
export function runtimeConfigSnapshot(): RuntimeConfig {
  const live = liveRuntimeConfig();
  return {
    ollamaEndpoint: live.ollamaEndpoint,
    providerBaseUrls: live.providerBaseUrls,
    disabledProviders: [...live.disabledProviders],
    disabledModels: [...live.disabledModels],
    customModels: [...live.customModels],
    workModel: live.workModel,
    triageModel: live.triageModel,
    triageMode: live.triageMode,
    complexityRoutingEnabled: live.complexityRoutingEnabled,
    requestsPerMinute: live.requestsPerMinute,
    toolSnippetLines: live.toolSnippetLines,
    checkpointEverySteps: live.checkpointEverySteps,
    checkpointEverySeconds: live.checkpointEverySeconds,
    contextWarnThresholds: live.contextWarnThresholds,
    modelContextWindows: live.modelContextWindows,
    planApproval: live.planApproval,
    thinkingShowInChat: live.thinkingShowInChat,
    summaryShowInChat: live.summaryShowInChat,
    clarifyEnabled: live.clarifyEnabled,
    debugEnabled: live.debugEnabled,
  };
}
