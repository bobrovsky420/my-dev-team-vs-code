import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveModel,
  routeModel,
  localModels,
  availableModels,
  workModels,
  isModelAvailable,
  isModelEnabled,
  isProviderEnabled,
  effectivePin,
  ollamaEndpoint,
  contextWindowFor,
} from '../src/engine/core/models';
import { settings, defaults } from '../src/config/settings';
import {
  selectModel,
  tierPool,
  modelById,
  modelRegistry,
} from '../src/engine/config/models';
import { agents } from '../src/engine/config/agents';
import { credentials } from '../src/config/credentials';
import { providerDescriptor } from '../src/config/providers';
import { limits } from '../src/config/limits';
import { __reset, __setConfig } from './mocks/vscode';

beforeEach(() => {
  __reset();
});

describe('selectModel', () => {
  it('returns a pinned model outright, ignoring weights and candidates', () => {
    const pinned = selectModel(agents.triage.capabilities, 'anthropic-opus', localModels());
    expect(pinned.id).toBe('anthropic-opus');
  });

  it('falls back to the best weighted fit for "auto" or an unknown pin', () => {
    const auto = selectModel(agents.executor.capabilities, 'auto', localModels());
    const unknown = selectModel(agents.executor.capabilities, 'nope', localModels());
    // Among the local models, the coding-heavy executor profile picks the coder.
    expect(auto.id).toBe('qwen3-coder');
    expect(unknown.id).toBe('qwen3-coder');
  });

  it('restricts the weighted choice to the candidate list', () => {
    const only8b = selectModel(agents.executor.capabilities, undefined, [
      modelById('qwen3-8b')!,
    ]);
    expect(only8b.id).toBe('qwen3-8b');
  });

  it('a provider pin routes by weight within that provider only', () => {
    const exec = selectModel(agents.executor.capabilities, 'provider:anthropic');
    const answer = selectModel(agents.answerer.capabilities, 'provider:anthropic');
    // Every choice is an Anthropic model, but the per-agent pick can differ.
    expect(exec.provider).toBe('anthropic');
    expect(answer.provider).toBe('anthropic');
    expect(exec.id).toBe('anthropic-opus'); // coding-heavy profile
  });

  it('routes among the generated Kimi frontier models', () => {
    const exec = selectModel(agents.executor.capabilities, 'provider:kimi');
    expect(exec.provider).toBe('kimi');
    expect(['kimi-k3', 'kimi-k27-code', 'kimi-k26']).toContain(exec.id);
    expect(modelById('kimi-k27-code-highspeed')?.autoRoute).toBe(false);
  });

  it('a provider pin ignores the candidate list and availability', () => {
    // Pinning openai still picks an openai model even though only qwen is a
    // candidate and no key is configured (it bypasses availability, like a
    // model pin - the run then fails with a key hint if the key is missing).
    const picked = selectModel(agents.planner.capabilities, 'provider:openai', [
      modelById('qwen3-8b')!,
    ]);
    expect(picked.provider).toBe('openai');
  });

  it('an unknown provider pin degrades to the candidate weighted fit', () => {
    const picked = selectModel(agents.planner.capabilities, 'provider:nope', localModels());
    expect(picked.provider).toBe('ollama');
  });

  it('routes the compacter to the biggest-window model (long-context capability)', () => {
    // The compacter weights long-context high, so among the local models it
    // picks the one with the largest window (qwen3-coder, 262K) over the small-
    // window 8B/14B - even though they score higher on other capabilities.
    const picked = selectModel(agents.compacter.capabilities, undefined, localModels());
    expect(picked.id).toBe('qwen3-coder');
    expect(picked.contextWindow).toBe(modelById('qwen3-coder')!.contextWindow);
  });
});

describe('selectModel with an isEnabled predicate', () => {
  it('drops a disabled model from a provider-pin pool', () => {
    const enabled = (m: { id: string }) => m.id !== 'anthropic-opus';
    const picked = selectModel(
      agents.executor.capabilities,
      'provider:anthropic',
      undefined,
      undefined,
      enabled
    );
    expect(picked.provider).toBe('anthropic');
    expect(picked.id).not.toBe('anthropic-opus');
  });

  it('falls through a disabled pinned model to the candidate weighted fit', () => {
    const enabled = (m: { id: string }) => m.id !== 'anthropic-opus';
    const picked = selectModel(
      agents.executor.capabilities,
      'anthropic-opus',
      localModels(),
      undefined,
      enabled
    );
    // The disabled pin is ignored, so it routes among the (local) candidates.
    expect(picked.provider).toBe('ollama');
  });

  it('throws when every candidate is disabled', () => {
    expect(() =>
      selectModel(agents.executor.capabilities, undefined, localModels(), undefined, () => false)
    ).toThrow(/disabled/);
  });
});

describe('disabling (user layer via settings)', () => {
  it('isProviderEnabled / isModelEnabled honour the disabled-provider list', () => {
    __setConfig('myDevTeam.disabledProviders', ['ollama']);
    expect(isProviderEnabled('ollama')).toBe(false);
    // A disabled provider disables its models too.
    expect(isModelEnabled(modelById('qwen3-8b')!)).toBe(false);
    expect(isProviderEnabled('anthropic')).toBe(true);
  });

  it('isModelEnabled honours the disabled-model list', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    expect(isModelEnabled(modelById('qwen3-coder')!)).toBe(false);
    expect(isModelEnabled(modelById('qwen3-8b')!)).toBe(true);
  });

  it('contextWindowFor prefers the user override, then the built-in, else undefined', () => {
    const builtin = modelById('qwen3-coder')!.contextWindow;
    expect(builtin).toBeGreaterThan(0);
    expect(contextWindowFor('qwen3-coder')).toBe(builtin);
    // A per-model override wins (e.g. the real num_ctx of a local server).
    __setConfig('myDevTeam.modelContextWindows', { 'qwen3-coder': 8192 });
    expect(contextWindowFor('qwen3-coder')).toBe(8192);
    // Unknown id or none -> undefined (caller then emits no warnings).
    expect(contextWindowFor('does-not-exist')).toBeUndefined();
    expect(contextWindowFor(undefined)).toBeUndefined();
  });

  it('effectivePin drops a disabled model pin and a disabled provider pin', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    __setConfig('myDevTeam.disabledProviders', ['anthropic']);
    expect(effectivePin('qwen3-coder')).toBeUndefined();
    expect(effectivePin('provider:anthropic')).toBeUndefined();
    // An enabled choice (and Auto) passes through unchanged.
    expect(effectivePin('qwen3-8b')).toBe('qwen3-8b');
    expect(effectivePin('auto')).toBe('auto');
  });

  it('availableModels and localModels exclude a disabled model', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    expect(localModels().some((m) => m.id === 'qwen3-coder')).toBe(false);
    expect(availableModels().some((m) => m.id === 'qwen3-coder')).toBe(false);
  });

  it('routeModel hard-blocks a disabled pin, falling back to Auto', () => {
    __setConfig('myDevTeam.disabledModels', ['qwen3-coder']);
    const picked = routeModel(agents.executor.capabilities, 'qwen3-coder', localModels());
    expect(picked.id).not.toBe('qwen3-coder');
    expect(picked.provider).toBe('ollama');
  });
});

describe('custom models (user-registered)', () => {
  const newOpus = {
    id: 'anthropic-opus-9',
    label: 'Claude Opus 9 (Anthropic)',
    provider: 'anthropic',
    model: 'claude-opus-9-future',
    tier: 'complex',
    capabilities: {
      reasoning: 1,
      coding: 1,
      classification: 1,
      planning: 1,
      speed: 1,
      'structured-output': 1,
    },
  };

  it('registers a custom model so it can be pinned and resolved', () => {
    __setConfig('myDevTeam.customModels', [newOpus]);
    expect(modelById('anthropic-opus-9')?.model).toBe('claude-opus-9-future');
    // A pin routes to it outright, even with no key set (it bypasses
    // availability like any pin; the run would then fail with a key hint).
    expect(routeModel(agents.executor.capabilities, 'anthropic-opus-9').id).toBe(
      'anthropic-opus-9'
    );
    expect(resolveModel(agents.executor.capabilities, 'anthropic-opus-9').modelId).toBe(
      'claude-opus-9-future'
    );
  });

  it('includes a custom model in its provider-pin pool', () => {
    __setConfig('myDevTeam.customModels', [newOpus]);
    // The new model out-scores the shipped Anthropic models on coding, so a
    // provider pin for the coding-heavy executor lands on it.
    expect(routeModel(agents.executor.capabilities, 'provider:anthropic').id).toBe(
      'anthropic-opus-9'
    );
  });

  it('is add-only: an entry colliding with a built-in id is ignored', () => {
    __setConfig('myDevTeam.customModels', [
      { ...newOpus, id: 'anthropic-opus', model: 'hijacked' },
    ]);
    // The built-in keeps its model name; the colliding custom entry is dropped.
    expect(modelById('anthropic-opus')?.model).toBe('claude-opus-5');
  });

  it('drops an invalid entry but keeps the valid ones', () => {
    __setConfig('myDevTeam.customModels', [
      { id: 'bad', label: 'Bad', provider: 'mistral', model: 'x' }, // unknown provider
      { id: 'missing-model', label: 'No model', provider: 'anthropic' }, // missing field
      newOpus,
    ]);
    expect(modelById('bad')).toBeUndefined();
    expect(modelById('missing-model')).toBeUndefined();
    expect(modelById('anthropic-opus-9')).toBeDefined();
  });

  it('defaults tier and capabilities when omitted', () => {
    __setConfig('myDevTeam.customModels', [
      { id: 'minimal', label: 'Minimal', provider: 'ollama', model: 'minimal:1b' },
    ]);
    const info = modelById('minimal')!;
    expect(info.tier).toBe('moderate');
    // A neutral profile across the whole capability vocabulary.
    expect(Object.values(info.capabilities).every((s) => s === 0.5)).toBe(true);
  });

  it('falls back to no custom models when the setting is unset', () => {
    expect(modelById('anthropic-opus-9')).toBeUndefined();
  });
});

describe('resolved provider endpoints', () => {
  it('falls back to the built-in localhost when neither user nor deployment set one', () => {
    // The shipped backend.json sets no default and the user has set nothing, so
    // the resolved Ollama endpoint is the built-in localhost default.
    expect(settings.ollamaEndpoint).toBeUndefined();
    expect(ollamaEndpoint()).toBe(defaults.ollamaEndpoint);
  });

  it('lets the user Ollama endpoint setting win (over the deployment default)', () => {
    // The user's setting wins; with the shipped (empty) backend default this is
    // the value used. The user-wins-over-a-set-default precedence is the `??`
    // order in ollamaEndpoint(); the backend default parsing is covered by the
    // schema tests.
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    expect(ollamaEndpoint()).toBe('http://gpu-box:11434');
  });

  it('resolves a second keyless provider from its own setting, not Ollama', () => {
    // The llama.cpp provider is keyless like Ollama but must resolve its *own*
    // endpoint - the old "every keyless provider is Ollama" assumption would have
    // handed it the Ollama URL. Unset falls to the built-in llama.cpp default;
    // its own setting wins and does not affect Ollama's resolution.
    const llamacpp = providerDescriptor('llamacpp');
    expect(settings.providerBaseUrl(llamacpp.baseUrlSetting)).toBeUndefined();
    __setConfig('myDevTeam.llamacpp.endpoint', 'http://localhost:9999');
    expect(settings.providerBaseUrl(llamacpp.baseUrlSetting)).toBe('http://localhost:9999');
    // Ollama's resolution is untouched by the llama.cpp setting.
    expect(ollamaEndpoint()).toBe(defaults.ollamaEndpoint);
  });

  it('wires the llama.cpp model at its resolved endpoint with the /v1 suffix', () => {
    // Built-in default origin, the OpenAI-compatible /v1 path appended in build.
    const model = resolveModel(agents.triage.capabilities, 'llamacpp-local');
    expect(model.modelId).toBe('ggml-org/Qwen2.5-Coder-1.5B-Instruct-Q8_0-GGUF');
    // A fresh instance is wired when the endpoint setting changes (like Ollama).
    const before = resolveModel(agents.triage.capabilities, 'llamacpp-local');
    __setConfig('myDevTeam.llamacpp.endpoint', `${limits.defaultLlamacppEndpoint}0`);
    const after = resolveModel(agents.triage.capabilities, 'llamacpp-local');
    expect(after).not.toBe(before);
  });

  it('reads a cloud provider base URL from its descriptor setting key', () => {
    // The generic settings accessor the provider wiring uses (per descriptor
    // baseUrlSetting); unset is undefined (defer to the deployment default), set
    // returns the normalised URL and wins over the default.
    expect(settings.providerBaseUrl('openai.baseUrl')).toBeUndefined();
    __setConfig('myDevTeam.openai.baseUrl', 'https://gateway.example.com/');
    expect(settings.providerBaseUrl('openai.baseUrl')).toBe('https://gateway.example.com');
  });
});

describe('triageOnly models', () => {
  it('keeps a triageOnly model available but out of the work pool', () => {
    // The local llama.cpp model is triage-only: available (and a triage
    // candidate) but excluded from the work agents' default pool.
    expect(modelById('llamacpp-local')!.triageOnly).toBe(true);
    expect(availableModels().some((m) => m.id === 'llamacpp-local')).toBe(true);
    expect(workModels().some((m) => m.id === 'llamacpp-local')).toBe(false);
  });

  it('defaults triageOnly to false for an ordinary model', () => {
    expect(modelById('qwen3-8b')!.triageOnly).toBe(false);
    expect(workModels().some((m) => m.id === 'qwen3-8b')).toBe(true);
  });

  it('never auto-routes a work agent to a triageOnly model', () => {
    // routeModel's default candidate pool is workModels(), so Auto cannot pick
    // the triage-only model for the executor however the scores fall.
    expect(routeModel(agents.executor.capabilities).triageOnly).toBe(false);
  });

  it('an explicit pin overrides triageOnly (model id and provider pin)', () => {
    expect(routeModel(agents.executor.capabilities, 'llamacpp-local').id).toBe('llamacpp-local');
    expect(routeModel(agents.executor.capabilities, 'provider:llamacpp').id).toBe('llamacpp-local');
  });
});

describe('manual-only models', () => {
  it('keeps a manual-only model pinnable but out of Auto and provider routing', () => {
    const fable = modelById('anthropic-fable')!;
    expect(fable.autoRoute).toBe(false);
    expect(workModels().some((m) => m.id === fable.id)).toBe(false);
    expect(selectModel(agents.executor.capabilities, fable.id).id).toBe(fable.id);
    expect(selectModel(agents.executor.capabilities, 'provider:anthropic').id).not.toBe(
      fable.id
    );
  });

  it('defaults autoRoute to true for ordinary models', () => {
    expect(modelById('qwen3-8b')!.autoRoute).toBe(true);
  });
});

describe('tierPool', () => {
  const byTier = (tier: string) => modelRegistry().filter((m) => m.tier === tier);

  it('keeps only the matching tier when the pool has it', () => {
    const picked = tierPool(modelRegistry(), 'simple');
    expect(picked.length).toBe(byTier('simple').length);
    expect(picked.every((m) => m.tier === 'simple')).toBe(true);
  });

  it('falls back to the nearest available tier when the exact one is absent', () => {
    // A pool of only moderate + complex models, asked for simple, narrows to the
    // nearest available (moderate), not the strongest (complex).
    const pool = [modelById('qwen3-14b')!, modelById('qwen3-coder')!];
    const picked = tierPool(pool, 'simple');
    expect(picked.every((m) => m.tier === 'moderate')).toBe(true);
  });

  it('breaks a distance tie toward the cheaper tier', () => {
    // simple (distance 1) and complex (distance 1) are equidistant from a
    // moderate request; the cheaper tier wins.
    const pool = [modelById('qwen3-8b')!, modelById('qwen3-coder')!];
    const picked = tierPool(pool, 'moderate');
    expect(picked.every((m) => m.tier === 'simple')).toBe(true);
  });
});

describe('selectModel with complexity', () => {
  it('sizes the model to the request tier for one capability profile', () => {
    const simple = selectModel(agents.executor.capabilities, undefined, localModels(), 'simple');
    const moderate = selectModel(agents.executor.capabilities, undefined, localModels(), 'moderate');
    const complex = selectModel(agents.executor.capabilities, undefined, localModels(), 'complex');
    expect(simple.tier).toBe('simple');
    expect(moderate.tier).toBe('moderate');
    // The coding-heavy executor profile picks the local coder at the top tier.
    expect(complex.id).toBe('qwen3-coder');
  });

  it('narrows a provider pin to the request tier', () => {
    const simple = selectModel(agents.executor.capabilities, 'provider:anthropic', undefined, 'simple');
    const complex = selectModel(agents.executor.capabilities, 'provider:anthropic', undefined, 'complex');
    expect(simple.id).toBe('anthropic-haiku');
    expect(complex.id).toBe('anthropic-opus');
  });

  it('a model pin bypasses the tier filter', () => {
    const pinned = selectModel(
      agents.executor.capabilities,
      'anthropic-opus',
      localModels(),
      'simple'
    );
    expect(pinned.id).toBe('anthropic-opus');
  });
});

describe('routeModel complexity gate', () => {
  it('applies the request tier when complexityRouting is on (the default)', () => {
    const picked = routeModel(agents.executor.capabilities, undefined, localModels(), 'simple');
    expect(picked.tier).toBe('simple');
  });

  it('ignores complexity when complexityRouting is off', () => {
    __setConfig('myDevTeam.complexityRouting', false);
    const picked = routeModel(agents.executor.capabilities, undefined, localModels(), 'simple');
    // Capability routing alone picks the coder, regardless of the simple tier.
    expect(picked.id).toBe('qwen3-coder');
  });
});

describe('availability', () => {
  it('treats every keyless (local) model as available and a cloud model only when keyed', () => {
    for (const info of modelRegistry()) {
      expect(isModelAvailable(info)).toBe(
        providerDescriptor(info.provider).keyless ? true : credentials.has(info.provider)
      );
    }
  });

  it('localModels is exactly the Ollama-provider subset of the registry', () => {
    expect(localModels().every((m) => m.provider === 'ollama')).toBe(true);
    expect(localModels()).toHaveLength(
      modelRegistry().filter((m) => m.provider === 'ollama').length
    );
  });

  it('availableModels never includes a cloud model without its key', () => {
    for (const info of availableModels()) {
      if (!providerDescriptor(info.provider).keyless) {
        expect(credentials.has(info.provider)).toBe(true);
      }
    }
  });
});

describe('resolveModel', () => {
  it('memoises the instance per registered model', () => {
    const first = resolveModel(agents.triage.capabilities, undefined, localModels());
    const second = resolveModel(agents.triage.capabilities, undefined, localModels());
    expect(second).toBe(first);
  });

  it('wires the instance for the model the route picked', () => {
    for (const requirements of [agents.triage.capabilities, agents.planner.capabilities]) {
      const info = routeModel(requirements, undefined, localModels());
      // The AI SDK model exposes the provider-specific model id.
      expect(resolveModel(requirements, undefined, localModels()).modelId).toBe(info.model);
    }
  });

  it('wires the pinned model when one is given', () => {
    expect(resolveModel(agents.triage.capabilities, 'anthropic-opus').modelId).toBe(
      'claude-opus-5'
    );
  });

  it('rewires the instance when the endpoint setting changes', () => {
    const before = resolveModel(agents.triage.capabilities, undefined, localModels());
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    const after = resolveModel(agents.triage.capabilities, undefined, localModels());
    // Same routed model, but a fresh instance wired to the new endpoint - a
    // memoised model must never outlive an endpoint change.
    expect(after).not.toBe(before);
    expect(after.modelId).toBe(before.modelId);
  });

  it('keeps memoising under the new endpoint after a change', () => {
    resolveModel(agents.triage.capabilities, undefined, localModels());
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    const first = resolveModel(agents.triage.capabilities, undefined, localModels());
    const second = resolveModel(agents.triage.capabilities, undefined, localModels());
    expect(second).toBe(first);
  });
});
