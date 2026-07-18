import { describe, it, expect } from 'vitest';
import { BackendConfigSchema, backendConfig } from '../src/engine/config/backend';

describe('BackendConfigSchema', () => {
  it('defaults an empty file to empty disable lists', () => {
    const parsed = BackendConfigSchema.parse({});
    expect(parsed.models.disabledProviders).toEqual([]);
    expect(parsed.models.disabledModels).toEqual([]);
  });

  it('defaults a partial models section', () => {
    const parsed = BackendConfigSchema.parse({ models: { disabledProviders: ['anthropic'] } });
    expect(parsed.models.disabledProviders).toEqual(['anthropic']);
    expect(parsed.models.disabledModels).toEqual([]);
  });

  it('ignores unknown top-level sections, so future keys are forward-compatible', () => {
    const parsed = BackendConfigSchema.parse({ tools: { foo: true } } as unknown);
    expect(parsed.models.disabledProviders).toEqual([]);
  });

  it('rejects a non-string entry', () => {
    expect(() =>
      BackendConfigSchema.parse({ models: { disabledModels: [42] } })
    ).toThrow();
  });
});

describe('BackendConfigSchema providers (endpoint overrides)', () => {
  it('defaults every provider endpoint override to undefined', () => {
    const parsed = BackendConfigSchema.parse({});
    expect(parsed.providers.ollama.endpoint).toBeUndefined();
    expect(parsed.providers.openai.baseUrl).toBeUndefined();
    expect(parsed.providers.anthropic.baseUrl).toBeUndefined();
    expect(parsed.providers.groq.baseUrl).toBeUndefined();
    expect(parsed.providers.deepseek.baseUrl).toBeUndefined();
    expect(parsed.providers.zai.baseUrl).toBeUndefined();
  });

  it('treats a blank override as no override', () => {
    const parsed = BackendConfigSchema.parse({ providers: { ollama: { endpoint: '   ' } } });
    expect(parsed.providers.ollama.endpoint).toBeUndefined();
  });

  it('keeps a valid override and trims a trailing slash', () => {
    const parsed = BackendConfigSchema.parse({
      providers: {
        ollama: { endpoint: 'http://gpu-box:11434/' },
        anthropic: { baseUrl: 'https://gateway.internal/anthropic' },
      },
    });
    expect(parsed.providers.ollama.endpoint).toBe('http://gpu-box:11434');
    expect(parsed.providers.anthropic.baseUrl).toBe('https://gateway.internal/anthropic');
  });

  it('rejects a non-http(s) override', () => {
    expect(() =>
      BackendConfigSchema.parse({ providers: { openai: { baseUrl: 'ftp://nope' } } })
    ).toThrow();
  });
});

describe('BackendConfigSchema providers (requestsPerMinute floor)', () => {
  it('defaults every provider rate to 0 (no throttle)', () => {
    const parsed = BackendConfigSchema.parse({});
    expect(parsed.providers.ollama.requestsPerMinute).toBe(0);
    expect(parsed.providers.openai.requestsPerMinute).toBe(0);
    expect(parsed.providers.anthropic.requestsPerMinute).toBe(0);
    expect(parsed.providers.groq.requestsPerMinute).toBe(0);
    expect(parsed.providers.deepseek.requestsPerMinute).toBe(0);
  });

  it('keeps a per-provider rate, leaving the others at 0', () => {
    const parsed = BackendConfigSchema.parse({ providers: { groq: { requestsPerMinute: 30 } } });
    expect(parsed.providers.groq.requestsPerMinute).toBe(30);
    expect(parsed.providers.openai.requestsPerMinute).toBe(0);
  });

  it('rejects a negative or non-integer rate', () => {
    expect(() =>
      BackendConfigSchema.parse({ providers: { groq: { requestsPerMinute: -1 } } })
    ).toThrow();
    expect(() =>
      BackendConfigSchema.parse({ providers: { groq: { requestsPerMinute: 2.5 } } })
    ).toThrow();
  });
});

describe('BackendConfigSchema agents.triage', () => {
  it('defaults the triage model to the "ollama" provider', () => {
    expect(BackendConfigSchema.parse({}).agents.triage.model).toBe('ollama');
  });

  it('treats a blank triage model as the default', () => {
    const parsed = BackendConfigSchema.parse({ agents: { triage: { model: '  ' } } });
    expect(parsed.agents.triage.model).toBe('ollama');
  });

  it('keeps a model id or provider name verbatim (trimmed)', () => {
    expect(
      BackendConfigSchema.parse({ agents: { triage: { model: ' anthropic-opus ' } } }).agents
        .triage.model
    ).toBe('anthropic-opus');
    expect(
      BackendConfigSchema.parse({ agents: { triage: { model: 'anthropic' } } }).agents.triage.model
    ).toBe('anthropic');
  });
});

describe('the bundled backendConfig', () => {
  it('parses with the expected shape', () => {
    expect(Array.isArray(backendConfig.models.disabledProviders)).toBe(true);
    expect(Array.isArray(backendConfig.models.disabledModels)).toBe(true);
    // The shipped file sets no overrides, so each provider falls back to settings.
    expect(backendConfig.providers.ollama.endpoint).toBeUndefined();
    expect(backendConfig.providers.openai.baseUrl).toBeUndefined();
    // The shipped file throttles no provider (0 = off), so behaviour is unchanged
    // until an operator sets a rate.
    expect(backendConfig.providers.groq.requestsPerMinute).toBe(0);
    // Triage carries a non-empty routing string (a provider name or model id);
    // the exact value is a deployment choice, not asserted here. The schema
    // default when the field is omitted is covered above ("ollama").
    expect(typeof backendConfig.agents.triage.model).toBe('string');
    expect(backendConfig.agents.triage.model.length).toBeGreaterThan(0);
  });
});
