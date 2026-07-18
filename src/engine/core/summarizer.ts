import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { resolveModel, routeModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { parseWithRepair } from './repair';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';
import { PartialSummary, Summary } from '../../protocol/types';

export type { PartialSummary } from '../../protocol/types';

/**
 * The end-of-run recap of an executed plan, in three fixed sections (what
 * ships, how it's built, tests and docs) so the user can skim a change the way
 * they would a pull request. The Executor (./executor.ts) does the work; the
 * Summarizer turns the plan plus the execution transcript into this recap.
 *
 * This is the generation schema: its describe() strings steer the model. The
 * protocol's SummarySchema (src/protocol/types.ts) is the wire shape of the
 * same data without the prompt material; anything this schema accepts the
 * protocol schema accepts.
 */
export const SummaryGenSchema = z.object({
  whatShips: z
    .string()
    .describe(
      'What the change delivers, from the user\'s point of view. One to three sentences or a few short bullets.'
    ),
  howItsBuilt: z
    .string()
    .describe(
      'The approach taken and the main files or pieces touched. One to three sentences or a few short bullets; do not repeat whatShips.'
    ),
  testsAndDocs: z
    .string()
    .describe(
      'The tests added or updated and the docs changed; say so plainly when there were none. One to three sentences or a few short bullets.'
    ),
});

export type SummaryResult = Summary;

/** Receives summary snapshots as the model streams them. Must not throw. */
export type SummaryProgress = (partial: PartialSummary) => void;

export class Summarizer {
  private readonly modelName: string;
  private readonly agent: Agent;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined to let the capability router pick). Resolved once here because
   * the LocalEngine builds a fresh Summarizer per run with the request's choice.
   */
  constructor(modelPin?: string) {
    const routed = routeModel(agents.summarizer.capabilities, modelPin);
    this.modelName = routed.model;
    this.agent = new Agent({
      id: agents.summarizer.id,
      name: agents.summarizer.name,
      description: agents.summarizer.description,
      instructions: withSteering(agents.summarizer.instructions, routed),
      model: resolveModel(agents.summarizer.capabilities, modelPin),
    });
  }

  async summarize(
    prompt: string,
    onPartial?: SummaryProgress,
    onUsage?: UsageReporter
  ): Promise<SummaryResult> {
    // Validate rather than cast, and self-repair once on a schema failure -
    // exactly like the planner: a repair attempt re-streams a fresh summary,
    // overwriting the partial snapshots already shown.
    return parseWithRepair(SummaryGenSchema, async (repair) => {
      const content = repair ? `${prompt}\n\n${repair}` : prompt;
      const output = await this.agent.stream(
        [{ role: 'user', content }],
        {
          structuredOutput: { schema: SummaryGenSchema },
          modelSettings: agents.summarizer.modelSettings,
        }
      );
      // Drain the partial-object stream, forwarding each snapshot; reading it
      // also drives the generation to completion, so this runs even with no
      // listener.
      const reader = output.objectStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          onPartial?.(value as PartialSummary);
        }
      }
      const summary = await output.object;
      const counts = await resolveTokenCounts(output, content, JSON.stringify(summary ?? {}));
      onUsage?.({
        model: this.modelName,
        ...counts,
        ...(repair ? { repaired: true } : {}),
      });
      return summary;
    });
  }
}
