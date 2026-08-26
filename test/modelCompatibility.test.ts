import { describe, expect, it } from 'vitest';
import { modelCompatibilityMiddleware } from '../src/engine/core/modelCompatibility';

describe('modelCompatibilityMiddleware', () => {
  it('removes sampling parameters for Gemini 3.7', async () => {
    const transform = modelCompatibilityMiddleware('google', 'gemini-3.7-flash')
      .transformParams!;
    const params = await transform({
      type: 'generate',
      params: {
        prompt: [],
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
      },
      model: {} as never,
    });
    expect(params.temperature).toBeUndefined();
    expect(params.topP).toBeUndefined();
    expect(params.topK).toBeUndefined();
  });

  it('leaves other models unchanged', async () => {
    const transform = modelCompatibilityMiddleware('google', 'gemini-3.5-flash-lite')
      .transformParams!;
    const original = { prompt: [], temperature: 0.1 };
    const params = await transform({
      type: 'stream',
      params: original,
      model: {} as never,
    });
    expect(params).toBe(original);
  });
});
