import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Triage, TriageSchema } from './triage';
import { Planner, PlanProgress } from './planner';
import { Responder, ResponderProgressSink } from './responder';
import { Answerer } from './answerer';
import { Executor, ExecutionProgress } from './executor';
import { Summarizer, SummaryProgress } from './summarizer';
import { AgentUsage, estimateTokens } from './usage';
import { commandConfigs, pinnedReason, CommandConfig } from '../config/commands';
import { resolveSkills, renderSkillsSection, SkillSummary } from '../config/skills';
import { runtimeConfig } from '../../config/runtimeConfig';
import { normalizeQuestions } from './clarify';
import {
  Attachment,
  AttachmentSchema,
  CheckpointInfo,
  ClarifyQuestion,
  ClarifyQuestionSchema,
  Complexity,
  ComplexitySchema,
  ContextWarning,
  ContinueDecision,
  Execution,
  HistoryTurn,
  HistoryTurnSchema,
  Intent,
  Plan,
  PlanDecision,
  ProjectInstructionsSchema,
  ReplyProgress,
  ReplySchema,
  Reply,
  WorkspaceSkillSchema,
} from '../../protocol/types';
import { InputBreakdown, RunStep } from '../../protocol/events';

export type {
  Attachment,
  HistoryTurn,
  ProjectInstructions,
  ReplyProgress,
} from '../../protocol/types';

/**
 * Step ids of the dev-team workflow. Engine-internal: the LocalEngine maps a
 * failed step onto the protocol's RunStep names, so nothing outside the
 * engine depends on these strings.
 */
export const stepIds = {
  triage: 'triage',
  plan: 'draft-plan',
  answer: 'answer-directly',
  /**
   * The combined-mode step: one model call does triage and produces either the
   * answer or the plan, replacing the triage + draft-plan/answer-directly trio.
   * Only the combined workflow has it (see createDevTeamWorkflow).
   */
  respond: 'respond',
  /**
   * The direct route's branch arm (classifier mode): a small, well-specified
   * change that skips the planner and goes straight to the execute step with no
   * plan. A pass-through that just surfaces the route and carries the request.
   */
  direct: 'stage-direct',
  /**
   * The clarify route's branch arm: a terminal pass-through that carries the
   * questions to ask the user. Like the direct stage it surfaces the route and
   * carries the request, but it never reaches the executor - the run ends with
   * the questions and the user's reply continues it on the next turn.
   */
  clarify: 'stage-clarify',
  execute: 'execute-plan',
  deliver: 'deliver-answer',
} as const;

/**
 * What the workflow consumes: the user's prompt plus any attached
 * files/selections, the prior turns of the conversation, and the slash
 * command the user invoked, if any. They stay separate so each step can
 * decide how much of each its model actually needs to see - important with
 * small local Ollama models, whose context windows a single attached file can
 * easily crowd out.
 */
export const RequestSchema = z.object({
  prompt: z.string(),
  instructions: ProjectInstructionsSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  history: z.array(HistoryTurnSchema).optional(),
  /**
   * Workspace skills the client read (raw SKILL.md text). Only the executor
   * consumes them: the execute step merges them with the built-in skills and
   * lists each skill's name + description, loading a body on demand.
   */
  skills: z.array(WorkspaceSkillSchema).optional(),
  command: z.string().optional(),
  /**
   * Run triage even when a command pins the route, keeping the pin but
   * reporting triage's prediction (see RunRequest.shadowTriage). Off unless the
   * client asked for the triage-accuracy signal.
   */
  shadowTriage: z.boolean().optional(),
});
export type RequestInput = z.infer<typeof RequestSchema>;

/**
 * The registered config of the request's slash command. An unknown command
 * name (a client newer than this engine) resolves to undefined: the prompt is
 * then treated as plain text, so version skew degrades, never breaks.
 */
function commandFor(input: RequestInput): CommandConfig | undefined {
  return input.command ? commandConfigs[input.command] : undefined;
}

/**
 * The prior turns rendered as a clearly delimited conversation section, so a
 * follow-up like "now rename it too" carries the turns that say what "it" is.
 * Every agent prompt gets the same section (triage included: a follow-up
 * cannot be routed without the conversation it follows); the per-turn and
 * turn-count caps were already applied when the turns were collected.
 */
function historySection(history: HistoryTurn[]): string {
  const turns = history.map(
    (turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`
  );
  return `--- Conversation so far ---\n${turns.join('\n\n')}\n--- End of conversation ---`;
}

/** Prepend the conversation section when there is one; the bare body otherwise. */
function withHistory(input: RequestInput, body: string): string {
  const history = input.history ?? [];
  return history.length === 0 ? body : `${historySection(history)}\n\n${body}`;
}

/**
 * Prepend the project-instructions section (the workspace's AGENTS.md or
 * CLAUDE.md, read by the client) ahead of everything else, then the
 * conversation. First place is deliberate: the instructions are the most
 * stable content across turns, so leading with them keeps the longest prompt
 * prefix unchanged turn over turn - exactly what prefix caches reuse -
 * while the growing history and the per-turn prompt follow.
 */
function withStandingContext(input: RequestInput, body: string): string {
  const rest = withHistory(input, body);
  if (!input.instructions) {
    return rest;
  }
  const { source, text } = input.instructions;
  return `--- Project instructions (${source}) ---\n${text}\n--- End of project instructions ---\n\n${rest}`;
}

/**
 * The prompt the triage agent sees: the conversation so far, the question,
 * and attachment names only. Triage just routes oneshot vs planning, so
 * inlining file contents would waste tokens and, on a small local model, push
 * the actual question out of the context window - but it does get the (capped)
 * history, because a follow-up cannot be routed without it.
 */
export function triagePrompt(input: RequestInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return withHistory(input, input.prompt);
  }
  const labels = attachments.map((a) => a.label).join('; ');
  return withHistory(
    input,
    `${input.prompt}\n\n(The user attached context, contents omitted here: ${labels})`
  );
}

/**
 * The prompt the planner and answerer see: the project instructions (when the
 * workspace has an AGENTS.md/CLAUDE.md), the conversation so far, the slash
 * command's preamble (when one was invoked - the preamble frames the request,
 * e.g. /fix's diagnose-first briefing), the question, and the full attachment
 * text, one fenced block per attachment. Triage sees neither the preamble nor
 * the instructions: a known command pins the route and skips triage, and
 * routing oneshot-vs-planning needs no standing conventions - on a small
 * local model they would only crowd out the question.
 */
export function fullPrompt(input: RequestInput): string {
  const preamble = commandFor(input)?.preamble;
  const prompt = preamble ? `${preamble}\n\n${input.prompt}` : input.prompt;
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return withStandingContext(input, prompt);
  }
  const blocks = attachments.map((a) => `${a.label}\n\`\`\`\n${a.text}\n\`\`\``);
  return withStandingContext(
    input,
    `${prompt}\n\n--- Attached context ---\n${blocks.join('\n\n')}`
  );
}

/**
 * The prompt the executor sees: the full request (prompt + attachment text,
 * same as the planner saw), the catalogue of available skills (name +
 * description only - the executor loads a body on demand via its `skill` tool),
 * and the plan it is asked to carry out, rendered as a numbered list of titles
 * and details. Steps name no tool - the executor chooses how to carry each one
 * out. The skills section is omitted when no skill is available.
 */
export function executionPrompt(
  input: RequestInput,
  plan: Plan | undefined,
  skills: readonly SkillSummary[] = []
): string {
  const skillsSection = renderSkillsSection(skills);
  // The planning route briefs the executor with the drafted plan; the direct
  // route (a small, well-specified change) has none, so it is told to carry out
  // the request directly instead.
  const task = plan
    ? `--- Drafted plan ---\n${planText(plan)}`
    : `--- Task ---\nNo plan was drafted: this is a small, well-specified change. ` +
      `Carry out the request above directly with the tools, then report what you did.`;
  return [fullPrompt(input), skillsSection, task].filter(Boolean).join('\n\n');
}

/**
 * The planner prompt for a revision: the same full prompt it first saw, plus a
 * delimited section carrying the user's review comment from the approval gate.
 * The planner re-drafts a fresh plan (the comment is untrusted task input, like
 * an attachment), which re-streams over the snapshots already shown.
 */
export function revisionPrompt(input: RequestInput, comment: string): string {
  return (
    `${fullPrompt(input)}\n\n` +
    `--- Plan review ---\n` +
    `The user reviewed your drafted plan and did not approve it. They asked for ` +
    `this change:\n${comment}\n` +
    `Draft a fresh plan that addresses it (summary, steps, and complexity).`
  );
}

/** The drafted plan rendered for a prompt: the summary then the numbered steps. */
function planText(plan: Plan): string {
  const steps = plan.steps
    .map((step, i) => `${i + 1}. ${step.title} - ${step.detail}`)
    .join('\n');
  return `${plan.summary}\n${steps}`;
}

/**
 * The execution transcript rendered for the summarizer's prompt: one line per
 * tool call (name, input preview, and result or a `[failed]` marker) and the
 * model's interleaved commentary, in order. Progress checklists are dropped -
 * they are a live UI affordance, not part of what changed.
 */
function transcriptText(execution: Execution): string {
  return execution.events
    .map((event) => {
      if (event.kind === 'text') {
        return event.text;
      }
      if (event.kind === 'tool') {
        const result = event.failed ? '[failed]' : event.result ?? '';
        return `- ${event.tool} ${event.input}${result ? ` => ${result}` : ''}`;
      }
      return undefined;
    })
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

/**
 * The prompt the summarizer sees: the user's request and standing context (the
 * same prefix the other agents got), the drafted plan, and the execution
 * transcript it should recap. The transcript is the source of truth for what
 * actually happened, so it comes last and clearly delimited.
 */
export function summaryPrompt(
  input: RequestInput,
  plan: Plan | undefined,
  execution: Execution
): string {
  const planSection = plan ? `--- Drafted plan ---\n${planText(plan)}\n\n` : '';
  return (
    `${fullPrompt(input)}\n\n` +
    planSection +
    `--- Execution transcript ---\n${transcriptText(execution)}`
  );
}

/**
 * Whether the execution actually changed files: any successful `write` or
 * `edit` tool call in the transcript. The summary recaps a change, so a run
 * that only read/searched/ran commands (or whose every write failed or was
 * declined) has nothing to summarize and the step is skipped.
 */
function executionChangedFiles(execution: Execution): boolean {
  return execution.events.some(
    (event) =>
      event.kind === 'tool' &&
      (event.tool === 'write' || event.tool === 'edit') &&
      !event.failed &&
      event.result !== undefined
  );
}

/** The attachments inlined as the prompt sees them: each label above its text. */
function attachmentsText(input: RequestInput): string {
  return (input.attachments ?? []).map((a) => `${a.label}\n${a.text}`).join('\n\n');
}

/**
 * Estimated input-token attribution for a full-prompt step (plan/answer/
 * execute), section by section - the data that tells a user what to trim. Each
 * field is a length-based estimate of that section's content text (delimiters
 * and the agent's system prompt are excluded: they are fixed overhead the user
 * cannot change). A section that is empty or absent is omitted. The sources
 * mirror the assembly in `fullPrompt`/`executionPrompt`, so the split tracks
 * what is actually sent. `plan` and `skills` are supplied only for the executor
 * step (`skills` is the available-skills catalogue rendered into its prompt).
 */
export function inputBreakdown(
  input: RequestInput,
  plan?: Plan,
  skills: readonly SkillSummary[] = []
): InputBreakdown {
  const breakdown: InputBreakdown = {};
  const add = (key: keyof InputBreakdown, text: string | undefined) => {
    if (!text) {
      return;
    }
    const tokens = estimateTokens(text);
    if (tokens > 0) {
      breakdown[key] = tokens;
    }
  };
  const history = input.history ?? [];
  add('instructions', input.instructions?.text);
  add('history', history.length > 0 ? historySection(history) : undefined);
  add('preamble', commandFor(input)?.preamble);
  add('prompt', input.prompt);
  add('attachments', (input.attachments ?? []).length > 0 ? attachmentsText(input) : undefined);
  add('skills', skills.length > 0 ? renderSkillsSection(skills) : undefined);
  if (plan) {
    add('plan', planText(plan));
  }
  return breakdown;
}

/**
 * Triage decision carried forward to the branch steps. Complexity is relaxed to
 * optional here: triage's generation schema requires it (the model is asked for
 * it), but the carried plumbing tolerates its absence so a model that omits it
 * degrades to capability-only executor routing rather than failing the run.
 */
const TriagedSchema = RequestSchema.extend(TriageSchema.shape).extend({
  complexity: ComplexitySchema.optional(),
  // Override TriageSchema's generation-shaped `questions` (which carries
  // describe() prompt material and a min/max on options) with the protocol's
  // wire shape: the triage step normalises the model's questions to this before
  // carrying them, and the clarify route delivers exactly this to the client.
  questions: z.array(ClarifyQuestionSchema).optional(),
});

/**
 * What the workflow produces is the protocol's Reply: the routing decision
 * plus, for "planning" requests, the drafted plan and the execution
 * transcript, or, for "oneshot" requests, the direct answer. Using the
 * protocol schema as the output schema is the guarantee that the engine
 * cannot produce a reply the contract does not describe.
 */
export type ReplyResult = Reply;

/**
 * The reply plus the original request, used between the two branch stages:
 * the execute step still needs the prompt and attachments to brief the
 * executor, so the branch steps carry them forward and the final steps strip
 * them off again.
 */
const StagedReplySchema = RequestSchema.extend(ReplySchema.shape).extend({
  /**
   * Engine-internal flag carried from draft-plan to the execute branch: false
   * when the user cancelled at the approval gate, so `shouldExecute` routes to
   * deliver-answer (plan-only) instead of executing. Not part of the protocol
   * reply - the final steps strip it off.
   */
  proceed: z.boolean().optional(),
});
type StagedReply = z.infer<typeof StagedReplySchema>;

/** Receives reply snapshots as the workflow streams them. Must not throw. */
export type ReplyProgressSink = (progress: ReplyProgress) => void;

/**
 * RequestContext key under which a caller may pass a `ReplyProgressSink` to
 * `run.start`. The context is Mastra's per-run dependency channel, so the
 * sink reaches the steps without widening the input schema.
 */
export const replyProgressKey = 'onReplyProgress';

function progressSink(requestContext: RequestContext): ReplyProgressSink | undefined {
  return requestContext.get(replyProgressKey) as ReplyProgressSink | undefined;
}

/**
 * One step's metering record: the agent's usage report plus which protocol
 * step it came from. The LocalEngine forwards these as the protocol's usage
 * events - the billing seam.
 */
export type StepUsage = { step: RunStep; inputBreakdown?: InputBreakdown } & AgentUsage;

/** Receives per-step usage reports. Must not throw. */
export type UsageSink = (usage: StepUsage) => void;

/**
 * RequestContext key under which a caller may pass a `UsageSink` to
 * `run.start`. Reporting is best-effort: a step whose model call exposes no
 * token counts simply never calls the sink.
 */
export const usageSinkKey = 'onUsage';

function usageSink(requestContext: RequestContext): UsageSink | undefined {
  return requestContext.get(usageSinkKey) as UsageSink | undefined;
}

/**
 * Adapt the run's UsageSink into one agent's reporter, tagging the step and -
 * for the full-prompt steps - the estimated input-token split by section, so
 * the metering record can attribute input tokens to their source.
 */
function usageReporter(
  requestContext: RequestContext,
  step: RunStep,
  breakdown?: InputBreakdown
): ((usage: AgentUsage) => void) | undefined {
  const sink = usageSink(requestContext);
  return (
    sink &&
    ((usage) => sink({ step, ...(breakdown ? { inputBreakdown: breakdown } : {}), ...usage }))
  );
}

/**
 * Receives a condensed line of the model's current reasoning as it works. A
 * side-channel like the usage sink, not part of the reply snapshot: thinking is
 * ephemeral (the LocalEngine forwards each line as a `thinking` event the UI
 * shows as transient progress) and never lands in the durable reply. Must not
 * throw.
 */
export type ThinkingSink = (line: string) => void;

/**
 * RequestContext key under which a caller may pass a `ThinkingSink`. The
 * execute and answer steps hand it to their agent so a reasoning model's
 * thinking surfaces live; absent (or with the setting off) the steps simply do
 * not capture reasoning.
 */
export const thinkingSinkKey = 'onThinking';

function thinkingSink(requestContext: RequestContext): ThinkingSink | undefined {
  return requestContext.get(thinkingSinkKey) as ThinkingSink | undefined;
}

/**
 * Receives a context-usage caution when the executor's run first crosses a
 * configured threshold of the model's window. A side-channel like the thinking
 * and usage sinks: the LocalEngine forwards each as a `context-warning` event,
 * never folded into the reply. Must not throw.
 */
export type ContextWarningSink = (warning: ContextWarning) => void;

/**
 * RequestContext key under which a caller may pass a `ContextWarningSink`. The
 * execute step hands it to the executor, which decides when to warn from the
 * model's window and the `myDevTeam.executor.contextWarnThresholds` setting.
 */
export const contextWarningKey = 'onContextWarning';

function contextWarningSink(requestContext: RequestContext): ContextWarningSink | undefined {
  return requestContext.get(contextWarningKey) as ContextWarningSink | undefined;
}

/** Receives triage's prediction on a pinned run when shadow triage is on. */
export type TriageShadowSink = (predicted: Intent) => void;

/**
 * RequestContext key under which a caller may pass a `TriageShadowSink`. Only
 * used on a pinned run with `shadowTriage` set: triage is run anyway, the pin
 * still wins, and its prediction goes here for the metering record.
 */
export const triageShadowKey = 'onTriageShadow';

function triageShadowSink(requestContext: RequestContext): TriageShadowSink | undefined {
  return requestContext.get(triageShadowKey) as TriageShadowSink | undefined;
}

/**
 * RequestContext key under which a caller may pass an `AbortSignal` to
 * `run.start`. The executor forwards it to its tool-calling loop so a
 * cancelled chat request stops an in-flight command or write, not just the
 * next workflow step.
 */
export const abortSignalKey = 'abortSignal';

function abortSignal(requestContext: RequestContext): AbortSignal | undefined {
  return requestContext.get(abortSignalKey) as AbortSignal | undefined;
}

/**
 * Asks the user to approve a drafted plan before it executes, returning their
 * verdict (approve / cancel / revise-with-comment). The engine-side handle on
 * the client's `RunClient.reviewPlan`. Absent (no client seam) means the run
 * never gates: the draft-plan step then proceeds straight to execution.
 */
export type PlanReview = (plan: Plan, complexity: Complexity) => Promise<PlanDecision>;

/**
 * RequestContext key under which the LocalEngine passes a `PlanReview` bound to
 * the run's client. The draft-plan step reads it (and the `myDevTeam.planApproval`
 * setting) to decide whether to pause for approval.
 */
export const planReviewKey = 'onPlanReview';

function planReview(requestContext: RequestContext): PlanReview | undefined {
  return requestContext.get(planReviewKey) as PlanReview | undefined;
}

/**
 * Asks the user, at a periodic executor check-in, whether to keep working or
 * stop and summarize. The engine-side handle on the client's
 * `RunClient.confirmContinue`. Absent (no client seam) means the executor never
 * checks in and runs to its step ceiling.
 */
export type ContinuePrompt = (info: CheckpointInfo) => Promise<ContinueDecision>;

/**
 * RequestContext key under which the LocalEngine passes a `ContinuePrompt` bound
 * to the run's client. The execute step hands it to the executor, which decides
 * (with the `myDevTeam.executor.checkpoint*` intervals) when to pause.
 */
export const continueReviewKey = 'onContinueReview';

function continueReview(requestContext: RequestContext): ContinuePrompt | undefined {
  return requestContext.get(continueReviewKey) as ContinuePrompt | undefined;
}

// The planner's `clarify` tool and the executor's `skill` tool are no longer
// wired through dedicated request-context seams: they are ordinary model tools
// that delegate to the client through the host's single `tool` capability (the
// planner builds `clarify` when the run's offered tools include it). So the
// workflow needs no clarify/skill plumbing - only the host, which the
// planner/executor factories already carry.

/**
 * The sinks every planner run threads through besides its plan-progress and
 * usage reporters: the run's cancellation signal, a reasoning model's live
 * thinking (gated by the setting, like the answerer/executor), the periodic
 * check-in, and the context-usage warning - the same side-channels the executor
 * gets, now that the planner drives a tool-calling loop of its own. Gathered
 * once so the several planner call sites stay in sync.
 */
function plannerSinks(requestContext: RequestContext): {
  signal?: AbortSignal;
  onThinking?: ThinkingSink;
  onCheckpoint?: ContinuePrompt;
  onContextWarning?: ContextWarningSink;
} {
  return {
    signal: abortSignal(requestContext),
    onThinking: runtimeConfig().thinkingShowInChat ? thinkingSink(requestContext) : undefined,
    onCheckpoint: continueReview(requestContext),
    onContextWarning: contextWarningSink(requestContext),
  };
}

/**
 * Whether a "direct" route must be escalated to the planning path so the user
 * can approve it. The direct route has no plan and so bypasses the approval
 * gate; that is fine under `auto`/`never` (a small change would not gate
 * anyway), but a user on `always` asked to approve *every* change, so a direct
 * change is drafted into a plan instead. Only when a review seam is actually
 * wired - with no seam there is no approval to honour, so escalating would just
 * add a pointless planner call.
 */
function escalatesDirect(requestContext: RequestContext): boolean {
  return planReview(requestContext) !== undefined && runtimeConfig().planApproval === 'always';
}

/**
 * Whether a "clarify" decision should actually ask the user, given the
 * normalised questions and the `myDevTeam.clarify.enabled` setting. A clarify
 * route with no usable question, or with clarifying turned off, is coerced back
 * to a normal answer by the caller - so the run always produces work rather than
 * a dead-end question.
 */
function clarifies(questions: ClarifyQuestion[]): boolean {
  return runtimeConfig().clarifyEnabled && questions.length > 0;
}

/**
 * The plan-approval gate, shared by the classic draft-plan step and the
 * combined respond step. It only engages when the client offered the review
 * seam and the run would actually execute (not a /plan run); the
 * `myDevTeam.planApproval` setting then decides whether to pause: `always` on
 * every plan, `auto` only when the plan was judged `complex`. The user can
 * approve (proceed), cancel (deliver the plan only), or revise - `redraft`
 * re-plans with their comment appended and the loop asks again. `view` is the
 * route/complexity/reason the snapshots render against; `sink` re-pushes the
 * complete plan before each prompt, since the streamed partials may trail the
 * final object.
 */
async function gatePlan(
  initial: Plan,
  redraft: (revisionPrompt: string) => Promise<Plan>,
  inputData: RequestInput,
  requestContext: RequestContext,
  view: { intent: Intent; complexity?: Complexity; reason: string },
  sink: ReplyProgressSink | undefined
): Promise<{ plan: Plan; proceed: boolean }> {
  let plan = initial;
  const review = planReview(requestContext);
  const canGate = review !== undefined && commandFor(inputData)?.execute !== false;
  const gates = (p: Plan): boolean => {
    if (!canGate) {
      return false;
    }
    const mode = runtimeConfig().planApproval;
    return mode === 'always' || (mode === 'auto' && p.complexity === 'complex');
  };
  let proceed = true;
  while (gates(plan)) {
    sink?.({ ...view, plan });
    const decision = await review!(plan, plan.complexity ?? view.complexity ?? 'moderate');
    if (decision.kind === 'approve') {
      break;
    }
    if (decision.kind === 'cancel') {
      proceed = false;
      break;
    }
    plan = await redraft(revisionPrompt(inputData, decision.comment));
  }
  return { plan, proceed };
}

/**
 * The agent's orchestration as a Mastra workflow:
 *
 *   triage ──▶ branch ──▶ draft-plan       (intent === "planning")
 *          │          └─▶ answer-directly  (intent === "oneshot")
 *          ▼
 *             branch ──▶ execute-plan      (a plan was drafted, the command did
 *                    │                      not opt out, and the user did not
 *                    │                      cancel it at the approval gate)
 *                    └─▶ deliver-answer    (oneshot and plan-only paths;
 *                                           pass-through)
 *
 * "answer-directly" streams a real answer from the Answerer agent;
 * "execute-plan" walks the drafted plan with the Executor's tool-calling
 * loop. The second branch is a branch rather than a plain step so a oneshot
 * (or plan-only) run never starts an executor step. A known slash command on
 * the request pins the triage decision without a model call, and a command
 * with `execute: false` (/plan) stops the run after the plan is drafted.
 * "draft-plan" may also pause for plan approval (see the gate inside it):
 * cancelling there carries `proceed: false` to deliver-answer.
 */
export function createDevTeamWorkflow(
  triage: Triage,
  // A factory, not an instance: the planner's model is sized by triage's
  // complexity, decided once the run is under way, so it is built in the
  // draft-plan step rather than up front (mirroring the executor factory). Its
  // `clarify` tool is built from the run's offered tools (it reaches the client
  // through the host like any other tool), so no clarify seam is threaded here.
  makePlanner: (complexity?: Complexity) => Planner,
  answerer: Answerer,
  // A factory, not an instance: the executor's model is sized by the request's
  // complexity, which triage only decides once the run is under way, so it is
  // built in the execute step rather than up front. Its `skill` tool reaches the
  // client through the host like any other tool, so no skill loader is threaded.
  makeExecutor: (complexity?: Complexity) => Executor,
  // Optional: when supplied (and the setting is on), the execute step ends by
  // summarizing the change. Left out by tests that do not exercise the summary,
  // so the execute step then simply produces no summary.
  makeSummarizer?: () => Summarizer,
  // Optional: when supplied, the workflow runs in combined mode - a single
  // `respond` step does triage and produces the answer or plan in one model
  // call, instead of the triage + draft-plan/answer-directly trio. Selected by
  // `myDevTeam.triage.mode` = "combined". A slash command still pins the route
  // and uses the dedicated planner/answerer inside the respond step, so /plan
  // and /fix keep their behaviour; only the unpinned path uses the responder.
  makeResponder?: () => Responder
) {
  const triageStep = createStep({
    id: stepIds.triage,
    inputSchema: RequestSchema,
    outputSchema: TriagedSchema,
    execute: async ({ inputData, requestContext }) => {
      // A known slash command pins the route: the user typing /fix already is
      // the routing decision, so the triage model call would only add latency
      // and a chance to misroute. The pinned reason renders where the model's
      // reason would, so the UI needs no special case.
      const command = commandFor(inputData);
      let decision;
      if (command) {
        decision = {
          intent: command.intent,
          complexity: command.complexity,
          reason: pinnedReason(command.name),
        };
        // Shadow triage: score the pin without changing the route. Triage runs
        // anyway (its tokens are real spend, reported like any triage call),
        // the pinned route still wins, and the prediction is reported for the
        // metering record so the report can measure triage against the command.
        if (inputData.shadowTriage) {
          const predicted = await triage.classify(
            triagePrompt(inputData),
            usageReporter(requestContext, 'triage')
          );
          triageShadowSink(requestContext)?.(predicted.intent);
        }
      } else {
        decision = await triage.classify(
          triagePrompt(inputData),
          usageReporter(requestContext, 'triage')
        );
      }
      // The clarify route's questions, normalised to the wire shape. A "clarify"
      // decision with no usable question (or with clarifying turned off) is
      // coerced to "oneshot" below, so the answerer answers rather than the run
      // dead-ending on a question. Triage is routing-only, so the coercion is
      // just a route swap - the answerer produces the body.
      const questions = normalizeQuestions(decision.questions);
      let intent: Intent = decision.intent;
      if (intent === 'clarify' && !clarifies(questions)) {
        intent = 'oneshot';
      }
      // Escalate a "direct" route to "planning" when the user approves every
      // plan (planApproval = "always" with a review seam): a direct change has
      // no plan to approve, so it is drafted into one instead. No-op for any
      // other intent or setting (a command never pins "direct").
      if (intent === 'direct' && escalatesDirect(requestContext)) {
        intent = 'planning';
      }
      return {
        prompt: inputData.prompt,
        instructions: inputData.instructions,
        attachments: inputData.attachments,
        history: inputData.history,
        skills: inputData.skills,
        command: inputData.command,
        ...decision,
        intent,
        questions: intent === 'clarify' ? questions : undefined,
      };
    },
  });

  const draftPlan = createStep({
    id: stepIds.plan,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, skills, command, intent, complexity, reason } =
        inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every plan
      // snapshot the planner streams, so the UI can render tokens as they
      // arrive instead of waiting for the whole plan.
      sink?.({ intent, complexity, reason });
      const onPartial: PlanProgress | undefined =
        sink && ((partial) => sink({ intent, complexity, reason, plan: partial }));
      // The planner's model is sized by triage's (pre-exploration) complexity;
      // the executor's, later, by the planner's own (post-exploration) one. Now
      // that the planner explores with its own tools, that complexity is a real
      // post-exploration read.
      const planner = makePlanner(complexity);
      const sinks = plannerSinks(requestContext);
      const draft = (revision?: string) =>
        planner.plan(
          revision ?? fullPrompt(inputData),
          onPartial,
          usageReporter(requestContext, 'plan', inputBreakdown(inputData)),
          sinks.signal,
          sinks.onThinking,
          sinks.onCheckpoint,
          sinks.onContextWarning
        );

      const plan = await draft();
      const { plan: gated, proceed } = await gatePlan(
        plan,
        (revision) => draft(revision),
        inputData,
        requestContext,
        { intent, complexity, reason },
        sink
      );

      return {
        prompt, instructions, attachments, history, skills, command, intent, complexity, reason,
        plan: gated, proceed,
      };
    },
  });

  const answerDirectly = createStep({
    id: stepIds.answer,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, command, intent, complexity, reason } =
        inputData;
      const sink = progressSink(requestContext);
      // Surface the triage decision right away, then forward every answer
      // snapshot the answerer streams, mirroring the draft-plan step.
      sink?.({ intent, complexity, reason });
      const answer = await answerer.answer(
        fullPrompt(inputData),
        sink && ((text) => sink({ intent, complexity, reason, answer: text })),
        usageReporter(requestContext, 'answer', inputBreakdown(inputData)),
        // Surface a reasoning model's thinking live, gated by the setting so
        // turning it off does no extra work (a side-channel, not the reply).
        runtimeConfig().thinkingShowInChat ? thinkingSink(requestContext) : undefined
      );
      return { prompt, instructions, attachments, history, command, intent, complexity, reason, answer };
    },
  });

  // The direct route (classifier mode): a small, well-specified change that
  // skips the planner. A pass-through that surfaces the route and carries the
  // request forward; the execute step then runs the executor with no plan.
  // (Escalation to "planning" already happened in triage, so a request reaching
  // here genuinely runs plan-less.)
  const directStage = createStep({
    id: stepIds.direct,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, skills, command, intent, complexity, reason } =
        inputData;
      progressSink(requestContext)?.({ intent, complexity, reason });
      return { prompt, instructions, attachments, history, skills, command, intent, complexity, reason };
    },
  });

  // The clarify route: a terminal pass-through that surfaces the route and
  // carries the questions to ask. Like the direct stage it never drafts a plan;
  // unlike it, it never reaches the executor either (shouldExecute is false with
  // no plan and intent !== "direct"), so the run ends at deliver-answer with the
  // questions. The triage step already normalised them and honoured the
  // clarify-enabled setting, so a request reaching here genuinely asks.
  const clarifyStage = createStep({
    id: stepIds.clarify,
    inputSchema: TriagedSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, command, intent, complexity, reason, questions } =
        inputData;
      progressSink(requestContext)?.({ intent, complexity, reason, questions });
      return { prompt, instructions, attachments, history, command, intent, complexity, reason, questions };
    },
  });

  // The combined-mode step: triage + answer/plan in one model call. Built only
  // when a responder factory was supplied. A slash command still pins the route
  // and falls back to the dedicated planner/answerer (so /plan stays plan-only
  // and /fix keeps its complexity); only an unpinned request uses the responder.
  const respond = createStep({
    id: stepIds.respond,
    inputSchema: RequestSchema,
    outputSchema: StagedReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, skills, command } = inputData;
      const carry = { prompt, instructions, attachments, history, skills, command };
      const sink = progressSink(requestContext);

      // Pinned route: the user typed a command, so the responder's routing is
      // not wanted. Run the dedicated planner/answerer exactly as the classic
      // steps do, preserving /plan's plan-only stop and /fix's complexity.
      const pinned = commandFor(inputData);
      if (pinned) {
        const intent = pinned.intent;
        const complexity = pinned.complexity;
        const reason = pinnedReason(pinned.name);
        sink?.({ intent, complexity, reason });
        if (intent === 'planning') {
          const onPlan: PlanProgress | undefined =
            sink && ((partial) => sink({ intent, complexity, reason, plan: partial }));
          const planner = makePlanner(complexity);
          const sinks = plannerSinks(requestContext);
          const draft = (revision?: string) =>
            planner.plan(
              revision ?? fullPrompt(inputData),
              onPlan,
              usageReporter(requestContext, 'plan', inputBreakdown(inputData)),
              sinks.signal,
              sinks.onThinking,
              sinks.onCheckpoint,
              sinks.onContextWarning
            );
          const drafted = await draft();
          const { plan, proceed } = await gatePlan(
            drafted,
            (revision) => draft(revision),
            inputData,
            requestContext,
            { intent, complexity, reason },
            sink
          );
          return { ...carry, intent, complexity, reason, plan, proceed };
        }
        const answer = await answerer.answer(
          fullPrompt(inputData),
          sink && ((text) => sink({ intent, complexity, reason, answer: text })),
          usageReporter(requestContext, 'answer', inputBreakdown(inputData)),
          runtimeConfig().thinkingShowInChat ? thinkingSink(requestContext) : undefined
        );
        return { ...carry, intent, complexity, reason, answer };
      }

      // Unpinned route: one responder call routes and produces the work. The
      // route is not known until the model commits its `intent` mid-stream, so
      // the usage step is tagged from the partial that carries it (set before
      // the usage report fires, which is after the stream is drained).
      const responder = makeResponder!();
      let routeStep: RunStep = 'answer';
      const onPartial: ResponderProgressSink = (partial) => {
        // Withhold the first snapshot until the reason is known too, so the
        // triage block never renders an empty reason; reason precedes the
        // answer/plan body in the schema, so this only delays the very start.
        if (!partial.reason) {
          return;
        }
        if (partial.intent === 'planning') {
          routeStep = 'plan';
          sink?.({
            intent: 'planning',
            complexity: partial.complexity,
            reason: partial.reason,
            plan: partial.plan,
          });
        } else if (partial.intent === 'oneshot') {
          routeStep = 'answer';
          sink?.({
            intent: 'oneshot',
            complexity: partial.complexity,
            reason: partial.reason,
            answer: partial.answer,
          });
        } else if (partial.intent === 'clarify') {
          // "clarify": the route and reason stream now; the questions arrive
          // whole after the call. Metered as "answer" - the responder produced
          // the questions, so its tokens attribute to that step.
          routeStep = 'answer';
          sink?.({
            intent: 'clarify',
            complexity: partial.complexity,
            reason: partial.reason,
          });
        } else {
          // "direct" is a routing-only decision (no streamed body). Don't surface
          // a snapshot yet - whether it stays "direct" or is escalated to
          // "planning" (approve-every-plan) is decided after the call, so the
          // route is emitted then. The responder's own call meters as triage.
          routeStep = 'triage';
        }
      };
      const reportUsage = (usage: AgentUsage) =>
        usageReporter(requestContext, routeStep, inputBreakdown(inputData))?.(usage);
      const decision = await responder.respond(fullPrompt(inputData), onPartial, reportUsage);

      if (decision.intent === 'oneshot') {
        const { complexity, reason, answer } = decision;
        sink?.({ intent: 'oneshot', complexity, reason, answer });
        return { ...carry, intent: 'oneshot', complexity, reason, answer };
      }

      // Clarify route: end the run with the questions - unless clarifying is off
      // or the model produced no usable question, in which case fall back to a
      // normal answer (the responder cannot answer and ask in one call, so this
      // is a fresh answerer call rather than a coercion of the same object).
      if (decision.intent === 'clarify') {
        const { complexity, reason, questions } = decision;
        if (clarifies(questions)) {
          sink?.({ intent: 'clarify', complexity, reason, questions });
          return { ...carry, intent: 'clarify', complexity, reason, questions };
        }
        const fallbackReason = 'Answered with a reasonable assumption (clarifying questions are turned off).';
        sink?.({ intent: 'oneshot', complexity, reason: fallbackReason });
        const answer = await answerer.answer(
          fullPrompt(inputData),
          sink && ((text) => sink({ intent: 'oneshot', complexity, reason: fallbackReason, answer: text })),
          usageReporter(requestContext, 'answer', inputBreakdown(inputData)),
          runtimeConfig().thinkingShowInChat ? thinkingSink(requestContext) : undefined
        );
        return { ...carry, intent: 'oneshot', complexity, reason: fallbackReason, answer };
      }

      // Direct route: hand it straight to the executor with no plan - unless the
      // user approves every plan, in which case it is drafted into one so it can
      // gate (escalation, the same rule the classic triage step applies).
      if (decision.intent === 'direct') {
        const { complexity, reason } = decision;
        if (escalatesDirect(requestContext)) {
          const planner = makePlanner(complexity);
          const sinks = plannerSinks(requestContext);
          const draft = (revision?: string) =>
            planner.plan(
              revision ?? fullPrompt(inputData),
              sink && ((partial) => sink({ intent: 'planning', complexity, reason, plan: partial })),
              usageReporter(requestContext, 'plan', inputBreakdown(inputData)),
              sinks.signal,
              sinks.onThinking,
              sinks.onCheckpoint,
              sinks.onContextWarning
            );
          const drafted = await draft();
          const { plan, proceed } = await gatePlan(
            drafted,
            (revision) => draft(revision),
            inputData,
            requestContext,
            { intent: 'planning', complexity, reason },
            sink
          );
          return { ...carry, intent: 'planning', complexity, reason, plan, proceed };
        }
        sink?.({ intent: 'direct', complexity, reason });
        return { ...carry, intent: 'direct', complexity, reason };
      }

      const { complexity, reason } = decision;
      sink?.({ intent: 'planning', complexity, reason, plan: decision.plan });
      // Revisions re-draft with the dedicated planner: the run is already
      // committed to planning, so the responder's routing is no longer needed.
      const revisionSinks = plannerSinks(requestContext);
      const revisionPlanner = makePlanner(complexity);
      const redraft = (revision: string) =>
        revisionPlanner.plan(
          revision,
          sink && ((partial) => sink({ intent: 'planning', complexity, reason, plan: partial })),
          usageReporter(requestContext, 'plan', inputBreakdown(inputData)),
          revisionSinks.signal,
          revisionSinks.onThinking,
          revisionSinks.onCheckpoint,
          revisionSinks.onContextWarning
        );
      const { plan, proceed } = await gatePlan(
        decision.plan,
        redraft,
        inputData,
        requestContext,
        { intent: 'planning', complexity, reason },
        sink
      );
      return { ...carry, intent: 'planning', complexity, reason, plan, proceed };
    },
  });

  const executePlan = createStep({
    id: stepIds.execute,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData, requestContext }) => {
      const { prompt, instructions, attachments, history, command, intent, complexity, reason, plan } =
        inputData;
      // The planning route always carries a plan here; the direct route carries
      // none (it skipped the planner). Only a planning run with no plan is a bug.
      if (!plan && intent !== 'direct') {
        throw new Error('execute-plan reached without a drafted plan.');
      }
      const sink = progressSink(requestContext);
      // Complete the plan render before execution output starts, then
      // forward every transcript snapshot the executor produces.
      sink?.({ intent, complexity, reason, plan });
      const onPartial: ExecutionProgress | undefined =
        sink && ((partial) => sink({ intent, complexity, reason, plan, execution: partial }));
      const executorInput = { prompt, instructions, attachments, history, command };
      // The run's skill catalogue (name + description) from the request metadata,
      // de-duped: it goes into the executor's prompt, and the executor's `skill`
      // tool fetches a body on demand through the client (the engine ships with no
      // skills and the request carries no bodies) - the `skill` tool delegates to
      // the client over the host's `tool` capability, like any other tool.
      const catalogue = resolveSkills(inputData.skills);
      // Size the executor by the planner's post-exploration complexity when it
      // judged one, falling back to triage's pre-exploration value otherwise (the
      // direct route has no plan, so it sizes by triage's read - a direct change
      // is "simple"). The planner has seen the workspace, so its read is the
      // better one to route the heavy step on.
      const executor = makeExecutor(plan?.complexity ?? complexity);
      const execution = await executor.execute(
        executionPrompt(executorInput, plan, catalogue),
        onPartial,
        abortSignal(requestContext),
        usageReporter(requestContext, 'execute', inputBreakdown(executorInput, plan, catalogue)),
        // Surface the executor's thinking live, gated by the setting so turning
        // it off does no extra work (a side-channel, not the transcript).
        runtimeConfig().thinkingShowInChat ? thinkingSink(requestContext) : undefined,
        // The periodic check-in seam: present only when the client offered it,
        // so a client without `confirmContinue` runs straight to the ceiling.
        continueReview(requestContext),
        // The context-usage warning sink (side-channel like thinking); absent
        // means no warnings are emitted.
        contextWarningSink(requestContext)
      );
      const base = { intent, complexity, reason, plan, execution };

      // Recap the change: only when a summarizer is wired, the setting is on,
      // and the run actually changed files (a read/analyse-only run has nothing
      // to summarize). Best-effort - the work is already done and on disk, so a
      // summarizer failure must degrade to "no summary", never fail the run or
      // discard the execution.
      if (
        !makeSummarizer ||
        !runtimeConfig().summaryShowInChat ||
        !executionChangedFiles(execution)
      ) {
        return base;
      }
      try {
        const onSummary: SummaryProgress | undefined =
          sink && ((partial) => sink({ ...base, summary: partial }));
        const summary = await makeSummarizer().summarize(
          summaryPrompt(executorInput, plan, execution),
          onSummary,
          usageReporter(requestContext, 'summarize')
        );
        return { ...base, summary };
      } catch {
        // Summary is a nicety on top of completed work; drop it on any failure.
        return base;
      }
    },
  });

  // The oneshot path is already complete after answer-directly, and a
  // plan-only run after draft-plan (a /plan command, or a plan the user
  // cancelled at the approval gate); this pass-through only strips the carried
  // request fields back off.
  const deliverAnswer = createStep({
    id: stepIds.deliver,
    inputSchema: StagedReplySchema,
    outputSchema: ReplySchema,
    execute: async ({ inputData }) => ({
      intent: inputData.intent,
      complexity: inputData.complexity,
      reason: inputData.reason,
      plan: inputData.plan,
      answer: inputData.answer,
      // The clarify route ends here, carrying its questions to the client.
      questions: inputData.questions,
    }),
  });

  // The execute step runs for a drafted plan, or for the direct route (which has
  // no plan but still changes the workspace). It is skipped when the run's slash
  // command opted out (/plan stops after drafting) or the user cancelled at the
  // approval gate (`proceed === false`). The direct route never gates and no
  // command opts it out, so it always reaches the executor.
  const shouldExecute = async ({ inputData }: { inputData: StagedReply }) =>
    (inputData.plan !== undefined || inputData.intent === 'direct') &&
    inputData.proceed !== false &&
    commandFor(inputData)?.execute !== false;

  // The generics are explicit because TS cannot infer them from the zod
  // schemas: a zod v4 schema matches more than one member of Mastra's
  // PublicSchema union, so inference collapses TInput/TOutput to `unknown`.
  const base = () =>
    createWorkflow<'dev-team', unknown, RequestInput, ReplyResult>({
      id: 'dev-team',
      inputSchema: RequestSchema,
      outputSchema: ReplySchema,
    });

  // Combined mode: a single `respond` step yields the staged reply directly
  // (the answer, or the plan to execute), so the triage + draft-plan/answer
  // branch collapses into it. The execute-vs-deliver branch below is unchanged -
  // the staged reply already carries either an answer or a plan.
  if (makeResponder) {
    return base()
      .then(respond)
      .branch([
        [shouldExecute, executePlan],
        [
          async (args: { inputData: StagedReply }) => !(await shouldExecute(args)),
          deliverAnswer,
        ],
      ])
      .map(async ({ inputData }) => inputData[stepIds.execute] ?? inputData[stepIds.deliver])
      .commit();
  }

  return base()
    .then(triageStep)
    .branch([
      [async ({ inputData }) => inputData.intent === 'planning', draftPlan],
      [async ({ inputData }) => inputData.intent === 'oneshot', answerDirectly],
      [async ({ inputData }) => inputData.intent === 'direct', directStage],
      [async ({ inputData }) => inputData.intent === 'clarify', clarifyStage],
    ])
    // branch() emits { [stepId]: output }; flatten to the single staged reply.
    .map(
      async ({ inputData }) =>
        inputData[stepIds.plan] ??
        inputData[stepIds.answer] ??
        inputData[stepIds.direct] ??
        inputData[stepIds.clarify]
    )
    .branch([
      [shouldExecute, executePlan],
      [
        async (args: { inputData: StagedReply }) => !(await shouldExecute(args)),
        deliverAnswer,
      ],
    ])
    .map(async ({ inputData }) => inputData[stepIds.execute] ?? inputData[stepIds.deliver])
    .commit();
}

export type DevTeamWorkflow = ReturnType<typeof createDevTeamWorkflow>;
