import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  credentials,
  apiKeyFromEnv,
  setSecretSource,
  resetSecretSource,
} from '../src/config/credentials';

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  resetSecretSource();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  resetSecretSource();
});

describe('credentials (default env-only source)', () => {
  it('reads a cloud key from its environment variable', () => {
    expect(credentials.has('openai')).toBe(false);
    expect(credentials.apiKey('openai')).toBeUndefined();
    process.env.OPENAI_API_KEY = 'env-key';
    expect(credentials.has('openai')).toBe(true);
    expect(credentials.apiKey('openai')).toBe('env-key');
  });

  it('trims surrounding whitespace and treats a blank var as unset', () => {
    process.env.ANTHROPIC_API_KEY = '  sk-trimmed  ';
    expect(apiKeyFromEnv('anthropic')).toBe('sk-trimmed');
    process.env.ANTHROPIC_API_KEY = '   ';
    expect(credentials.has('anthropic')).toBe(false);
  });

  it('reports the local keyless provider as having no key', () => {
    expect(credentials.has('ollama')).toBe(false);
    expect(credentials.apiKey('ollama')).toBeUndefined();
  });
});

describe('credentials (injected secret source)', () => {
  it('reads from the injected source instead of the env default', () => {
    process.env.OPENAI_API_KEY = 'from-env';
    setSecretSource({ apiKey: (p) => (p === 'openai' ? 'from-source' : undefined) });
    expect(credentials.apiKey('openai')).toBe('from-source');
    // A source that returns nothing reports the key as missing.
    expect(credentials.has('groq')).toBe(false);
  });

  it('reverts to the env default after reset', () => {
    setSecretSource({ apiKey: () => 'sticky' });
    expect(credentials.apiKey('openai')).toBe('sticky');
    resetSecretSource();
    expect(credentials.has('openai')).toBe(false);
    process.env.OPENAI_API_KEY = 'env-key';
    expect(credentials.apiKey('openai')).toBe('env-key');
  });
});
