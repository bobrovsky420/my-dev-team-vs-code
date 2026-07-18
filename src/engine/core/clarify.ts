/**
 * The clarify route's engine-side material: the generation schema one
 * clarifying question is produced against (with describe() prompt steering) and
 * the normaliser that turns a model's raw questions into the protocol's wire
 * shape. Shared by the two agents that may route to "clarify" - triage (classic
 * mode) and the responder (combined mode) - so the question shape and the
 * "ask sparingly" discipline read identically in both.
 *
 * The generation schema is a superset-shaped match of the protocol's
 * `ClarifyQuestionSchema` (src/protocol/types.ts): anything it accepts the wire
 * schema accepts, so a question the model drafts is shaped exactly like one the
 * client renders.
 */
import { z } from 'zod';
import { partials } from '../config/partials';
import { ClarifyQuestion } from '../../protocol/types';

export const ClarifyQuestionGenSchema = z.object({
  question: z
    .string()
    .describe(
      'The single, specific thing you need the user to decide, as one plain-prose question. No preamble.'
    ),
  options: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe(
      'Two to five short, mutually exclusive answers the user can pick from. A few words each, not full sentences.'
    ),
  allowOther: z
    .boolean()
    .describe(
      'True when the options may not cover every case and the user should also be able to answer in their own words.'
    ),
});

export type ClarifyQuestionGen = z.infer<typeof ClarifyQuestionGenSchema>;

/**
 * The shared guidance both agents carry on *when* to ask rather than route: a
 * deliberately high bar, because a coding agent that interrupts on every
 * ambiguity is worse than one that picks a sensible default and states its
 * assumption. Rendered into the triage and responder prompts. The text is the
 * shared clarify-guidance partial (generated from my-dev-team-config, also
 * consumed by my-dev-team's Product Manager), flattened to one line for a
 * schema description.
 */
export const CLARIFY_GUIDANCE = partials['clarify-guidance'].replace(/\s+/g, ' ');

/**
 * Normalise a model's drafted questions to the protocol's wire shape, dropping
 * any with no question text and trimming/filtering the options. Returns an empty
 * array when there are none, so a "clarify" route with no usable question can be
 * coerced back to a normal answer by the caller.
 */
export function normalizeQuestions(
  questions: ClarifyQuestionGen[] | undefined
): ClarifyQuestion[] {
  return (questions ?? [])
    .filter((q) => q && typeof q.question === 'string' && q.question.trim().length > 0)
    .map((q) => ({
      question: q.question.trim(),
      options: (q.options ?? [])
        .filter((o) => typeof o === 'string' && o.trim().length > 0)
        .map((o) => o.trim()),
      allowOther: q.allowOther !== false,
    }));
}
