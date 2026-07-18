/**
 * Debug logging for the backend <-> provider leg: an AI SDK language-model
 * middleware that, when `myDevTeam.debug` is on, emits each provider call's raw
 * request (the messages sent to the model) and raw response (the generated text,
 * tool calls, finish reason, and token usage) to the injected debug sink
 * (config/debugLog.ts). It sits next to the rate limiter (core/models.ts wraps
 * every model in both) and, like it, reads the flag live, so toggling debug takes
 * effect on the next request with no rebuild and no cost when it is off.
 *
 * It only ever observes - it forwards `doGenerate`/`doStream` untouched and
 * swallows its own logging errors, so debug logging can never change or fail the
 * run it is watching.
 */
import { LanguageModelMiddleware } from 'ai';
import { runtimeConfig } from '../../config/runtimeConfig';
import { emitDebug, stringifyDetail } from '../../config/debugLog';

/** The fields of a stream part this logger reads; structural to stay version-agnostic. */
interface StreamPartShape {
  type?: string;
  delta?: string;
  textDelta?: string;
}

/** A short tag identifying which provider/model a logged call went to. */
function tag(provider: string, modelId: string): string {
  return `${provider} / ${modelId}`;
}

/** Emit the request leg: the raw params (which carry the prompt messages). */
function logRequest(provider: string, modelId: string, kind: string, params: unknown): void {
  emitDebug({
    source: 'provider',
    label: `request (${tag(provider, modelId)}, ${kind})`,
    detail: stringifyDetail(params),
  });
}

/** Emit the response leg with whatever the call produced. */
function logResponse(provider: string, modelId: string, kind: string, payload: unknown): void {
  emitDebug({
    source: 'provider',
    label: `response (${tag(provider, modelId)}, ${kind})`,
    detail: stringifyDetail(payload),
  });
}

/**
 * The debug-logging middleware for one provider's wired models. `modelId` is the
 * provider's own model id (e.g. "claude-..."), used only to tag the log lines.
 */
export function providerDebugMiddleware(
  provider: string,
  modelId: string
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      if (!runtimeConfig().debugEnabled) {
        return doGenerate();
      }
      logRequest(provider, modelId, 'generate', params);
      const result = await doGenerate();
      logResponse(provider, modelId, 'generate', result);
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      if (!runtimeConfig().debugEnabled) {
        return doStream();
      }
      logRequest(provider, modelId, 'stream', params);
      const result = await doStream();
      // Tap the stream to assemble the response without consuming it: collect the
      // text deltas and the terminal finish part, and log the whole reply when the
      // stream ends. A logging error in the transform must not break the stream.
      let text = '';
      let finish: unknown;
      const tapped = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            try {
              const p = part as StreamPartShape;
              if (p.type === 'text-delta') {
                text += p.delta ?? p.textDelta ?? '';
              } else if (p.type === 'finish') {
                finish = p;
              }
            } catch {
              // Ignore: tapping is best-effort, the part still flows through.
            }
            controller.enqueue(part);
          },
          flush() {
            logResponse(provider, modelId, 'stream', { text, finish });
          },
        })
      );
      return { ...result, stream: tapped };
    },
  };
}
