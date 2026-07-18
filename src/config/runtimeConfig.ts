/**
 * The engine's runtime configuration seam: the user-tunable settings the engine
 * actually reads, injected rather than read in-process. This module imports no
 * `vscode`, so the engine can run wherever - in the extension host (the local
 * engine) or in a separate process (the sidecar child) - and still get the
 * user's choices.
 *
 * Who sets it:
 *  - in the host, the client injects a *live view* backed by `config/settings.ts`
 *    (so a settings change takes effect on the next request, as before);
 *  - in the sidecar child, the parent sends a serialized snapshot at startup and
 *    again whenever the user changes a setting, and the child re-injects it.
 *
 * It lives in `config/` (the shared layer, like `config/providers.ts`) so both
 * the engine and the client config layer can import it without breaking the
 * engine import discipline. Until something injects, a built-in default matching
 * the shipped settings keeps reads safe.
 */

/**
 * A user-supplied model definition (`myDevTeam.customModels`), carried as the
 * raw object the user wrote so the engine - the one place that owns the model
 * schema - validates it. Lets a user register a model the build did not ship
 * (e.g. a newly released Anthropic model) without republishing the extension:
 * it can only *add* models for an already-wired provider, never redefine a
 * built-in one or add a new provider. Plain, serializable data.
 */
export type CustomModelInput = Readonly<Record<string, unknown>>;

/** The user-tunable settings the engine reads. Plain, serializable data. */
export interface RuntimeConfig {
  /** The user's `myDevTeam.ollama.endpoint`, or undefined when unset. */
  ollamaEndpoint: string | undefined;
  /** Per-provider base-URL overrides, keyed by the descriptor `baseUrlSetting`. */
  providerBaseUrls: Record<string, string | undefined>;
  /** Providers the user disabled (`myDevTeam.disabledProviders`). */
  disabledProviders: readonly string[];
  /** Model ids the user disabled (`myDevTeam.disabledModels`). */
  disabledModels: readonly string[];
  /**
   * Extra models the user registered (`myDevTeam.customModels`), validated and
   * merged on top of the built-in registry by the engine. Add-only: an entry
   * whose id collides with a built-in (or an earlier custom entry) is dropped.
   */
  customModels: readonly CustomModelInput[];
  /**
   * The user's work-agent model choice (`myDevTeam.model`): a registry id, a
   * `provider:<name>` pin, or "auto". The work agents receive it per request as
   * the run's pin; the engine also reads it here so the shared triage step and
   * the requestless startup probe can let it stand in as triage's default when
   * `triageModel` is unset (a concrete work model cascades to triage; "auto"
   * defers to the backend floor). Defaults to "auto".
   */
  workModel: string;
  /** The user's triage model choice (`myDevTeam.triage.model`); empty defers to the work model, then the backend floor. */
  triageModel: string;
  /**
   * How the request is routed (`myDevTeam.triage.mode`): `classifier` (the
   * default) runs the cheap triage agent first, then the answerer or planner;
   * `combined` runs a single responder that does triage and produces the answer
   * or plan in one model call (the unpinned path only - a slash command still
   * pins the route and uses the dedicated agents).
   */
  triageMode: 'classifier' | 'combined';
  /** Whether complexity routing is on (`myDevTeam.complexityRouting`). */
  complexityRoutingEnabled: boolean;
  /** The user's request-rate override (`myDevTeam.provider.requestsPerMinute`), or undefined. */
  requestsPerMinute: number | undefined;
  /** Leading snippet lines shown under a write/edit in the transcript (`myDevTeam.chat.toolSnippetLines`). */
  toolSnippetLines: number;
  /** Steps between executor check-ins (`myDevTeam.executor.checkpointEverySteps`; 0 disables). */
  checkpointEverySteps: number;
  /** Seconds between executor check-ins (`myDevTeam.executor.checkpointEverySeconds`; 0 disables). */
  checkpointEverySeconds: number;
  /** Context-usage warning thresholds as window percentages (`myDevTeam.executor.contextWarnThresholds`). */
  contextWarnThresholds: readonly number[];
  /** Per-model context-window overrides keyed by registry id (`myDevTeam.modelContextWindows`). */
  modelContextWindows: Readonly<Record<string, number>>;
  /** When a drafted plan must be approved (`myDevTeam.planApproval`). */
  planApproval: 'auto' | 'always' | 'never';
  /** Whether to capture and show a model's thinking (`myDevTeam.thinking.showInChat`). */
  thinkingShowInChat: boolean;
  /** Whether to run the end-of-run summarizer (`myDevTeam.summary.showInChat`). */
  summaryShowInChat: boolean;
  /**
   * Whether the engine may route a genuinely ambiguous request to the "clarify"
   * path - ending the run by asking the user instead of guessing
   * (`myDevTeam.clarify.enabled`). When off, a clarify decision is coerced to a
   * normal answer, so the run always produces work rather than a question.
   */
  clarifyEnabled: boolean;
  /**
   * Whether debug logging is on (`myDevTeam.debug`). When set, the engine logs
   * every provider-API call (the raw request messages and the response) through
   * the injected debug sink (`config/debugLog.ts`); the client logs the
   * client<->backend protocol traffic on its side. Off by default - the log is
   * verbose and carries the run's raw content.
   */
  debugEnabled: boolean;
}

/** Sane defaults matching the shipped settings, used until something injects. */
const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  ollamaEndpoint: undefined,
  providerBaseUrls: {},
  disabledProviders: [],
  disabledModels: [],
  customModels: [],
  workModel: 'auto',
  triageModel: '',
  triageMode: 'classifier',
  complexityRoutingEnabled: true,
  requestsPerMinute: undefined,
  toolSnippetLines: 5,
  checkpointEverySteps: 10,
  checkpointEverySeconds: 600,
  contextWarnThresholds: [80, 90, 95],
  modelContextWindows: {},
  planApproval: 'auto',
  thinkingShowInChat: true,
  summaryShowInChat: true,
  clarifyEnabled: true,
  debugEnabled: false,
};

let current: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;

/** Inject the runtime config the engine reads (a live view in the host, a snapshot in the child). */
export function setRuntimeConfig(config: RuntimeConfig): void {
  current = config;
}

/** The runtime config the engine reads. Never throws; returns the defaults until injected. */
export function runtimeConfig(): RuntimeConfig {
  return current;
}
