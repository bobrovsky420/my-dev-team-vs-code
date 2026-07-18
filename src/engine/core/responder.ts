import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel, routeModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { PlanStepSchema, PlanDecisionNoteSchema } from './planner';
import { ClarifyQuestionGenSchema, CLARIFY_GUIDANCE, normalizeQuestions } from './clarify';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';
import {
  ClarifyQuestion,
  Complexity,
  ComplexitySchema,
  IntentSchema,
  PartialPlan,
  Plan,
} from '../../protocol/types';

/**
 * The combined triage + answerer + planner. One model call reads the request
 * and either answers it directly (the answerer's job) or drafts a plan to hand
 * to the executor (triage + planner's job), deciding the route itself instead
 * of a separate cheap triage call. It is the opt-in alternative to the
 * three-agent path, selected by `myDevTeam.triage.mode` = "combined" and used
 * only on the unpinned request path (a slash command still pins the route and
 * uses the dedicated planner/answerer, so /plan's plan-only and /fix's
 * complexity pin keep working).
 *
 * Because the same call both routes and produces the work, the route cannot
 * size the responder's own model by complexity (that is decided in the same
 * breath) - it routes by capability and the user's pin, like the answerer. The
 * executor it hands a plan to is still sized by the plan's complexity.
 */

/**
 * The generation schema the model fills: a flat object so a small local model
 * only has to set fields, not pick a union arm. `intent` selects which fields
 * matter - `answer` for "oneshot", the plan fields for "planning" - and the
 * refined `ResponderSchema` below enforces that pairing for validation/repair.
 * The describe() strings steer the model; the plan field shapes are the
 * planner's, so a plan the responder drafts is shaped exactly like one the
 * dedicated planner would.
 */
export const ResponderObjectSchema = z.object({
  intent: IntentSchema.describe(
    '"oneshot" when the deliverable is text in the chat; "direct" when the workspace should change but the change is small and fully specified (a few lines, or one small well-described function) and needs no plan - it is handed straight to the executor; "planning" for any larger or less certain change that should be decomposed into steps first; "clarify" when the request is genuinely too ambiguous to route well and you must ask the user before doing anything. ' +
      CLARIFY_GUIDANCE
  ),
  reason: z.string().describe('One short sentence explaining the routing choice.'),
  complexity: ComplexitySchema.describe(
    'How demanding the work is: "simple" for a self-contained task needing little reasoning or exploration; "moderate" for a typical change touching a few files; "complex" for multi-file changes, subtle debugging, or architectural/performance work.'
  ),
  answer: z
    .string()
    .optional()
    .describe(
      'Required when intent is "oneshot": the full answer to the user, in markdown. Leave empty for "planning".'
    ),
  summary: z
    .string()
    .optional()
    .describe(
      'Required when intent is "planning": one sentence restating the goal in your own words. Leave empty for "oneshot".'
    ),
  steps: z
    .array(PlanStepSchema)
    .max(12)
    .optional()
    .describe(
      'Required when intent is "planning": the ordered steps that accomplish the task, typically 8 or fewer and never more than 12. Leave empty for "oneshot".'
    ),
  decisions: z
    .array(PlanDecisionNoteSchema)
    .max(3)
    .optional()
    .describe(
      'For a "complex" plan only: up to three pivotal design decisions, each with a one-sentence rationale. Omit otherwise.'
    ),
  questions: z
    .array(ClarifyQuestionGenSchema)
    .max(2)
    .optional()
    .describe(
      'Required when intent is "clarify": one or two focused questions to put to the user. Omit entirely for any other intent.'
    ),
});

export type ResponderObject = z.infer<typeof ResponderObjectSchema>;

/**
 * The validation schema: the object plus the intent/field pairing. A "oneshot"
 * must carry a non-empty `answer`; a "planning" must carry a `summary` and at
 * least one step; a "direct" needs neither (it is handed straight to the
 * executor with no plan). A mismatch fails validation, so `parseWithRepair`
 * re-asks the model once with the issue appended (see ./repair.ts) - the same
 * nudge the triage and planner steps rely on.
 */
export const ResponderSchema = ResponderObjectSchema.superRefine((value, ctx) => {
  if (value.intent === 'oneshot') {
    if (!value.answer || !value.answer.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer'],
        message: 'answer is required (and non-empty) when intent is "oneshot".',
      });
    }
  } else if (value.intent === 'planning') {
    if (!value.summary || !value.summary.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'summary is required when intent is "planning".',
      });
    }
    if (!value.steps || value.steps.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: 'at least one step is required when intent is "planning".',
      });
    }
  } else if (value.intent === 'clarify') {
    if (!value.questions || value.questions.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questions'],
        message: 'at least one question is required when intent is "clarify".',
      });
    }
  }
  // "direct" carries only intent/reason/complexity - nothing more to require.
});

/**
 * The responder's decision, normalised for the workflow: either a direct answer
 * (the oneshot path, terminal) or a drafted plan (the planning path, handed to
 * the executor). The plan is a full protocol `Plan`, exactly what the dedicated
 * planner produces, so the rest of the pipeline cannot tell which drafted it.
 */
export type ResponderDecision =
  | { intent: 'oneshot'; reason: string; complexity: Complexity; answer: string }
  | { intent: 'planning'; reason: string; complexity: Complexity; plan: Plan }
  | { intent: 'direct'; reason: string; complexity: Complexity }
  | { intent: 'clarify'; reason: string; complexity: Complexity; questions: ClarifyQuestion[] };

/**
 * A streamed snapshot of the responder's output as it forms: the route once it
 * is known, then either the growing answer text or the partial plan. Only
 * emitted once `intent` is set, so the workflow always has a route to render
 * the snapshot against (mirroring the planner's and answerer's progress).
 */
export interface ResponderProgress {
  intent: 'oneshot' | 'planning' | 'direct' | 'clarify';
  reason?: string;
  complexity?: Complexity;
  answer?: string;
  plan?: PartialPlan;
}

/** Receives responder snapshots as the model streams them. Must not throw. */
export type ResponderProgressSink = (progress: ResponderProgress) => void;

/** Build the partial plan view from a streamed partial planning object. */
function partialPlan(partial: Partial<ResponderObject>): PartialPlan {
  return {
    ...(partial.summary !== undefined ? { summary: partial.summary } : {}),
    ...(partial.steps !== undefined ? { steps: partial.steps as PartialPlan['steps'] } : {}),
    ...(partial.decisions !== undefined
      ? { decisions: partial.decisions as PartialPlan['decisions'] }
      : {}),
    ...(partial.complexity !== undefined ? { complexity: partial.complexity } : {}),
  };
}

export class Responder {
  private readonly modelName: string;
  private readonly agent: Agent;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined for the capability router). Built once per run by the LocalEngine,
   * like the answerer; not sized by complexity (it decides complexity itself).
   */
  constructor(modelPin?: string) {
    const routed = routeModel(agents.responder.capabilities, modelPin);
    this.modelName = routed.model;
    this.agent = new Agent({
      id: agents.responder.id,
      name: agents.responder.name,
      description: agents.responder.description,
      instructions: withSteering(agents.responder.instructions, routed),
      model: resolveModel(agents.responder.capabilities, modelPin),
    });
  }

  async respond(
    prompt: string,
    onPartial?: ResponderProgressSink,
    onUsage?: UsageReporter
  ): Promise<ResponderDecision> {
    // Validate rather than cast: a malformed or intent-mismatched object would
    // otherwise render as broken markdown or a planless planning route. On a
    // validation failure parseWithRepair re-asks once with the zod issues
    // appended before the step fails; a repair re-streams a fresh object, which
    // overwrites the partial snapshots already shown.
    const object = await parseWithRepair(ResponderSchema, async (repair) => {
      const content = repair ? `${prompt}\n\n${repair}` : prompt;
      const output = await this.agent.stream(
        [{ role: 'user', content }],
        {
          structuredOutput: { schema: ResponderObjectSchema },
          modelSettings: agents.responder.modelSettings,
        }
      );
      // Drain the partial-object stream, forwarding each snapshot once the route
      // is known; reading it also drives the generation to completion, so this
      // loop runs even when nobody listens.
      const reader = output.objectStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const partial = value as Partial<ResponderObject> | undefined;
        if (partial?.intent && onPartial) {
          if (partial.intent === 'oneshot') {
            onPartial({
              intent: 'oneshot',
              reason: partial.reason,
              complexity: partial.complexity,
              answer: partial.answer,
            });
          } else if (partial.intent === 'planning') {
            onPartial({
              intent: 'planning',
              reason: partial.reason,
              complexity: partial.complexity,
              plan: partialPlan(partial),
            });
          } else if (partial.intent === 'clarify') {
            // "clarify": only the route and reason stream; the questions arrive
            // whole at the end (they are not usefully partial mid-stream).
            onPartial({
              intent: 'clarify',
              reason: partial.reason,
              complexity: partial.complexity,
            });
          } else {
            // "direct": only the route, reason, and complexity - no body.
            onPartial({
              intent: 'direct',
              reason: partial.reason,
              complexity: partial.complexity,
            });
          }
        }
      }
      const result = await output.object;
      const counts = await resolveTokenCounts(output, content, JSON.stringify(result ?? {}));
      // The retry is a real second model call: report it (flagged repaired) so
      // the billing seam and the eval log see the extra spend. The metering step
      // is "plan"/"answer" by route, set by the caller.
      onUsage?.({
        model: this.modelName,
        ...counts,
        ...(repair ? { repaired: true } : {}),
      });
      return result;
    });

    if (object.intent === 'oneshot') {
      return {
        intent: 'oneshot',
        reason: object.reason,
        complexity: object.complexity,
        answer: object.answer ?? '',
      };
    }
    if (object.intent === 'direct') {
      return {
        intent: 'direct',
        reason: object.reason,
        complexity: object.complexity,
      };
    }
    if (object.intent === 'clarify') {
      return {
        intent: 'clarify',
        reason: object.reason,
        complexity: object.complexity,
        questions: normalizeQuestions(object.questions),
      };
    }
    return {
      intent: 'planning',
      reason: object.reason,
      complexity: object.complexity,
      plan: {
        summary: object.summary ?? '',
        steps: object.steps ?? [],
        ...(object.decisions ? { decisions: object.decisions } : {}),
        complexity: object.complexity,
      },
    };
  }
}
