/**
 * Cloud-provider API keys, behind an injectable source so the engine can read
 * them in any process. The default source reads **environment variables only**
 * (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `DEEPSEEK_API_KEY`),
 * which is what the sidecar child uses - it has no `vscode`, and it inherits the parent's
 * environment, so nothing secret crosses the protocol.
 *
 * The in-process local engine runs in the extension host, which *does* have
 * `vscode`, so it injects a richer source (`setSecretSource`) that also reads
 * the editor's SecretStorage - see client/secrets.ts. That keeps the convenient
 * in-editor "Set API Key" flow for the local engine while the sidecar and a
 * future remote backend stay env-only. This module imports no `vscode`, which is
 * what lets it ship in the sidecar bundle.
 *
 * Which providers take a key, and the env-var name per provider, derive from the
 * single provider registry (config/providers.ts): a cloud provider is any
 * descriptor that is not keyless.
 */
import {
  cloudProviderDescriptors,
  ProviderDescriptor,
  ProviderName,
} from './providers';

/** The cloud providers that take an API key (Ollama is keyless and local). */
export type CloudProvider = ProviderName;

const cloudById = new Map<ProviderName, ProviderDescriptor>(
  cloudProviderDescriptors.map((d) => [d.id, d])
);

/** Read a provider's key from its environment variable. The default source, and
 * the sidecar's only source. `vscode`-free. */
export function apiKeyFromEnv(provider: ProviderName): string | undefined {
  const descriptor = cloudById.get(provider);
  if (!descriptor?.envKey) {
    return undefined;
  }
  return process.env[descriptor.envKey]?.trim() || undefined;
}

/**
 * A source of cloud-provider API keys. The default reads env vars; the host
 * injects a SecretStorage-backed one (env as fallback) for the local engine.
 */
export interface SecretSource {
  apiKey(provider: ProviderName): string | undefined;
}

const envSource: SecretSource = { apiKey: apiKeyFromEnv };
let source: SecretSource = envSource;

/**
 * Inject the secret source. The host calls this with a SecretStorage-backed
 * source so the local engine can use in-editor keys; the sidecar child never
 * calls it, so it keeps the env-only default.
 */
export function setSecretSource(next: SecretSource): void {
  source = next;
}

/** Restore the env-only default source (used by tests). */
export function resetSecretSource(): void {
  source = envSource;
}

export const credentials = {
  /** The configured API key for a cloud provider, from the active source. */
  apiKey(provider: ProviderName): string | undefined {
    return source.apiKey(provider);
  },
  /** Whether a usable key exists for the given provider (always false for a keyless one). */
  has(provider: ProviderName): boolean {
    return source.apiKey(provider) !== undefined;
  },
};
