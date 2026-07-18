import { describe, it, expect } from 'vitest';
import {
  providerDescriptors,
  providerDescriptor,
  providerIds,
  providerLabels,
  cloudProviderDescriptors,
} from '../src/config/providers';

describe('provider registry', () => {
  it('exposes a non-empty set of descriptors with the required fields', () => {
    expect(providerDescriptors.length).toBeGreaterThan(0);
    for (const d of providerDescriptors) {
      expect(d.id).toBeTruthy();
      expect(d.label).toBeTruthy();
      expect(d.baseUrlSetting).toMatch(/\./); // "<provider>.endpoint" / "<provider>.baseUrl"
      expect(typeof d.build).toBe('function');
    }
  });

  it('derives the id tuple, labels, and lookup from the one registry', () => {
    expect(providerIds).toEqual(providerDescriptors.map((d) => d.id));
    for (const d of providerDescriptors) {
      expect(providerLabels[d.id]).toBe(d.label);
      expect(providerDescriptor(d.id)).toBe(d);
    }
  });

  it('keeps provider ids unique', () => {
    expect(new Set(providerIds).size).toBe(providerIds.length);
  });

  it('a keyless provider carries no key names; a cloud one carries env + secret keys', () => {
    for (const d of providerDescriptors) {
      if (d.keyless) {
        expect(d.envKey).toBeUndefined();
        expect(d.secretKey).toBeUndefined();
      } else {
        expect(d.envKey).toBeTruthy();
        expect(d.secretKey).toBeTruthy();
      }
    }
  });

  it('cloudProviderDescriptors is exactly the non-keyless subset', () => {
    expect(cloudProviderDescriptors).toEqual(providerDescriptors.filter((d) => !d.keyless));
    expect(cloudProviderDescriptors.every((d) => !d.keyless)).toBe(true);
  });

  it('build wires a model at the configured base URL / key', () => {
    // Ollama: keyless, the resolved endpoint gets the /api suffix.
    const ollama = providerDescriptor('ollama').build({ baseUrl: 'http://host:11434' });
    expect(ollama('llama3').modelId).toBe('llama3');

    // llama.cpp: keyless and OpenAI-compatible; the model id passes through (the
    // /v1 suffix is added to the base URL inside build, not the model id).
    const llamacpp = providerDescriptor('llamacpp').build({ baseUrl: 'http://host:8011' });
    expect(llamacpp('local').modelId).toBe('local');

    // A cloud provider: the model id passes through to the SDK instance.
    const openai = providerDescriptor('openai').build({ apiKey: 'k' });
    expect(openai('gpt-4.1').modelId).toBe('gpt-4.1');

    // DeepSeek: another cloud provider, model id passes through.
    const deepseek = providerDescriptor('deepseek').build({ apiKey: 'k' });
    expect(deepseek('deepseek-v4-flash').modelId).toBe('deepseek-v4-flash');

    // Z.AI: an OpenAI-compatible cloud provider, model id passes through (the
    // Z.AI default endpoint is applied inside build, not the model id).
    const zai = providerDescriptor('zai').build({ apiKey: 'k' });
    expect(zai('glm-5.2').modelId).toBe('glm-5.2');
  });

  it('builds Z.AI on the Chat Completions transport (its endpoint has no Responses API)', () => {
    // Z.AI reuses the OpenAI SDK but, like llama.cpp, must use `openai.chat`
    // (provider id "openai.chat") rather than the SDK's default Responses
    // transport, since the Z.AI endpoint only implements /chat/completions.
    const zai = providerDescriptor('zai').build({ apiKey: 'k' });
    expect(zai('glm-5.2').provider).toBe('openai.chat');
  });

  it('builds llama.cpp on the Chat Completions transport, not the Responses API', () => {
    // The fix that makes structured output work against llama-server: it only
    // grammar-enforces a JSON schema on /v1/chat/completions, so the provider
    // must use `openai.chat` (provider id "openai.chat"), not the SDK's default
    // Responses transport ("openai.responses") that the cloud OpenAI provider
    // keeps. Without this, a small local model returns free-form, wrong-keyed
    // JSON and triage/planner structured-output validation fails.
    const llamacpp = providerDescriptor('llamacpp').build({ baseUrl: 'http://host:8011' });
    const openai = providerDescriptor('openai').build({ apiKey: 'k' });
    expect(llamacpp('local').provider).toBe('openai.chat');
    expect(openai('gpt-4.1').provider).toBe('openai.responses');
  });
});
