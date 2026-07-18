import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { routeTriageModel, resolveTriageModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';
import { ClarifyQuestionGenSchema, CLARIFY_GUIDANCE } from './clarify';
import { ComplexitySchema, IntentSchema } from '../../protocol/types';

/**
 * Triage decision for a user request:
 *   - "oneshot":  answer directly in a single model call, no planning needed.
 *   - "planning": decompose into steps, likely with tool calls.
 *   - "direct":   a small, fully-specified change handed straight to the executor.
 *   - "clarify":  the request is too ambiguous to route; ask the user instead.
 *
 * The schema is the generation schema (its describe() strings steer the
 * model); the intent enum itself is the protocol's, so the engine cannot
 * produce a routing the protocol does not know. `questions` carries the
 * clarifying questions when (and only when) the route is "clarify"; the workflow
 * normalises them and, if the route is "clarify" with no usable question (or the
 * `myDevTeam.clarify.enabled` setting is off), falls back to a normal answer. The
 * schema stays a plain object (no refinement) so `TriageSchema.shape` can be
 * spread into the workflow's carried schema.
 */
export const TriageSchema = z.object({
  intent: IntentSchema.describe(
    '"oneshot" when the deliverable is text in the chat (an explanation, review, or opinion); "direct" when the workspace should change but the change is small and fully specified - a few lines, or one small well-described function - needing no exploration or plan; "planning" for any larger or less certain change that should be decomposed into steps first; "clarify" when the request is genuinely too ambiguous to route well and you must ask the user before doing anything. ' +
      CLARIFY_GUIDANCE
  ),
  complexity: ComplexitySchema.describe(
    'How demanding the work is: "simple" for a self-contained task needing little reasoning or exploration (e.g. a single small script); "moderate" for a typical change touching a few files; "complex" for multi-file changes, subtle debugging, or architectural/performance work.'
  ),
  reason: z.string().describe('One short sentence explaining the choice.'),
  questions: z
    .array(ClarifyQuestionGenSchema)
    .max(2)
    .optional()
    .describe(
      'Required when intent is "clarify": one or two focused questions to put to the user. Omit entirely for any other intent.'
    ),
});

export type TriageResult = z.infer<typeof TriageSchema>;

export class Triage {
  private readonly modelName: string;
  private readonly agent: Agent;

  // Triage routes per `myDevTeam.triage.model`; when that is unset it cascades to
  // the work model (`myDevTeam.model`) and only then to the backend
  // `agents.triage.model` floor - the local Ollama default that keeps the
  // all-Auto setup's classification cheap and free, while a user who picks a
  // cloud provider for the work agents gets triage on it too (see
  // `triageRouting`). The routed entry is resolved once here so its capability
  // scores can steer the prompt (small local classifiers routinely need the
  // format and step-by-step nudges).
  constructor() {
    const routed = routeTriageModel(agents.triage.capabilities);
    this.modelName = routed.model;
    this.agent = new Agent({
      id: agents.triage.id,
      name: agents.triage.name,
      description: agents.triage.description,
      instructions: withSteering(agents.triage.instructions, routed),
      model: resolveTriageModel(agents.triage.capabilities),
    });
  }

  async classify(prompt: string, onUsage?: UsageReporter): Promise<TriageResult> {
    // Validate rather than cast: a missing or malformed object would otherwise
    // render as "intent: undefined" later. On a validation failure, parseWithRepair
    // re-asks once with the zod issues appended (see ./repair.ts) before the
    // step fails for real - small local models routinely need that nudge.
    return parseWithRepair(TriageSchema, async (repair) => {
      const content = repair ? `${prompt}\n\n${repair}` : prompt;
      const result = await this.agent.generate(
        [{ role: 'user', content }],
        {
          structuredOutput: { schema: TriageSchema },
          modelSettings: agents.triage.modelSettings,
        }
      );
      const counts = await resolveTokenCounts(
        result,
        content,
        JSON.stringify(result.object ?? {})
      );
      // The retry is a real second model call: report it (flagged repaired) so
      // the billing seam and the eval log see the extra spend.
      onUsage?.({
        model: this.modelName,
        ...counts,
        ...(repair ? { repaired: true } : {}),
      });
      return result.object;
    });
  }
}
