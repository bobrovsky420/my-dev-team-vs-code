/**
 * Compile-time operational constants the engine reads. These are *not*
 * user-tunable - they bound how much work the agents do and how previews are
 * sized - and unlike `config/settings.ts` this module imports no `vscode`, so
 * the engine can read it in any process (the in-process host or the sidecar
 * child). It is the single source for these values: `config/settings.ts`
 * references them from here so the client-facing `settings` object still
 * exposes them, without duplicating the numbers.
 *
 * User-tunable settings the engine needs (model routing, rate, approval, ...)
 * do not live here - they arrive through the injected `config/runtimeConfig.ts`
 * seam, because their values come from the user's editor and must be passed in
 * rather than read in-process.
 */
export const limits = {
  /** The built-in Ollama origin used when neither the user nor the deployment set one. */
  defaultOllamaEndpoint: 'http://localhost:11434',
  /**
   * The built-in llama.cpp (`llama-server`) origin used when neither the user nor
   * the deployment set one. The server origin only (no `/v1` suffix); the
   * provider build appends `/v1` for the OpenAI-compatible endpoint.
   */
  defaultLlamacppEndpoint: 'http://localhost:8080',
  /** How long the activation health check waits for Ollama, in milliseconds. */
  startupProbeTimeoutMs: 3_000,
  thinking: {
    /** Max characters of one condensed thinking line shown to the user. */
    lineMaxChars: 200,
  },
  provider: {
    /** How many times a rate-limited (HTTP 429) request is retried before failing the step. */
    maxRateLimitRetries: 5,
    /** Cap on a single rate-limit retry wait, in milliseconds. */
    maxRetryWaitMs: 60_000,
    /** Buffer added to a provider-suggested retry delay, in milliseconds. */
    retryBufferMs: 250,
  },
  executor: {
    /** Max model->tools->model iterations before the loop is cut off. */
    maxSteps: 1000,
    /** Max characters of a tool call's argument JSON kept in the transcript. */
    inputPreviewMaxChars: 200,
    /** Max characters of a tool result kept in the transcript. */
    resultPreviewMaxChars: 400,
  },
  skills: {
    /** Max characters of one skill body the executor inlines. */
    maxChars: 8_000,
  },
  compaction: {
    /**
     * Fraction of the compacter model's context window the conversation may fill
     * in one pass. The rest is left for the summary the model writes and the
     * prompt overhead, so a window-sized compaction cannot overflow. The
     * compacter agent (see config/agents) prefers a big-window model, so on a
     * large window this lets far more of the conversation be summarized than the
     * client's coarse safety ceiling alone would.
     */
    inputWindowFraction: 0.6,
    /**
     * When the conversation does not fit one pass, it is summarized in a rolling
     * refine: each later pass carries the briefing-so-far plus the next chunk.
     * This fraction of the per-pass budget is reserved for the carried briefing,
     * so the new chunk takes the rest - keeping briefing + chunk within the
     * window. Only engaged on a window too small to hold the whole conversation
     * (a big-window compacter summarizes in a single pass).
     */
    briefingReserveFraction: 0.4,
  },
  structuredOutput: {
    /**
     * Extra generations allowed after a schema-validation failure before the
     * step fails for real. `0` disables self-repair; `1` (the default) gives one
     * corrective retry. Mutable so tests can exercise the `0` path.
     */
    repairAttempts: 1,
  },
};
