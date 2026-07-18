import { Agent } from '@mastra/core/agent';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { contextWindowFor, resolveModel, routeModel } from './models';
import { estimateTokenCounts, readUsage, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { buildPlannerTools } from './agentTools';
import {
  runToolLoop,
  CheckpointPrompt,
  ContextWarningSink,
  StreamBatch,
} from './toolLoop';
import { ThinkingProgress } from './executor';
import { condenseThinking } from './thinking';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';
import { limits } from '../../config/limits';
import { Complexity, ComplexitySchema, PartialPlan, Plan } from '../../protocol/types';
import { ToolHost } from '../../protocol/toolContract';

export type { PartialPlan, PartialPlanStep } from '../../protocol/types';

/**
 * The wrap-up instruction appended when planning is cut short - by the user
 * choosing "stop" at a check-in, or by hitting the step ceiling - so the run
 * still yields a real plan drawn from what was explored rather than ending
 * exploration with no plan. Tools off, so the model can only conclude.
 */
const FINALIZE_PLAN_INSTRUCTION =
  'Stop here and do not call any more tools. From everything you have gathered, ' +
  'produce the best plan you can now as the JSON object the schema describes, ' +
  'noting any remaining uncertainty in a step detail rather than exploring further.';

/**
 * A step-by-step plan for a "planning" request. The classifier decides a request
 * needs planning; the Planner turns it into an ordered list of concrete steps,
 * each optionally hinting which workspace tool it will use. The Executor
 * (./executor.ts) then walks these steps and drives the tool-calling loop.
 *
 * This is the generation schema: its describe() strings steer the model. The
 * protocol's PlanSchema (src/protocol/types.ts) is the wire shape of the same
 * data, without the prompt material; anything this schema accepts the protocol
 * schema accepts.
 */
export const PlanStepSchema = z.object({
  title: z
    .string()
    .describe('Short imperative description of the step, e.g. "Read package.json".'),
  detail: z
    .string()
    .describe(
      'Plain prose on what this step does and what its result must satisfy - a ' +
        'sentence or two for a simple step; for a step that creates or changes ' +
        'several files at once, a short sentence per file naming what each must ' +
        'contain. Never any code: no file contents, no snippets - the executor ' +
        'writes the code.'
    ),
});

/**
 * One pivotal design or architectural choice behind the plan, with its reason.
 * Surfaced at the approval gate so the user can judge (and, via Revise, veto)
 * the *approach* before it runs, not just the list of steps. Populated only for
 * genuinely complex changes where the choice matters - see the field's
 * describe() on `PlanSchema.decisions`.
 */
export const PlanDecisionNoteSchema = z.object({
  decision: z
    .string()
    .describe('One key design or architectural choice, stated plainly. Never code.'),
  rationale: z
    .string()
    .describe('One sentence on why this choice over the alternative.'),
});

export const PlanSchema = z.object({
  summary: z
    .string()
    .describe('One sentence restating the goal in your own words.'),
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .max(12)
    .describe(
      'Ordered steps that accomplish the task. Keep it minimal - only the ' +
        'steps actually required, typically 8 or fewer, and never more than 12.'
    ),
  decisions: z
    .array(PlanDecisionNoteSchema)
    .max(3)
    .optional()
    .describe(
      'Up to three pivotal design or architectural decisions behind this plan, ' +
        'each with a one-sentence rationale. Include them ONLY for a complex ' +
        'change where a design choice materially shapes the work and the user ' +
        'benefits from seeing it before approving. Omit the field entirely for a ' +
        'simple or moderate change, or when the plan is self-explanatory. Never ' +
        'code - describe the choice in prose.'
    ),
  complexity: ComplexitySchema.describe(
    'How demanding the work in this plan actually is, now that you have seen ' +
      'the request and any explored context: "simple" for a self-contained ' +
      'change needing little reasoning (e.g. one small file); "moderate" for a ' +
      'typical change touching a few files; "complex" for multi-file changes, ' +
      'subtle debugging, or architectural/performance work. Be honest - a ' +
      '"complex" plan is paused for the user to approve before it runs.'
  ),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanResult = Plan;

/** Receives plan snapshots as the model streams them. Must not throw. */
export type PlanProgress = (partial: PartialPlan) => void;

/**
 * Drafts the plan for a "planning" request. Like the executor, this agent now
 * carries tools and drives a tool-calling loop (the shared one in ./toolLoop):
 * it can `read` and `search` the workspace to ground the plan in what is
 * actually there before committing, and `clarify` to ask the user a focused
 * question when the request is genuinely ambiguous. The plan itself is the
 * model's structured output (`structuredOutput: { schema }`), produced on the
 * terminal step once exploration is done, so the partial-plan snapshots and the
 * self-repair around validation both carry over from the structured-output-only
 * planner. It never writes, edits, or runs commands - that is the executor's job.
 */
export class Planner {
  private readonly modelName: string;
  /** Registry id of the routed model, for the context-window lookup. */
  private readonly modelId: string;
  /** Display label of the routed model, shown in a context warning. */
  private readonly modelLabel: string;
  private readonly agent: Agent;
  /**
   * The current run's cancellation signal, set for the duration of `plan`. The
   * tool proxies read it through the getter handed to `buildPlannerTools`, so a
   * cancelled request stops an in-flight read or search even though the toolset
   * is built once here.
   */
  private currentSignal: AbortSignal | undefined;

  /**
   * `toolHost` backs the `read`/`search` proxies. `modelPin` is the user's
   * per-run model choice (a registry id, or "auto"/undefined for the capability
   * router). `complexity` is triage's pre-exploration judgement of how demanding
   * the work is: it narrows the routed model to that tier (cheaper for simple
   * work, stronger for complex), unless the user pinned a model or turned
   * `complexityRouting` off - exactly like the executor. The `clarify` tool is
   * built when the run's offered tools include it (the client lists it when it
   * can show the question pop-up); absent, the planner drafts from a reasonable
   * assumption instead of asking. The planner is built once the triage complexity
   * is known (the workflow's draft-plan step builds it), so all of these are
   * resolved here.
   */
  constructor(toolHost: ToolHost, modelPin?: string, complexity?: Complexity) {
    const routed = routeModel(agents.planner.capabilities, modelPin, undefined, complexity);
    this.modelName = routed.model;
    this.modelId = routed.id;
    this.modelLabel = routed.label;
    this.agent = new Agent({
      id: agents.planner.id,
      name: agents.planner.name,
      description: agents.planner.description,
      instructions: withSteering(agents.planner.instructions, routed),
      model: resolveModel(agents.planner.capabilities, modelPin, undefined, complexity),
      tools: buildPlannerTools(toolHost, () => this.currentSignal),
    });
  }

  async plan(
    prompt: string,
    onPartial?: PlanProgress,
    onUsage?: UsageReporter,
    signal?: AbortSignal,
    onThinking?: ThinkingProgress,
    onCheckpoint?: CheckpointPrompt,
    onContextWarning?: ContextWarningSink
  ): Promise<PlanResult> {
    this.currentSignal = signal;
    try {
      return await this.draft(
        prompt,
        onPartial,
        onUsage,
        signal,
        onThinking,
        onCheckpoint,
        onContextWarning
      );
    } finally {
      this.currentSignal = undefined;
    }
  }

  private async draft(
    prompt: string,
    onPartial: PlanProgress | undefined,
    onUsage: UsageReporter | undefined,
    signal: AbortSignal | undefined,
    onThinking: ThinkingProgress | undefined,
    onCheckpoint: CheckpointPrompt | undefined,
    onContextWarning: ContextWarningSink | undefined
  ): Promise<PlanResult> {
    // Validate rather than cast: a missing or malformed object would otherwise
    // render as broken markdown later. On a validation failure, parseWithRepair
    // re-asks with the zod issues appended (see ./repair.ts) before the step
    // fails for real; a repair attempt simply re-runs the loop and re-streams a
    // fresh plan, which overwrites the partial snapshots already shown.
    return parseWithRepair(PlanSchema, async (repair) => {
      const content = repair ? `${prompt}\n\n${repair}` : prompt;
      // The model's reasoning, accumulated only to condense the latest line for
      // the thinking sink (kept out of the plan, like the executor's transcript).
      let reasoning = '';
      // The most recent tool the planner called, for the check-in prompt's label.
      let lastTool: string | undefined;
      // The latest structured object the model produced; the terminal batch's is
      // the plan. Captured across batches so a cut-short finalize turn's plan wins.
      let captured: unknown;

      // Drain one batch's chunk stream: forward partial plans and reasoning, note
      // the last tool call for the check-in label, and fail on an `error` chunk.
      // Reading it is what drives the batch's tool-calling loop to completion, so
      // it runs even when nobody listens. The plan object arrives as `object`
      // chunks (its partial on `payload.object`); the final, validated object is
      // read from `output.object` once the batch's stream has drained.
      const drain = async (stream: ReadableStream<unknown>): Promise<void> => {
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = value as { type: string; payload?: any };
          switch (chunk.type) {
            case 'reasoning-delta':
            case 'reasoning': {
              if (onThinking) {
                const delta: string = chunk.payload?.text ?? '';
                if (delta) {
                  reasoning += delta;
                  const line = condenseThinking(reasoning, limits.thinking.lineMaxChars);
                  if (line) {
                    onThinking(line);
                  }
                }
              }
              break;
            }
            case 'object': {
              const partial = chunk.payload?.object;
              if (partial !== undefined) {
                onPartial?.(partial as PartialPlan);
              }
              break;
            }
            case 'tool-call': {
              const tool = String(chunk.payload?.toolName ?? '');
              if (tool) {
                lastTool = tool;
              }
              break;
            }
            case 'error': {
              const error = chunk.payload?.error;
              throw error instanceof Error ? error : new Error(String(error));
            }
          }
        }
      };

      // One batch: stream the model (with the plan schema) over the carried
      // messages, drain it, then capture the batch's object and metadata. Reading
      // the object/response/usage is best-effort - a batch that only explored
      // produces no object, and a provider may surface no counts.
      const streamBatch: StreamBatch = async (messages, control) => {
        const options: Record<string, unknown> = {
          structuredOutput: { schema: PlanSchema },
        };
        if (agents.planner.modelSettings) {
          options.modelSettings = agents.planner.modelSettings;
        }
        if (control.stopWhen !== undefined) {
          options.stopWhen = control.stopWhen;
        }
        if (control.toolChoice !== undefined) {
          options.toolChoice = control.toolChoice;
        }
        if (control.signal) {
          options.abortSignal = control.signal;
        }
        const output = await this.agent.stream(messages, options as never);
        await drain(output.fullStream as ReadableStream<unknown>);
        try {
          const object = await output.object;
          if (object !== undefined) {
            captured = object;
          }
        } catch {
          // This batch produced no object (it only explored); the next one will.
        }
        let responseMessages: ModelMessage[] = [];
        try {
          const response = (await output.response) as { messages?: ModelMessage[] };
          if (Array.isArray(response?.messages)) {
            responseMessages = response.messages;
          }
        } catch {
          // No response messages to carry; the next batch re-sends what we have.
        }
        const counts = await readUsage(output);
        let steps = 0;
        let finishReason: string | undefined;
        try {
          steps = (await output.steps)?.length ?? 0;
          finishReason = await output.finishReason;
        } catch {
          // Treat missing metadata as a cut-off batch (not a natural finish).
        }
        return { steps, finishReason, counts, responseMessages };
      };

      const { totals, anyReported } = await runToolLoop({
        prompt: content,
        streamBatch,
        finalizeInstruction: FINALIZE_PLAN_INSTRUCTION,
        lastActionLabel: () => lastTool,
        signal,
        onCheckpoint,
        contextWindow: onContextWarning ? contextWindowFor(this.modelId) : undefined,
        modelLabel: this.modelLabel,
        onContextWarning,
      });

      // A repair attempt is a real re-run: report it (flagged repaired) so the
      // billing seam and the eval log see the extra spend.
      onUsage?.({
        model: this.modelName,
        ...(anyReported ? totals : estimateTokenCounts(content, JSON.stringify(captured ?? {}))),
        ...(repair ? { repaired: true } : {}),
      });
      return captured;
    });
  }
}
