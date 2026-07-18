/**
 * The wire-shaped data contract between the extension (client) and the engine
 * (today the in-process LocalEngine, later a remote backend). Everything here
 * is user-visible data: prompts, system messages, agent configs, and model
 * identities never appear in these shapes - they are engine internals the
 * protocol deliberately hides.
 *
 * This module depends on nothing but zod. The engine imports it to validate
 * what it produces; the client imports it to validate what it consumes. Wire
 * schemas carry no prompt material: the engine's generation schemas (which
 * describe fields to the model) live engine-side and stay a superset-shaped
 * match of these.
 */
import { z } from 'zod';

/**
 * Version of this contract. A client sends it with every run request; an
 * engine rejects a version it does not speak. Bump it when an existing event
 * or field changes meaning - adding a new event type is backwards-compatible
 * and needs no bump.
 */
export const PROTOCOL_VERSION = 5;

/** One attached file/selection: a short label naming it plus its (already truncated) text. */
export const AttachmentSchema = z.object({
  label: z.string(),
  text: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Standing project instructions the client read from the workspace root (an
 * AGENTS.md or CLAUDE.md file): repository conventions every run should
 * follow. The client truncates the text; which file won is named in `source`
 * so prompts can attribute the rules.
 */
export const ProjectInstructionsSchema = z.object({
  /** The file the instructions came from, e.g. "AGENTS.md". */
  source: z.string(),
  /** The file's text, already truncated by the client. */
  text: z.string(),
});
export type ProjectInstructions = z.infer<typeof ProjectInstructionsSchema>;

/**
 * One workspace skill the client discovered (a SKILL.md file under a configured
 * skills directory), as **metadata only**: its name, its one-line description,
 * and its source path. The client parses the SKILL.md frontmatter and ships just
 * this - the full body never rides on the request. The engine lists the name +
 * description in the executor's prompt, and when the model loads a skill its
 * `skill` tool fetches the body on demand from the client through the `tool`
 * capability. Lazy by design: only a skill the model actually uses crosses the
 * wire, and the engine bundles no skills of its own.
 */
export const WorkspaceSkillSchema = z.object({
  /** The skill file's workspace-relative path, e.g. ".devteam/skills/demo/SKILL.md". */
  source: z.string(),
  /** The skill's name (its frontmatter `name`), used to load its body on demand. */
  name: z.string(),
  /** The one-line description shown in the executor's "Available skills" catalogue. */
  description: z.string(),
});
export type WorkspaceSkill = z.infer<typeof WorkspaceSkillSchema>;

/**
 * One tool the client discovered from a configured MCP server, shipped on the
 * run request so the engine can offer it to the executor. The client owns the
 * connection and the execution: the engine reaches the tool back through the
 * ToolHost exactly like a built-in tool, so this carries only what the engine
 * needs to present the tool to the model. `name` is namespaced by the client
 * ("mcp__<server>__<tool>") so it cannot collide with a built-in tool, and the
 * same string is what `offeredTools` lists and the ToolHost dispatches.
 * `inputSchema` is the JSON Schema the server published; the engine converts it
 * to a model-facing argument schema (best effort), but the MCP server is what
 * actually validates a call's arguments.
 */
export const DynamicToolDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
});
export type DynamicToolDef = z.infer<typeof DynamicToolDefSchema>;

/** One prior turn of the conversation, already capped by the client. */
export const HistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
});
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;

/**
 * The client's runtime facts. The workspace tools execute on the client's
 * machine, so the engine must write prompts (and the model must write
 * commands) for the client's OS and shell, not its own. The LocalEngine
 * shares a host with the client and derives the same facts itself; a remote
 * engine must render its prompts from this field.
 */
export const EnvironmentFactsSchema = z.object({
  /** Human-readable operating system name (e.g. "Windows"). */
  os: z.string(),
  /** Shell name commands are written for and executed in (e.g. "PowerShell"). */
  shell: z.string(),
});
export type EnvironmentFacts = z.infer<typeof EnvironmentFactsSchema>;

/**
 * Everything the client sends to start a run. `offeredTools` names the
 * client-side tools the engine may ask it to execute (see toolContract.ts) -
 * the implementations always stay on the client. `command` is the slash
 * command the user invoked (without the slash), if any: what a command does
 * is the engine's business (its command registry pins the route and shapes
 * the prompts), the client only relays the name, and an engine that does not
 * know the name treats the prompt as plain text. `instructions` carries the
 * workspace's standing instruction file (AGENTS.md/CLAUDE.md) when one exists;
 * an engine that predates the field simply ignores it.
 */
export const RunRequestSchema = z.object({
  protocolVersion: z.number().int().positive(),
  prompt: z.string(),
  command: z.string().optional(),
  /**
   * The model the user chose for the work agents (planner/answerer/executor):
   * an engine-defined model id, or "auto"/absent to let the engine route by
   * capability. The model identity is otherwise an engine internal; this is
   * the one user-facing handle, chosen from `Engine.listModels`. An engine
   * that does not know the id treats it as "auto", so version skew degrades.
   */
  model: z.string().optional(),
  instructions: ProjectInstructionsSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  history: z.array(HistoryTurnSchema).optional(),
  /**
   * Skill metadata (name + description + source) the client read from the
   * configured skills directories. Only the metadata rides here; the engine
   * lists each skill's name + description to the executor and its `skill` tool
   * fetches a body on demand from the client (through the `tool` capability) when
   * the model loads one (progressive disclosure, lazy over the wire - the engine
   * bundles no skills of its own). Optional, so an engine that predates the field
   * simply ignores it.
   */
  skills: z.array(WorkspaceSkillSchema).optional(),
  /**
   * Tools the client discovered from configured MCP servers (their names,
   * descriptions, and JSON Schemas). The engine builds a model-facing tool for
   * each and lets the executor call it; the call is dispatched back to the
   * client's ToolHost and gated by the user's Approver, exactly like a built-in
   * side-effecting tool. Their namespaced names also appear in `offeredTools`.
   * Optional, so an engine that predates the field simply ignores it.
   */
  dynamicTools: z.array(DynamicToolDefSchema).optional(),
  environment: EnvironmentFactsSchema.optional(),
  offeredTools: z.array(z.string()),
  /**
   * When set, the engine runs triage even on a slash command that pins the
   * route: it keeps the pinned route but reports what triage would have decided
   * as a `triage-shadow` event - the labelled signal for measuring triage
   * accuracy against the command the user chose. Costs one extra (local) triage
   * call per pinned run, so the client only sets it when the user opted into
   * collecting that analysis. An engine that does not know the field ignores it.
   */
  shadowTriage: z.boolean().optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

/**
 * One model offered in the picker (`Engine.listModels`). `id` is what the
 * client sends back on `RunRequest.model` ("auto" for the router); `available`
 * is false when the model cannot run yet (a missing API key, or - probed at
 * call time - an Ollama model that is not pulled), so the picker can flag it.
 * `disabled` is set when the model or its provider was switched off by config
 * (the backend floor or the user's `myDevTeam.disabled*` settings): such a
 * choice never runs even if pinned, so the picker shows it greyed out with a
 * distinct reason. A disabled choice is always reported `available: false`.
 */
export const ModelChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  disabled: z.boolean().optional(),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

/**
 * Which model each run step used, surfaced so the user knows what answered -
 * especially in Auto mode, where the engine chose. `mode` is "pinned" when the
 * user's choice named a model, "provider" when it named a provider (the router
 * then picked the best model per agent within it - `provider` carries that
 * provider's label), and "auto" when the router decided across all available
 * models. One entry per step that ran (triage always; then plan+execute, or
 * answer).
 */
export const ModelSelectionEntrySchema = z.object({
  /** The run step: "triage" | "plan" | "answer" | "execute". */
  step: z.string(),
  /** The engine model id that ran the step. */
  id: z.string(),
  /** Its user-facing label. */
  label: z.string(),
});
export const ModelSelectionSchema = z.object({
  mode: z.enum(['auto', 'pinned', 'provider']),
  /** The provider's display label, set only in "provider" mode. */
  provider: z.string().optional(),
  models: z.array(ModelSelectionEntrySchema),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/**
 * The routing decision:
 *  - "oneshot":  answer in one shot, no workspace change (the answerer).
 *  - "planning": decompose into a plan, then execute it (planner -> executor).
 *  - "direct":   a small, well-specified change that needs no plan - hand it
 *                straight to the executor. Skips the planner (and its model
 *                call); escalated to "planning" when the user asked to approve
 *                every plan (`myDevTeam.planApproval` = "always").
 *  - "clarify":  the request is too ambiguous to route well, so instead of
 *                guessing the run ends by asking the user one or more questions
 *                (each with predefined options and/or a free-form answer). A
 *                terminal route - no plan, no execution; the user's reply on the
 *                next turn carries the run forward. Gated by `myDevTeam.clarify.enabled`.
 */
export const IntentSchema = z.enum(['oneshot', 'planning', 'direct', 'clarify']);
export type Intent = z.infer<typeof IntentSchema>;

/**
 * How demanding the request is, decided by triage alongside the intent. It
 * sizes the executor's model (see the model registry's `tier`): "simple" work
 * (a self-contained script) routes to a cheaper/smaller model, "complex" work
 * (multi-file changes, subtle debugging) to the strongest one. Only the
 * executor consumes it, on the planning and direct routes (a direct change is
 * always "simple"); a pinned model and the `complexityRouting` opt-out both
 * bypass it.
 */
export const ComplexitySchema = z.enum(['simple', 'moderate', 'complex']);
export type Complexity = z.infer<typeof ComplexitySchema>;

/**
 * A drafted plan step: a short title and one sentence of detail. Steps carry
 * no tool label - which tool (if any) a step needs is the executor's call at
 * run time, not something the plan commits to.
 */
export const PlanStepSchema = z.object({
  title: z.string(),
  detail: z.string(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * A pivotal design or architectural decision behind the plan, with its reason.
 * The planner emits these only for a complex change where the choice matters to
 * approval; the client surfaces them at the plan-approval gate so the user can
 * judge the approach, not just the steps. Plain data, like the rest of the plan.
 */
export const PlanDecisionNoteSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
});
export type PlanDecisionNote = z.infer<typeof PlanDecisionNoteSchema>;

export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(PlanStepSchema).min(1),
  /**
   * Pivotal design decisions behind the plan, surfaced at the approval gate.
   * Optional and usually absent - the planner includes them only for a complex
   * change whose approach is worth seeing before approving.
   */
  decisions: z.array(PlanDecisionNoteSchema).optional(),
  /**
   * How demanding the planner judged the work once it had explored the
   * workspace - a more informed read than triage's pre-exploration guess. It
   * sizes the executor's model and drives the plan-approval gate (a `complex`
   * plan is what the `auto` gate pauses on). Optional so an engine that predates
   * the field, or a model that omitted it, simply degrades to triage's value.
   */
  complexity: ComplexitySchema.optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * The user's verdict at the plan-approval gate (see RunClient.reviewPlan):
 * approve and execute, cancel the run (deliver the plan only), or revise -
 * carry a free-text comment back to the planner, which re-drafts and asks
 * again.
 */
export const PlanDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve') }),
  z.object({ kind: z.literal('cancel') }),
  z.object({ kind: z.literal('revise'), comment: z.string() }),
]);
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;

/**
 * What the executor tells the client at a periodic check-in (see
 * RunClient.confirmContinue): how many tool-calling steps it has taken so far,
 * how long the run has been going, and a short description of the last thing it
 * did - enough for the user to decide whether the work should keep going. Plain,
 * wire-serializable data.
 */
export interface CheckpointInfo {
  /** Tool-calling steps taken so far across the whole execution. */
  stepsDone: number;
  /** Wall-clock seconds since execution began. */
  secondsElapsed: number;
  /** A short label of the most recent action (e.g. a tool name), when known. */
  lastAction?: string;
}

/**
 * A one-way notice (no answer) that a run's context is filling its model's
 * window: emitted by the executor when usage first crosses a configured
 * threshold (`myDevTeam.executor.contextWarnThresholds`). Plain, wire-
 * serializable data the client renders as an inline caution.
 */
export interface ContextWarning {
  /** The model whose window is filling (its display name). */
  model: string;
  /** The threshold percentage just crossed (e.g. 90). */
  threshold: number;
  /** The actual usage percentage at the time of the notice (>= threshold). */
  percent: number;
  /** Tokens currently in the model's context (provider-reported or estimated). */
  usedTokens: number;
  /** The model's context window in tokens (override or built-in). */
  contextWindow: number;
  /** True when `usedTokens` is a length-based estimate, not provider-reported. */
  estimated: boolean;
}

/**
 * The user's verdict at an executor check-in (see RunClient.confirmContinue):
 * keep working, or stop now and summarize what has been gathered so far.
 */
export const ContinueDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue') }),
  z.object({ kind: z.literal('stop') }),
]);
export type ContinueDecision = z.infer<typeof ContinueDecisionSchema>;

/**
 * A snapshot of the plan while the engine is still drafting it. Field values
 * arrive incrementally: strings grow over time and later fields are missing
 * until the model reaches them, so everything is optional and a title or
 * detail may still be only partly streamed.
 */
export type PartialPlanStep = {
  title?: string;
  detail?: string;
};
export type PartialPlanDecisionNote = {
  decision?: string;
  rationale?: string;
};
export type PartialPlan = {
  summary?: string;
  steps?: Array<PartialPlanStep | undefined>;
  /** Pivotal design decisions, streamed in once the model reaches the field. */
  decisions?: Array<PartialPlanDecisionNote | undefined>;
  /** The planner's complexity judgement, set once the model reaches the field. */
  complexity?: Complexity;
};

/**
 * The transcript of an execution run: an ordered interleaving of the model's
 * commentary and the tool calls it made while walking the plan. The order is
 * the product - "read this, then wrote that, then reported" - so the events
 * stay a single sequence instead of separate text/calls lists.
 *
 * Tool inputs and results are recorded as bounded display previews the engine
 * computes: the model saw the full values during the run, the transcript only
 * has to show the user what happened.
 */
export const TextEventSchema = z.object({
  kind: z.literal('text'),
  /** Markdown the model wrote between tool calls (commentary, final report). */
  text: z.string(),
});

export const ToolEventSchema = z.object({
  kind: z.literal('tool'),
  /** Tool name (read | search | run | write). */
  tool: z.string(),
  /** Display preview of the call arguments, truncated by the engine. */
  input: z.string(),
  /**
   * Leading lines of the tool's snippet-bearing argument (e.g. the file
   * contents for write), shown beneath the call line. Absent for tools
   * without one or when snippets are turned off.
   */
  snippet: z.string().optional(),
  /** Preview of the tool's result, truncated; absent while the call runs. */
  result: z.string().optional(),
  /** True when the tool threw instead of returning. */
  failed: z.boolean().optional(),
});

/**
 * A self-reported checklist snapshot the executor prints from time to time
 * while it works (via the engine-only `progress` tool): the status of the
 * plan steps it chooses to show. It carries the plan step numbers, not their
 * titles - the client already has the plan and resolves the titles at render
 * time, so the event stays small and cannot drift from the drafted plan. The
 * model decides when to emit one; it never breaks the run between steps.
 */
export const ProgressStatusSchema = z.enum(['pending', 'in_progress', 'done']);
export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;

export const ProgressItemSchema = z.object({
  /** 1-based index into the drafted plan's steps. */
  step: z.number().int().min(1),
  status: ProgressStatusSchema,
});
export type ProgressItem = z.infer<typeof ProgressItemSchema>;

export const ProgressEventSchema = z.object({
  kind: z.literal('progress'),
  /** The reported steps, in the order the model listed them. */
  items: z.array(ProgressItemSchema),
});

export const ExecutionEventSchema = z.discriminatedUnion('kind', [
  TextEventSchema,
  ToolEventSchema,
  ProgressEventSchema,
]);

export const ExecutionSchema = z.object({
  events: z.array(ExecutionEventSchema),
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;

/**
 * A snapshot of the execution while the run is still producing it. Snapshots
 * are grow-only: events only get appended, and only the last event still
 * changes (a text event's text grows, a tool event gains its result).
 */
export type PartialExecution = Execution;

/**
 * The end-of-run recap of an executed plan, in three fixed sections so the user
 * can skim a change the way they would a pull request: what was delivered, how
 * it was built, and what tests/docs cover it. Produced by the Summarizer agent
 * after the executor finishes; present only on a planning run that actually
 * changed files. This is the wire shape; the Summarizer's generation schema
 * (engine/core/summarizer.ts) carries the prompt material.
 */
export const SummarySchema = z.object({
  whatShips: z.string(),
  howItsBuilt: z.string(),
  testsAndDocs: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;

/**
 * A snapshot of the summary while the model streams it: each section's string
 * grows over time and the later sections are missing until the model reaches
 * them, so every field is optional.
 */
export type PartialSummary = {
  whatShips?: string;
  howItsBuilt?: string;
  testsAndDocs?: string;
};

/**
 * One clarifying question the engine asks when it routes to "clarify": a prompt,
 * a set of predefined answer options (the user picks one), and whether a
 * free-form answer is also allowed. Plain, wire-serializable data the client
 * renders as a question with numbered options (and, when `allowOther`, a note
 * that the user may answer in their own words). The user's reply rides back as
 * the next conversation turn, so no in-run answer channel is needed.
 */
export const ClarifyQuestionSchema = z.object({
  question: z.string(),
  /** Predefined answers offered as numbered choices; may be empty for a free-form-only ask. */
  options: z.array(z.string()),
  /** Whether the user may answer in their own words instead of picking an option. */
  allowOther: z.boolean(),
});
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>;

/**
 * The user's answer to one clarifying question the planner puts to them mid-run
 * through its `clarify` tool (a client call over the `tool` capability). Unlike
 * the "clarify" route - which ends the turn and waits for the next conversation
 * turn - the client composes these answers into the tool's result string so the
 * same planner loop continues in the one turn. `answer`
 * is the option the user picked or the words they typed; `question` echoes the
 * prompt it answers so their pairing cannot be confused. Plain, wire-
 * serializable data.
 */
export const ClarifyAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});
export type ClarifyAnswer = z.infer<typeof ClarifyAnswerSchema>;

/**
 * What a run produces: the routing decision plus, for "planning" requests,
 * the drafted plan and the execution transcript, for "oneshot" requests the
 * direct answer, or, for "clarify" requests, the questions to put to the user.
 * Rendering this into chat markdown is the client's job.
 */
export const ReplySchema = z.object({
  intent: IntentSchema,
  reason: z.string(),
  /** How demanding triage judged the request; surfaced and sizes the executor. */
  complexity: ComplexitySchema.optional(),
  /** Which model(s) ran the request, for the "which model answered" line. */
  selection: ModelSelectionSchema.optional(),
  plan: PlanSchema.optional(),
  answer: z.string().optional(),
  execution: ExecutionSchema.optional(),
  /** The three-section recap of an executed plan; absent when nothing changed. */
  summary: SummarySchema.optional(),
  /** The clarifying questions to ask; present only on the "clarify" route. */
  questions: z.array(ClarifyQuestionSchema).optional(),
});
export type Reply = z.infer<typeof ReplySchema>;

/**
 * A snapshot of the reply while the run is still producing it: the triage
 * decision is complete from the first event on, the plan and the execution
 * transcript grow as the engine streams them, and the answer grows as
 * accumulated text. Clients rebuild this from run events with `ReplyFolder`
 * (see events.ts) and render each snapshot.
 */
export type ReplyProgress = {
  intent: Intent;
  reason: string;
  complexity?: Complexity;
  selection?: ModelSelection;
  plan?: PartialPlan;
  answer?: string;
  execution?: PartialExecution;
  summary?: PartialSummary;
  /** The clarifying questions to ask; present only on the "clarify" route. */
  questions?: ClarifyQuestion[];
};
