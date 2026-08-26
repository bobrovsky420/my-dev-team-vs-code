/** Provider/model-specific request normalisation required by current APIs. */
import { LanguageModelMiddleware } from 'ai';

/**
 * Some frontier APIs choose their own sampling configuration and reject the
 * generic knobs our agent frontmatter may supply. Keep the policy beside the
 * provider boundary so every agent and both generate/stream paths behave alike.
 */
export function modelCompatibilityMiddleware(
  provider: string,
  modelId: string
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const fixedSampling =
        (provider === 'google' && modelId.startsWith('gemini-3.7')) ||
        (provider === 'kimi' && modelId.startsWith('kimi-'));
      if (!fixedSampling) {
        return params;
      }
      const transformed = { ...params };
      delete transformed.temperature;
      delete transformed.topP;
      delete transformed.topK;
      return transformed;
    },
  };
}
