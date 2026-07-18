import { Agent } from '@mastra/core/agent';
import { resolveModel, routeModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { condenseThinking } from './thinking';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';
import { limits } from '../../config/limits';
import type { ThinkingProgress } from './executor';

/**
 * Receives the answer-so-far as the model streams it. Each call carries the
 * full accumulated text, not a delta, so snapshots have the same grow-only
 * shape as the planner's partial plans. Must not throw.
 */
export type AnswerProgress = (textSoFar: string) => void;

/**
 * Direct answer for a "oneshot" request. The classifier decides a request
 * needs no planning; the Answerer replies in a single model call, streaming
 * the markdown answer as it forms. No tools and no structured output: the
 * product is the prose itself.
 */
export class Answerer {
  private readonly modelName: string;
  private readonly agent: Agent;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined for the capability router). The LocalEngine builds a fresh
   * Answerer per run with the run request's choice.
   */
  constructor(modelPin?: string) {
    const routed = routeModel(agents.answerer.capabilities, modelPin);
    this.modelName = routed.model;
    this.agent = new Agent({
      id: agents.answerer.id,
      name: agents.answerer.name,
      description: agents.answerer.description,
      instructions: withSteering(agents.answerer.instructions, routed),
      model: resolveModel(agents.answerer.capabilities, modelPin),
    });
  }

  async answer(
    prompt: string,
    onPartial?: AnswerProgress,
    onUsage?: UsageReporter,
    onThinking?: ThinkingProgress
  ): Promise<string> {
    const output = await this.agent.stream([{ role: 'user', content: prompt }], {
      modelSettings: agents.answerer.modelSettings,
    });
    // The full chunk stream so a reasoning model's `<think>` output can be
    // split from the answer: `text-delta` chunks accumulate into the answer
    // snapshots, `reasoning` chunks feed the (ephemeral) thinking sink and are
    // kept out of the answer. Reading the stream is also what drives the
    // generation to completion, so this loop runs even when nobody listens.
    const reader = output.fullStream.getReader();
    let text = '';
    let reasoning = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value as { type: string; payload?: { text?: string } };
      if (chunk.type === 'text-delta') {
        const delta = chunk.payload?.text ?? '';
        if (delta) {
          text += delta;
          onPartial?.(text);
        }
      } else if (
        onThinking &&
        (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning')
      ) {
        const delta = chunk.payload?.text ?? '';
        if (delta) {
          reasoning += delta;
          const line = condenseThinking(reasoning, limits.thinking.lineMaxChars);
          if (line) {
            onThinking(line);
          }
        }
      }
    }
    onUsage?.({
      model: this.modelName,
      ...(await resolveTokenCounts(output, prompt, text)),
    });
    return text;
  }
}
