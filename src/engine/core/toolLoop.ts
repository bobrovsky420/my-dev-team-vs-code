import { stepCountIs } from 'ai';
import type { ModelMessage } from 'ai';
import { estimateTokens, TokenCounts } from './usage';
import { limits } from '../../config/limits';
import { runtimeConfig } from '../../config/runtimeConfig';
import { CheckpointInfo, ContextWarning, ContinueDecision } from '../../protocol/types';

/**
 * The tool-calling batch loop shared by the agents that drive one (the
 * executor and the planner). It owns everything that is identical between them:
 *
 *  - batching the run into `stepCountIs` slices up to the hard
 *    `limits.executor.maxSteps` ceiling,
 *  - the periodic check-in (every `checkpointEverySteps` steps or
 *    `checkpointEverySeconds` seconds) that asks the user whether to keep going,
 *  - the wrap-up turn (tools off) when the run is cut short by a "stop" or the
 *    ceiling, so it ends with a real in-context conclusion,
 *  - usage accumulation across batches, and context-window warnings,
 *  - carrying the growing conversation forward batch over batch.
 *
 * What differs between the two agents - how each batch's chunk stream is
 * interpreted (the executor builds a transcript of events; the planner reads
 * tool calls for progress plus the streamed plan object) and how the final
 * result is assembled - stays in the agent, supplied here as `streamBatch`.
 * Keeping this loop agent-agnostic is what lets one implementation back both,
 * so the subtle checkpoint/finalize interplay lives in exactly one place.
 *
 * Editor-free by construction: it talks only to the injected `onCheckpoint`/
 * `onContextWarning` seams and plain config, never `vscode`.
 */

/**
 * Asks the user, at a periodic check-in, whether the agent should keep working
 * or stop now. The engine-side handle on the client's `RunClient.confirmContinue`.
 * Absent means the loop never checks in: it runs straight to the ceiling.
 */
export type CheckpointPrompt = (info: CheckpointInfo) => Promise<ContinueDecision>;

/** Receives a context-usage caution when the run first crosses a threshold. */
export type ContextWarningSink = (warning: ContextWarning) => void;

/** The loop-controlled options handed to `streamBatch` for one batch. */
export interface BatchControl {
  /** Stop conditions for the batch (step cap, and a time trigger when set). */
  stopWhen?: unknown;
  /** Set to "none" only for the wrap-up turn, so the model concludes, no tools. */
  toolChoice?: 'none';
  /** The run's cancellation signal, forwarded to the model call. */
  signal?: AbortSignal;
}

/** What one batch reports back so the loop can aggregate and decide what's next. */
export interface BatchResult {
  /** Tool-calling steps the batch took. */
  steps: number;
  /** The model's finish reason, when the SDK surfaced one. */
  finishReason: string | undefined;
  /** SDK-reported token counts for the batch, when any were exposed. */
  counts: TokenCounts | undefined;
  /** Response messages to carry into the next batch's context. */
  responseMessages: ModelMessage[];
}

/**
 * Runs one batch: streams the model over `messages` with the given control
 * options, drains its chunk stream (the agent-specific part - building events or
 * reading the plan object), and reports the batch's metadata. The loop pushes
 * the returned response messages onto `messages` before the next batch.
 */
export type StreamBatch = (
  messages: ModelMessage[],
  control: BatchControl
) => Promise<BatchResult>;

export interface ToolLoopOptions {
  /** The user prompt that seeds the conversation. */
  prompt: string;
  /** Runs and drains one batch (see `StreamBatch`). */
  streamBatch: StreamBatch;
  /**
   * Appended as a final user turn when the run is cut short (a "stop" or the
   * ceiling), so the model concludes in-context with tools off rather than
   * ending abruptly. The executor asks for a best answer; the planner, for the
   * plan as drafted so far.
   */
  finalizeInstruction: string;
  /** A short label of the most recent action, for the check-in prompt. */
  lastActionLabel: () => string | undefined;
  /** The run's cancellation signal. */
  signal?: AbortSignal;
  /** The check-in seam; absent means no check-ins (run to the ceiling). */
  onCheckpoint?: CheckpointPrompt;
  /** The model's context window in tokens, for warnings; absent disables them. */
  contextWindow?: number;
  /** The routed model's display label, shown in a context warning. */
  modelLabel?: string;
  /** The context-warning seam; absent disables warnings. */
  onContextWarning?: ContextWarningSink;
}

export interface ToolLoopResult {
  /** SDK-reported token counts summed across batches. */
  totals: TokenCounts;
  /** Whether any batch reported real counts (false means use an estimate). */
  anyReported: boolean;
  /** Total tool-calling steps across the run. */
  totalSteps: number;
  /** True when the run was cut short (a "stop" or the ceiling), so it finalized. */
  cutShort: boolean;
  /** The full conversation: the prompt plus every batch's carried messages. */
  messages: ModelMessage[];
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const cfg = runtimeConfig();
  // The hard runaway ceiling: total tool-calling steps a run may ever take,
  // across all batches. Check-ins happen well before it; it is the backstop for
  // when nobody is gating (no client seam, or both intervals off).
  const ceiling = Math.max(1, limits.executor.maxSteps);
  // Check-ins only when the client offered the seam. Either interval may be off
  // (0); whichever non-zero one is reached first ends a batch.
  const stepInterval = options.onCheckpoint ? Math.max(0, cfg.checkpointEverySteps) : 0;
  const timeoutMs = options.onCheckpoint ? Math.max(0, cfg.checkpointEverySeconds) * 1000 : 0;
  const checksIn = options.onCheckpoint !== undefined && (stepInterval > 0 || timeoutMs > 0);

  // The running conversation. It grows by each batch's response messages, so a
  // batch that follows a "continue" (or the wrap-up turn) picks up with the full
  // context the model built - not just the truncated transcript previews.
  const messages: ModelMessage[] = [{ role: 'user', content: options.prompt }];

  // SDK-reported usage summed across batches; an estimate fills in at the end
  // only when no batch reported anything (so a local model that exposes no
  // counts still contributes one record rather than leaving a gap).
  const totals: TokenCounts = {};
  let anyReported = false;
  const addUsage = (counts: TokenCounts | undefined): void => {
    if (!counts) {
      return;
    }
    anyReported = true;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cachedInputTokens',
      'totalTokens',
    ] as const) {
      const value = counts[key];
      if (value !== undefined) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
  };

  // Context-usage warnings: the model's window, the thresholds to warn at, and
  // the most recent batch's reported input-token count - the closest real
  // measure of how full the window is. Skipped when nobody listens or the window
  // is unknown.
  const contextWindow = options.onContextWarning ? options.contextWindow : undefined;
  const thresholds = contextWindow ? [...cfg.contextWarnThresholds] : [];
  let nextThreshold = 0;
  let lastInputTokens: number | undefined;
  // Warn once for the highest threshold the current context usage has crossed.
  // Usage is the last batch's reported input tokens, or a rough estimate over the
  // carried messages when the provider reports none (flagged `estimated`).
  const checkContext = (): void => {
    if (!options.onContextWarning || !contextWindow || nextThreshold >= thresholds.length) {
      return;
    }
    const estimated = lastInputTokens === undefined;
    const used = estimated ? estimateTokens(JSON.stringify(messages)) : lastInputTokens!;
    const percent = (used / contextWindow) * 100;
    let crossed = -1;
    while (nextThreshold < thresholds.length && percent >= thresholds[nextThreshold]) {
      crossed = thresholds[nextThreshold];
      nextThreshold++;
    }
    if (crossed >= 0) {
      options.onContextWarning({
        model: options.modelLabel ?? '',
        threshold: crossed,
        percent: Math.round(percent),
        usedTokens: Math.round(used),
        contextWindow,
        estimated,
      });
    }
  };

  // Fold one batch's report into the shared state: carry its messages, add its
  // usage, and track the latest input-token count for the context check.
  const absorb = (result: BatchResult): void => {
    messages.push(...result.responseMessages);
    addUsage(result.counts);
    if (result.counts?.inputTokens !== undefined) {
      lastInputTokens = result.counts.inputTokens;
    }
  };

  const startTime = Date.now();
  let totalSteps = 0;
  // True when the run ends mid-work (user "stop" or the ceiling), so a wrap-up
  // turn is needed; false only when the model finished on its own.
  let cutShort = false;
  for (;;) {
    const remaining = ceiling - totalSteps;
    if (remaining <= 0) {
      cutShort = true;
      break;
    }
    // A batch runs until the step interval, or to the ceiling when the step
    // trigger is off; a time condition (when on) can end it sooner.
    const batchCap = stepInterval > 0 ? Math.min(stepInterval, remaining) : remaining;
    const batchStart = Date.now();
    let timedOut = false;
    const stopWhen: Array<unknown> = [stepCountIs(batchCap)];
    if (timeoutMs > 0) {
      stopWhen.push(() => {
        if (Date.now() - batchStart >= timeoutMs) {
          timedOut = true;
          return true;
        }
        return false;
      });
    }

    const result = await options.streamBatch(messages, { stopWhen, signal: options.signal });
    absorb(result);
    totalSteps += result.steps;
    checkContext();

    // Whether a stop condition actually ended the batch (vs the model finishing
    // on its own). `finishReason === 'stop'` is the model concluding; running the
    // full batch budget (or the time trigger firing) is a cut-off. Fewer steps
    // than the cap with no timeout means a natural finish.
    const cutByBudget = result.steps >= batchCap || timedOut;
    if (result.finishReason === 'stop' || !cutByBudget) {
      break;
    }
    // The batch was cut off by a stop condition. At the ceiling, or with no
    // check-in seam, wrap up rather than ask.
    if (totalSteps >= ceiling || !checksIn) {
      cutShort = true;
      break;
    }
    const lastAction = options.lastActionLabel();
    const decision = await options.onCheckpoint!({
      stepsDone: totalSteps,
      secondsElapsed: Math.round((Date.now() - startTime) / 1000),
      ...(lastAction ? { lastAction } : {}),
    });
    if (decision.kind === 'stop') {
      cutShort = true;
      break;
    }
    // "continue": loop into the next batch with the accumulated context.
  }

  // Cut short by the user or the ceiling: ask the model to conclude in-context
  // with tools turned off, so the run yields a real result instead of an abrupt,
  // resultless stop.
  if (cutShort) {
    messages.push({ role: 'user', content: options.finalizeInstruction });
    absorb(await options.streamBatch(messages, { toolChoice: 'none', signal: options.signal }));
    checkContext();
  }

  return { totals, anyReported, totalSteps, cutShort, messages };
}
