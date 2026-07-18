import { describe, it, expect } from 'vitest';
import { setRuntimeConfig, runtimeConfig, RuntimeConfig } from '../src/config/runtimeConfig';
import { resolveRequestsPerMinute } from '../src/engine/core/rateLimiter';

/**
 * The engine reads its user settings through the injected runtime-config seam,
 * not `vscode`. These tests inject a plain snapshot (no editor involved) and
 * assert both the holder and an engine consumer honour it - the property the
 * sidecar relies on, since its child receives exactly such a snapshot.
 */
const base: RuntimeConfig = {
  ollamaEndpoint: undefined,
  providerBaseUrls: {},
  disabledProviders: [],
  disabledModels: [],
  triageModel: '',
  triageMode: 'classifier',
  complexityRoutingEnabled: true,
  requestsPerMinute: undefined,
  toolSnippetLines: 5,
  planApproval: 'auto',
  thinkingShowInChat: true,
  summaryShowInChat: true,
  clarifyEnabled: true,
};

describe('runtimeConfig injection', () => {
  it('returns whatever was last injected', () => {
    setRuntimeConfig({ ...base, triageModel: 'anthropic' });
    expect(runtimeConfig().triageModel).toBe('anthropic');
  });

  it('carries the triage mode (combined vs classifier) through the seam', () => {
    setRuntimeConfig({ ...base, triageMode: 'combined' });
    expect(runtimeConfig().triageMode).toBe('combined');
    setRuntimeConfig({ ...base, triageMode: 'classifier' });
    expect(runtimeConfig().triageMode).toBe('classifier');
  });

  it('carries the clarify-enabled flag through the seam', () => {
    setRuntimeConfig({ ...base, clarifyEnabled: false });
    expect(runtimeConfig().clarifyEnabled).toBe(false);
    setRuntimeConfig({ ...base, clarifyEnabled: true });
    expect(runtimeConfig().clarifyEnabled).toBe(true);
  });

  it('the engine rate limiter reads the injected user override', () => {
    setRuntimeConfig({ ...base, requestsPerMinute: 42 });
    expect(resolveRequestsPerMinute('groq')).toBe(42);
    // Unset defers to the shipped backend per-provider floor (0 = no throttle).
    setRuntimeConfig({ ...base, requestsPerMinute: undefined });
    expect(resolveRequestsPerMinute('groq')).toBe(0);
  });
});
