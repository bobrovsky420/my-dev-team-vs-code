/**
 * The run event stream - the engine-to-client half of the protocol - and the
 * fold that rebuilds reply snapshots from it on the client.
 *
 * Events are the stable contract: a remote engine will serialize exactly
 * these over the wire (one SSE stream per run), and the LocalEngine emits the
 * same shapes in-process, so the client cannot tell the engines apart. Events
 * carry only user-visible content; deltas and per-event snapshots keep the
 * wire traffic linear in the reply size.
 *
 * This is a one-way stream: events flow engine->client and are never answered.
 * The other direction - the engine asking the client to *do* something and
 * waiting for a result (run a tool, approve a plan, a check-in, a clarifying
 * question, a skill body) - is not an event; it crosses the `ClientHost.invoke`
 * seam (see capabilities.ts), carried over the wire as its own request message.
 */
import {
  Complexity,
  ContextWarning,
  ExecutionEvent,
  Intent,
  ModelSelection,
  PartialPlan,
  PartialSummary,
  Reply,
  ReplyProgress,
} from './types';

/**
 * The protocol's name for the stage a run is in, used by usage and error
 * events. Deliberately not the engine's internal step ids: those are
 * implementation detail and may change without a protocol bump.
 */
export type RunStep = 'triage' | 'plan' | 'answer' | 'execute' | 'summarize';

/**
 * Estimated input-token attribution for one model call, split by the prompt
 * section the tokens came from - what the user can actually trim. Every field
 * is an estimate (a length-based count of that section's text, since the SDK
 * reports only a single total), and every field is optional: a section absent
 * from the prompt simply does not appear. The sections mirror how the workflow
 * assembles a prompt (project instructions, then conversation, the slash
 * command's preamble, the prompt itself, the inlined attachments, and - for the
 * executor - the available-skills catalogue and the drafted plan).
 */
export interface InputBreakdown {
  instructions?: number;
  history?: number;
  preamble?: number;
  prompt?: number;
  attachments?: number;
  /** The executor's "Available skills" catalogue (names + descriptions). */
  skills?: number;
  plan?: number;
}

/** The events an engine emits over the lifetime of one run, in order. */
export type RunEvent =
  /**
   * Triage decided how to route the request. Always the first event.
   * `complexity` rides along when triage judged it (or a command supplied a
   * default); it sizes the executor's model. Optional so a client that ignores
   * it loses nothing.
   */
  | { type: 'triaged'; intent: Intent; reason: string; complexity?: Complexity }
  /**
   * Shadow triage: on a slash-command run that pinned the route, what triage
   * would have decided had it run. Emitted only when the request asked for it
   * (`RunRequest.shadowTriage`); carries no rendering, only the labelled signal
   * the eval log records to score triage against the pinned route. A client
   * that does not know it simply ignores it.
   */
  | { type: 'triage-shadow'; predicted: Intent }
  /**
   * Which model(s) the engine selected for the run, emitted right after
   * `triaged` (the route determines which steps run). Surfaces the "which
   * model answered" line, and tells the user when Auto picked for them. An
   * additive event: a client that does not know it simply ignores it.
   */
  | { type: 'model-selected'; selection: ModelSelection }
  /**
   * The plan as drafted so far. Snapshots, not deltas: a partial plan is
   * small, and the partial-JSON stream it comes from revises fields in place.
   */
  | { type: 'plan-snapshot'; plan: PartialPlan }
  /** The next chunk of the streamed oneshot answer. */
  | { type: 'answer-delta'; text: string }
  /**
   * A condensed, user-facing line of the model's current reasoning - the
   * "important piece" of its thinking, not the raw chain of thought (the engine
   * reduces a reasoning model's verbose `<think>` monologue to one line before
   * emitting; see engine/core/thinking.ts). Ephemeral by design: it is a live
   * status signal like a spinner, carried as its own side-channel event (the
   * way `usage` and `triage-shadow` are), never folded into a reply snapshot
   * and never preserved past the run. `ReplyFolder` ignores it; a client that
   * does not know it simply shows no thinking.
   */
  | { type: 'thinking'; text: string }
  /**
   * A one-way caution that the run's context is filling the model's window,
   * emitted once each time usage crosses a configured threshold. Like `thinking`
   * it is a side-channel signal, never folded into a reply snapshot; a client
   * that does not know it simply shows no context warning.
   */
  | { type: 'context-warning'; warning: ContextWarning }
  /**
   * Transcript event `index` was appended or changed. Execution transcripts
   * are grow-only with only the last event still mutating (text grows, a tool
   * call gains its result), so re-sending one indexed event at a time keeps
   * the stream linear in the transcript size.
   */
  | { type: 'execution-event'; index: number; event: ExecutionEvent }
  /**
   * The end-of-run summary as the model writes it. Snapshots, not deltas:
   * a partial summary is small (three growing strings) and the partial-JSON
   * stream it comes from revises fields in place.
   */
  | { type: 'summary-snapshot'; summary: PartialSummary }
  /**
   * Metering record for one step's model call: the billing seam. A side is
   * omitted when neither the SDK reported it nor an estimate covers it;
   * `estimated` is set when the counts are a length-based estimate rather than
   * SDK-reported. `model` is the concrete model name locally and may be an
   * opaque tier label remotely. The extra token fields (reasoning, cached
   * input, the provider total) ride along only when the SDK exposes them, so a
   * client that ignores them loses nothing.
   */
  | {
      type: 'usage';
      step: RunStep;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      totalTokens?: number;
      estimated?: boolean;
      /**
       * Estimated split of the input tokens by prompt section, attached for the
       * steps that assemble a full prompt (plan/answer/execute); absent for
       * triage, which sees only attachment labels.
       */
      inputBreakdown?: InputBreakdown;
      /**
       * Set when this record is a self-repair retry: the step's first
       * generation failed schema validation, so the engine re-asked with the
       * error appended. The retry's tokens count like any other, and this flag
       * lets the eval log measure how often structured output needs repair. A
       * client that ignores it loses nothing.
       */
      repaired?: boolean;
    }
  /** The run finished; `reply` is the complete validated result. */
  | { type: 'done'; reply: Reply }
  /**
   * The run failed. `step` names the stage when it is known; `hint` is an
   * optional engine-supplied troubleshooting line (the LocalEngine points at
   * Ollama and the routed model - knowledge only the engine has).
   */
  | { type: 'error'; step?: RunStep; message: string; hint?: string };

/**
 * Rebuilds grow-only `ReplyProgress` snapshots from the event stream, so the
 * client's renderer works on the same shape the engine's workflow produces
 * internally and local/remote runs render identically.
 *
 * `apply` returns the updated snapshot when the event changed what should be
 * rendered, and undefined for events that do not (usage, tool-call, and
 * anything arriving before the triage decision). The returned object is the
 * folder's live state: render it synchronously, do not retain it.
 */
export class ReplyFolder {
  private progress: ReplyProgress | undefined;

  apply(event: RunEvent): ReplyProgress | undefined {
    if (event.type === 'triaged') {
      this.progress = {
        intent: event.intent,
        reason: event.reason,
        ...(event.complexity ? { complexity: event.complexity } : {}),
      };
      return this.progress;
    }
    if (!this.progress) {
      return undefined;
    }
    switch (event.type) {
      case 'model-selected':
        this.progress.selection = event.selection;
        return this.progress;
      case 'plan-snapshot':
        this.progress.plan = event.plan;
        return this.progress;
      case 'answer-delta':
        this.progress.answer = (this.progress.answer ?? '') + event.text;
        return this.progress;
      case 'execution-event': {
        const execution = (this.progress.execution ??= { events: [] });
        execution.events[event.index] = event.event;
        return this.progress;
      }
      case 'summary-snapshot':
        this.progress.summary = event.summary;
        return this.progress;
      case 'done':
        // The final validated reply supersedes whatever was folded so far.
        this.progress = { ...event.reply };
        return this.progress;
      default:
        return undefined;
    }
  }
}
