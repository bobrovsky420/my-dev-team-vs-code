import { Agent } from '@mastra/core/agent';
import { resolveModel, routeModel } from './models';
import { resolveTokenCounts, UsageReporter } from './usage';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';

/**
 * Receives the summary-so-far as the model streams it (full accumulated text,
 * not a delta, like the answerer). Must not throw.
 */
export type CompactProgress = (textSoFar: string) => void;

/**
 * Condenses the whole conversation into a briefing that replaces it (the
 * `/compact` command, manual or automatic). Unlike the answerer this is not a
 * reply to the user's prompt but a summary of the conversation, so it gets its
 * own agent (config/agents/compacter.md) whose capabilities weight
 * `long-context` high - Auto routes it to a big-window model, and the engine
 * sizes how much conversation to feed it from that model's window. The routed
 * model's registry id is exposed so the compact path can look up its window.
 */
export class Compacter {
  /** Registry id of the routed model, for the context-window lookup. */
  readonly modelId: string;
  /** Display label of the routed model, for the run's model selection. */
  readonly modelLabel: string;
  private readonly modelName: string;
  private readonly agent: Agent;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined for the capability router). The LocalEngine builds a fresh
   * Compacter per compact run with the request's choice.
   */
  constructor(modelPin?: string) {
    const routed = routeModel(agents.compacter.capabilities, modelPin);
    this.modelId = routed.id;
    this.modelLabel = routed.label;
    this.modelName = routed.model;
    this.agent = new Agent({
      id: agents.compacter.id,
      name: agents.compacter.name,
      description: agents.compacter.description,
      instructions: withSteering(agents.compacter.instructions, routed),
      model: resolveModel(agents.compacter.capabilities, modelPin),
    });
  }

  /**
   * Summarize the conversation in `prompt` (the rendered, already budget-trimmed
   * conversation), streaming the briefing as it forms. No tools and no
   * structured output: the product is the prose summary itself.
   */
  async compact(
    prompt: string,
    onPartial?: CompactProgress,
    onUsage?: UsageReporter,
    signal?: AbortSignal
  ): Promise<string> {
    const messages = [{ role: 'user' as const, content: prompt }];
    const output = signal
      ? await this.agent.stream(messages, {
          abortSignal: signal,
          modelSettings: agents.compacter.modelSettings,
        })
      : await this.agent.stream(messages, {
          modelSettings: agents.compacter.modelSettings,
        });
    // Drain the text stream (which also drives the generation to completion, so
    // it runs even with no listener); reasoning chunks are ignored - the summary
    // is the only product.
    const reader = output.fullStream.getReader();
    let text = '';
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
      }
    }
    onUsage?.({
      model: this.modelName,
      ...(await resolveTokenCounts(output, prompt, text)),
    });
    return text;
  }
}
