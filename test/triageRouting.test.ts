import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the bundled backend config so we can drive agents.triage.model per test.
// The object is created in a hoisted block (vi.mock factories run before the
// module imports), and mutated in beforeEach / each test.
const { fakeBackend } = vi.hoisted(() => ({
  fakeBackend: {
    models: { disabledProviders: [] as string[], disabledModels: [] as string[] },
    providers: { ollama: {}, llamacpp: {}, openai: {}, anthropic: {}, groq: {} },
    agents: { triage: { model: 'ollama' } },
  },
}));
vi.mock('../src/engine/config/backend', () => ({ backendConfig: fakeBackend }));

import { triageRouting, routeTriageModel } from '../src/engine/core/models';
import { agents } from '../src/engine/config/agents';
import { __reset, __setConfig } from './mocks/vscode';

beforeEach(() => {
  __reset();
  fakeBackend.models.disabledProviders = [];
  fakeBackend.models.disabledModels = [];
  fakeBackend.agents.triage.model = 'ollama';
});

describe('triageRouting', () => {
  it('defaults to the "ollama" provider: no pin, local candidates', () => {
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((m) => m.provider === 'ollama')).toBe(true);
    // Routed by the triage capability profile, the pick is a local model.
    expect(routeTriageModel(agents.triage.capabilities).provider).toBe('ollama');
  });

  it('pins an exact registered model id', () => {
    fakeBackend.agents.triage.model = 'anthropic-opus';
    const { pin } = triageRouting();
    expect(pin).toBe('anthropic-opus');
    // A pin wins outright, regardless of the triage capability weights.
    expect(routeTriageModel(agents.triage.capabilities).id).toBe('anthropic-opus');
  });

  it('routes by capability within a named provider', () => {
    fakeBackend.agents.triage.model = 'anthropic';
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(routeTriageModel(agents.triage.capabilities).provider).toBe('anthropic');
  });

  it('falls back to local models for an unknown choice', () => {
    fakeBackend.agents.triage.model = 'not-a-real-thing';
    expect(triageRouting().candidates.every((m) => m.provider === 'ollama')).toBe(true);
  });

  it('falls back to local models when the named provider has nothing enabled', () => {
    fakeBackend.agents.triage.model = 'anthropic';
    fakeBackend.models.disabledProviders = ['anthropic'];
    expect(triageRouting().candidates.every((m) => m.provider === 'ollama')).toBe(true);
  });

  it('lets the user setting override the backend default', () => {
    // Backend says ollama, but the user picks a provider pin.
    __setConfig('myDevTeam.triage.model', 'provider:anthropic');
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('accepts a bare provider name in the user setting', () => {
    __setConfig('myDevTeam.triage.model', 'anthropic');
    expect(triageRouting().candidates.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('routes triage to a local llama.cpp model with no key or Ollama', () => {
    // The whole point of the llama.cpp provider: a keyless local triage model the
    // user selects without an Ollama server or any cloud key.
    __setConfig('myDevTeam.triage.model', 'provider:llamacpp');
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((m) => m.provider === 'llamacpp')).toBe(true);
    expect(routeTriageModel(agents.triage.capabilities).provider).toBe('llamacpp');
  });

  it('routes among all available models when the user picks "auto"', () => {
    __setConfig('myDevTeam.triage.model', 'auto');
    const { pin, candidates } = triageRouting();
    // No pin, and the candidate pool is the available models (always at least
    // the keyless local ones), not narrowed to a single provider.
    expect(pin).toBeUndefined();
    expect(candidates.some((m) => m.provider === 'ollama')).toBe(true);
  });

  it('pins an exact model id from the user setting', () => {
    __setConfig('myDevTeam.triage.model', 'anthropic-opus');
    expect(triageRouting().pin).toBe('anthropic-opus');
  });

  it('falls back to the backend default when the user setting is empty', () => {
    fakeBackend.agents.triage.model = 'anthropic';
    __setConfig('myDevTeam.triage.model', '');
    expect(triageRouting().candidates.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('cascades to the work model when triage.model is unset', () => {
    // The user picked a cloud provider for the work agents and set no triage
    // model: triage follows the work model rather than the local backend floor,
    // so a box with no Ollama server still routes triage successfully.
    __setConfig('myDevTeam.model', 'provider:anthropic');
    const { pin, candidates } = triageRouting();
    expect(pin).toBeUndefined();
    expect(candidates.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(routeTriageModel(agents.triage.capabilities).provider).toBe('anthropic');
  });

  it('cascades a concrete work model id to triage when triage.model is unset', () => {
    __setConfig('myDevTeam.model', 'anthropic-opus');
    expect(triageRouting().pin).toBe('anthropic-opus');
  });

  it('keeps the backend floor when the work model is "auto"', () => {
    // The default work model is "auto", which names no provider, so triage stays
    // on the cheap local backend floor rather than cascading.
    __setConfig('myDevTeam.model', 'auto');
    expect(triageRouting().candidates.every((m) => m.provider === 'ollama')).toBe(true);
  });

  it('lets an explicit triage.model win over the work model', () => {
    __setConfig('myDevTeam.model', 'provider:anthropic');
    __setConfig('myDevTeam.triage.model', 'provider:llamacpp');
    expect(triageRouting().candidates.every((m) => m.provider === 'llamacpp')).toBe(true);
  });

  it('cannot select a user provider the build disabled', () => {
    fakeBackend.models.disabledProviders = ['anthropic'];
    __setConfig('myDevTeam.triage.model', 'provider:anthropic');
    // Disabled at the backend floor: the pool is empty, so it falls back local.
    expect(triageRouting().candidates.every((m) => m.provider === 'ollama')).toBe(true);
  });
});
