/**
 * Capability-derived model steering. The shared agent prompts (config/agents.ts)
 * describe *what* an agent does and assume a capable model; they do not change
 * with the model. A weaker model needs extra nudging to hit the same bar -
 * stricter output formatting, more explicit step-by-step reasoning, less
 * guessing. Rather than fork a whole prompt per model (an agents x models matrix
 * that drifts), this derives a small extra "Model-specific guidance" section
 * from the *routed model's* capability scores (config/models.ts): each rule
 * fires only when the model scores below its threshold, so a frontier model
 * (Opus/Sonnet/GPT-4.1) clears every threshold and gets an empty section (extra
 * hand-holding tends to make a strong model verbose or over-cautious), a strong
 * open/cloud model (e.g. DeepSeek) picks up a line or two, and a small local
 * model collects most of them.
 *
 * This keeps the rest of the router's future-proofing: a newly registered model
 * needs no steering config - its capability scores decide automatically. Pure
 * data and string assembly, no editor or runtime dependency, so it stays inside
 * the engine's vscode-free config layer.
 */
import type { Capability, ModelInfo } from './models';

interface SteeringRule {
  /** The capability whose score on the routed model gates this rule. */
  capability: Capability;
  /** Fire the rule when the model's score for `capability` is below this. */
  below: number;
  /** The guidance line added to the prompt when the rule fires. */
  line: string;
}

/**
 * The steering rules. Each threshold sits just above where the frontier models
 * score (see config/models/*.md): Opus, Sonnet, and GPT-4.1 clear every one and
 * get no extra guidance; DeepSeek's structured-output (0.88) trips the format
 * rule; the small local models trip most rules. Edit the thresholds here to
 * retune the split - no per-model config is involved.
 */
const STEERING_RULES: readonly SteeringRule[] = [
  {
    capability: 'structured-output',
    below: 0.9,
    line: 'When your reply must follow a specific format (a tool call, JSON, or a required structure), emit exactly that and nothing else - no surrounding prose, no commentary, and no markdown code fences around it unless they were asked for.',
  },
  {
    capability: 'reasoning',
    below: 0.8,
    line: 'Work through the problem one step at a time before you act or answer. Do not skip steps or guess at a conclusion you have not reasoned out.',
  },
  {
    capability: 'code-generation',
    below: 0.85,
    line: 'Do not invent file paths, APIs, function names, or identifiers. When you are not certain something exists, use a tool to verify it rather than assuming.',
  },
];

/** Heading the steering lines are grouped under when any rule fires. */
const STEERING_HEADER = '## Model-specific guidance';

/**
 * The steering section for a routed model: the lines for every rule whose
 * capability the model scores below threshold (a missing score counts as 0, so
 * an unscored model gets the full set of help). Empty string when the model
 * clears every threshold, so a strong model's prompt is left untouched.
 */
export function steeringFor(info: ModelInfo): string {
  const lines = STEERING_RULES.filter(
    (rule) => (info.capabilities[rule.capability] ?? 0) < rule.below
  ).map((rule) => `- ${rule.line}`);
  return lines.length === 0 ? '' : `${STEERING_HEADER}\n\n${lines.join('\n')}`;
}

/**
 * `base` instructions with the routed model's steering section appended, or
 * `base` unchanged when the model needs none. The single seam each agent uses
 * to layer model-specific guidance onto its shared prompt.
 */
export function withSteering(base: string, info: ModelInfo): string {
  const steering = steeringFor(info);
  return steering ? `${base}\n\n${steering}` : base;
}
