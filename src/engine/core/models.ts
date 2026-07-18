/**
 * Provider wiring for the capability-based model router. The pure *scoring* -
 * which registered model best fits a set of capability weights - lives in
 * config/models.ts; this file adds the parts that need the runtime: which
 * models are actually usable (an Ollama model is assumed pulled; a cloud model
 * needs its API key), and turning the winning registry entry into an AI SDK
 * model instance for the configured endpoint/key.
 *
 * The providers themselves - their ids, labels, key requirements, and how to
 * build each one's AI SDK factory - live in the single provider registry
 * (config/providers.ts). This file only adds the runtime resolution: it reads
 * each provider's resolved config and feeds it to the descriptor's `build`.
 * Each endpoint/base URL is *resolved* as "backend override
 * (config/backend.json) else user setting", so an operator can pin every
 * provider at a fixed gateway while the user setting fills in otherwise. Each
 * provider is built lazily and rebuilt when its configuration (resolved
 * endpoint, key, or base URL) changes, dropping the memoised model instances so
 * the next request talks to the new configuration without a reload.
 */
import { wrapLanguageModel } from 'ai';
import { rateLimitMiddleware } from './rateLimiter';
import { providerDebugMiddleware } from './providerLog';
import {
  AUTO_MODEL,
  CapabilityScores,
  ModelInfo,
  modelById,
  modelRegistry,
  PROVIDER_PIN_PREFIX,
  ProviderName,
  providerPinOf,
  selectModel,
} from '../config/models';
import {
  providerDescriptor,
  providerDescriptors,
  providerIds,
  ProviderConfig,
  ProviderDescriptor,
  RoutedModel,
} from '../../config/providers';
import { Complexity } from '../../protocol/types';
import { runtimeConfig } from '../../config/runtimeConfig';
import { limits } from '../../config/limits';
import { credentials } from '../../config/credentials';
import { backendConfig } from '../config/backend';

/** The AI SDK model type all providers produce (re-exported from the registry). */
export type { RoutedModel } from '../../config/providers';

/**
 * A provider's endpoint default from the backend config: Ollama's `endpoint` or
 * a cloud provider's `baseUrl`, both stored under the provider's id in
 * `config/backend.json`. Undefined means "the deployment set no default - use
 * the built-in one". This is the deployment's *default*, not an enforced floor:
 * the user's own setting wins over it (see `ollamaEndpoint` /
 * `resolveProviderConfig`), so an operator pins a sensible default a user can
 * still override.
 */
function backendEndpointDefault(id: ProviderName): string | undefined {
  const entry = backendConfig.providers[id] as { endpoint?: string; baseUrl?: string };
  return entry.endpoint ?? entry.baseUrl;
}

/**
 * Built-in fallback origin per keyless (local) provider, used when neither the
 * user's base-URL setting nor the deployment default (config/backend.json) names
 * one. The keyless analogue of a cloud provider's SDK-default endpoint.
 */
const keylessDefaultEndpoint: Record<string, string> = {
  ollama: limits.defaultOllamaEndpoint,
  llamacpp: limits.defaultLlamacppEndpoint,
};

/**
 * The server origin actually used for a keyless (local) provider: the user's
 * base-URL setting (`myDevTeam.<provider>.endpoint`) wins, else the deployment
 * default (config/backend.json), else the provider's built-in localhost. Each
 * keyless provider resolves its *own* endpoint, so a second one (llama.cpp) does
 * not inherit Ollama's - the assumption "keyless means Ollama" stays out of the
 * wiring.
 */
function keylessEndpoint(descriptor: ProviderDescriptor): string {
  return (
    runtimeConfig().providerBaseUrls[descriptor.baseUrlSetting] ??
    backendEndpointDefault(descriptor.id) ??
    keylessDefaultEndpoint[descriptor.id]
  );
}

/**
 * The Ollama server origin actually used: the user's `myDevTeam.ollama.endpoint`
 * when set, else the deployment default (config/backend.json), else the built-in
 * localhost. The single source the provider wiring, the startup probe, and the
 * error hints all read, so they can never disagree. The user wins over the
 * deployment default - a request endpoint is the user's to point wherever they
 * run Ollama. A thin wrapper over the generic keyless resolver above.
 */
export function ollamaEndpoint(): string {
  return keylessEndpoint(providerDescriptor('ollama'));
}

/**
 * The llama.cpp (`llama-server`) origin actually used, resolved the same way as
 * the Ollama one (user setting, deployment default, built-in localhost). The
 * server-origin only (no `/v1` suffix); the provider build adds `/v1`. Read by
 * the failure hint so it names the endpoint the wiring actually uses.
 */
export function llamacppEndpoint(): string {
  return keylessEndpoint(providerDescriptor('llamacpp'));
}

/**
 * A provider's resolved runtime config, fed to its descriptor's `build`: the
 * API key (keyless providers get none) and the resolved base URL. The user's
 * setting wins, then the deployment default; for a keyless local provider the
 * base URL is its server origin, which always resolves to at least the built-in
 * localhost; for a cloud provider it may be undefined (use the SDK's own
 * endpoint).
 */
function resolveProviderConfig(descriptor: ProviderDescriptor): ProviderConfig {
  if (descriptor.keyless) {
    return { baseUrl: keylessEndpoint(descriptor) };
  }
  return {
    apiKey: credentials.apiKey(descriptor.id),
    baseUrl:
      runtimeConfig().providerBaseUrls[descriptor.baseUrlSetting] ??
      backendEndpointDefault(descriptor.id),
  };
}

/** The config signature a provider was built from: a key or base-URL change rebuilds it. */
function providerSignature(config: ProviderConfig): string {
  return `${config.apiKey ?? ''}::${config.baseUrl ?? ''}`;
}

const instances = new Map<string, RoutedModel>();

/**
 * A lazily-built provider plus the configuration signature it was built from.
 * When the signature changes the provider is rebuilt and the memoised model
 * instances are dropped, so a key or endpoint change takes effect next run.
 */
interface ProviderCache {
  instance?: (model: string) => RoutedModel;
  builtFrom?: string;
}

/** One cache slot per registered provider, keyed by id. */
const providerCaches: Record<ProviderName, ProviderCache> = Object.fromEntries(
  providerDescriptors.map((d) => [d.id, {} as ProviderCache])
) as Record<ProviderName, ProviderCache>;

/** The provider factory for `name`, rebuilt when its configuration changed. */
function providerFactory(name: ProviderName): (model: string) => RoutedModel {
  const cache = providerCaches[name];
  const descriptor = providerDescriptor(name);
  const config = resolveProviderConfig(descriptor);
  const signature = providerSignature(config);
  if (!cache.instance || cache.builtFrom !== signature) {
    cache.instance = descriptor.build(config);
    cache.builtFrom = signature;
    instances.clear();
  }
  return cache.instance;
}

/** Whether a registered model can actually run now: a keyless provider's model
 * always (Ollama, assumed pulled), a cloud model only when its API key is set. */
export function isModelAvailable(info: ModelInfo): boolean {
  return providerDescriptor(info.provider).keyless || credentials.has(info.provider);
}

/**
 * Whether a provider is enabled, unioning the two disable layers: the backend
 * floor (the operator's `backend.json`, unbypassable) and the user's
 * `myDevTeam.disabledProviders` setting. A disabled provider's models never run,
 * even when pinned (see `effectivePin`).
 */
export function isProviderEnabled(provider: ProviderName): boolean {
  return (
    !backendConfig.models.disabledProviders.includes(provider) &&
    !runtimeConfig().disabledProviders.includes(provider)
  );
}

/**
 * Whether a registered model is enabled: its provider must be enabled, and the
 * model's own id must not be disabled at either layer (the backend floor or the
 * user's `myDevTeam.disabledModels`). Orthogonal to `isModelAvailable` (whether
 * its API key is set) - a model must be both enabled and available to run.
 */
export function isModelEnabled(info: ModelInfo): boolean {
  return (
    isProviderEnabled(info.provider) &&
    !backendConfig.models.disabledModels.includes(info.id) &&
    !runtimeConfig().disabledModels.includes(info.id)
  );
}

/**
 * The effective context-window size (in tokens) for a model id, used to warn
 * when a run's context is filling up: the user's `myDevTeam.modelContextWindows`
 * override wins (so a local model's real `num_ctx` can be set), then the model's
 * built-in `contextWindow`. Undefined when neither is known, so the caller emits
 * no context warnings rather than guessing.
 */
export function contextWindowFor(id: string | undefined): number | undefined {
  if (id === undefined) {
    return undefined;
  }
  const override = runtimeConfig().modelContextWindows[id];
  if (typeof override === 'number' && override > 0) {
    return override;
  }
  return modelById(id)?.contextWindow;
}

/**
 * Resolve a user's model pin against the disable layers, so a hard-blocked pin
 * never runs. A pin naming a disabled model, or a `provider:<name>` pin naming a
 * disabled provider, is dropped (returns undefined), so the run falls back to
 * Auto among the enabled models rather than honouring the choice. "auto", an
 * unknown id, or no pin passes through unchanged - and an enabled provider pin
 * stays a provider pin (its individually-disabled members are excluded later by
 * the `isModelEnabled` predicate handed to `selectModel`).
 */
export function effectivePin(pin?: string): string | undefined {
  if (pin === undefined) {
    return undefined;
  }
  const pinned = modelById(pin);
  if (pinned) {
    return isModelEnabled(pinned) ? pin : undefined;
  }
  if (pin.startsWith(PROVIDER_PIN_PREFIX)) {
    const provider = providerPinOf(pin);
    // A provider pin naming an unknown provider already degrades to Auto; one
    // naming a disabled provider is hard-blocked the same way.
    return provider && isProviderEnabled(provider) ? pin : undefined;
  }
  return pin;
}

/** The models Auto may route to right now (Ollama plus any keyed cloud models),
 * minus anything disabled at either layer. The triage pool; the work agents use
 * the `workModels()` subset. */
export function availableModels(): ModelInfo[] {
  return modelRegistry().filter((m) => isModelAvailable(m) && isModelEnabled(m));
}

/**
 * The models Auto may route the *work* agents to (planner/answerer/executor/
 * summarizer): the available models minus any tagged `triageOnly` (eligible
 * only for the internal triage classifier). This is `routeModel`'s default
 * candidate pool, so a triage-only model is never handed real work by Auto - but
 * an explicit pin still reaches it, since `selectModel` returns a pin outright.
 */
export function workModels(): ModelInfo[] {
  return availableModels().filter((m) => !m.triageOnly);
}

/** The local Ollama models, minus anything disabled at either layer. The
 * default candidate pool for triage (the "ollama" provider choice). */
export function localModels(): ModelInfo[] {
  return modelRegistry().filter((m) => m.provider === 'ollama' && isModelEnabled(m));
}

/** The provider names the registry knows, in a stable order. */
const providerNames: readonly ProviderName[] = providerIds;

/**
 * What triage routes by when the user set no `myDevTeam.triage.model`: the work
 * model (`myDevTeam.model`) when it names a concrete model or provider, so a
 * user who picks a cloud provider for the work agents gets triage on it too
 * rather than the local default failing for want of an Ollama server; otherwise
 * (the work model is "auto") the build's `backend.json` `agents.triage.model`
 * floor - the cheap local classifier the default deployment ships.
 */
function triageDefault(): string {
  const work = runtimeConfig().workModel;
  return work && work !== AUTO_MODEL ? work : backendConfig.agents.triage.model;
}

/**
 * How the triage agent is routed. The user's `myDevTeam.triage.model` wins when
 * set; otherwise the work model cascades in (see `triageDefault`: the user's
 * `myDevTeam.model` when concrete, else the `backend.json` `agents.triage.model`
 * floor). This mirrors how the work agents' model is chosen - user-controlled,
 * with the backend providing only the default and the unbypassable disable
 * layers (applied via the candidate pools and `routeModel`, so triage can never
 * reach a provider/model the operator disabled).
 *
 * The chosen value is interpreted leniently: "auto" routes among all available
 * models; a registered model id pins that exact model; a provider - written as
 * the `provider:<name>` pin (matching `myDevTeam.model`) or a bare provider name
 * (the backend config's vocabulary) - routes by capability among that provider's
 * enabled models; anything else (an unknown name, or a provider with nothing
 * enabled) falls back to the local models. Returned as the `(pin, candidates)`
 * inputs the normal router takes, so triage reuses the same scoring and disable
 * rules as every other agent.
 */
export function triageRouting(): { pin?: string; candidates: readonly ModelInfo[] } {
  const choice = runtimeConfig().triageModel || triageDefault();
  if (choice === 'auto') {
    return { candidates: availableModels() };
  }
  if (modelById(choice)) {
    return { pin: choice, candidates: availableModels() };
  }
  const provider = choice.startsWith(PROVIDER_PIN_PREFIX)
    ? providerPinOf(choice)
    : (providerNames as readonly string[]).includes(choice)
      ? (choice as ProviderName)
      : undefined;
  if (provider) {
    const pool = modelRegistry().filter((m) => m.provider === provider && isModelEnabled(m));
    if (pool.length > 0) {
      return { candidates: pool };
    }
  }
  return { candidates: localModels() };
}

/** The registry entry triage will use, honouring the backend triage config. */
export function routeTriageModel(requirements: CapabilityScores): ModelInfo {
  const { pin, candidates } = triageRouting();
  return routeModel(requirements, pin, candidates);
}

/** The wired AI SDK instance triage will use, honouring the backend triage config. */
export function resolveTriageModel(requirements: CapabilityScores): RoutedModel {
  const { pin, candidates } = triageRouting();
  return resolveModel(requirements, pin, candidates);
}

/**
 * The registry entry an agent will use: a `pin` naming a registered model wins
 * outright (the user asked for it, even if its key is missing - the run then
 * fails with a helpful hint); otherwise the best weighted fit among
 * `candidates` (defaults to the work models, so Auto never routes to a cloud
 * model whose key is not set, nor to a `triageOnly` model). Triage passes its
 * own candidate pool (which keeps `triageOnly` models), so this default is the
 * work-agent pool only.
 *
 * `complexity` (only the executor passes one) narrows the pool to the request's
 * tier before scoring - but only when `myDevTeam.complexityRouting` is on, the
 * gate read live here so every caller (the executor and the engine's
 * model-selection mirror) honours it identically.
 */
export function routeModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates: readonly ModelInfo[] = workModels(),
  complexity?: Complexity
): ModelInfo {
  const tier = runtimeConfig().complexityRoutingEnabled ? complexity : undefined;
  // A disabled pin is dropped to Auto, and the predicate also drops a disabled
  // member of an (otherwise enabled) pinned provider's pool - so disabling is an
  // unbypassable hard block however the model would have been reached.
  return selectModel(requirements, effectivePin(pin), candidates, tier, isModelEnabled);
}

/**
 * Memoisation key for a wired instance: the registry id plus the provider's
 * current configuration signature, so a memoised model can never outlive a key
 * or endpoint change (a changed signature also clears the cache in
 * providerFactory, so this is belt-and-braces).
 */
function instanceKey(info: ModelInfo): string {
  return `${providerCaches[info.provider].builtFrom ?? ''}::${info.id}`;
}

/**
 * Resolve a capability requirement profile to a ready-to-use AI SDK model
 * instance, honouring an optional pin and candidate restriction (see
 * routeModel).
 */
export function resolveModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates?: readonly ModelInfo[],
  complexity?: Complexity
): RoutedModel {
  const info = routeModel(requirements, pin, candidates, complexity);
  const factory = providerFactory(info.provider);
  const key = instanceKey(info);
  let model = instances.get(key);
  if (!model) {
    // Wrap every wired model in two middlewares (both read their gate live, so
    // the wrapped instance can be memoised even though the behaviour can change
    // between requests): the debug logger (outermost - it traces one logical
    // request/response pair to the debug sink when `myDevTeam.debug` is on, and is
    // a pass-through otherwise), and below it the rate limiter, which throttles to
    // the configured RPM and retries a provider 429 after the suggested delay.
    model = wrapLanguageModel({
      model: factory(info.model),
      middleware: [
        providerDebugMiddleware(info.provider, info.model),
        rateLimitMiddleware(info.provider),
      ],
    }) as RoutedModel;
    instances.set(key, model);
  }
  return model;
}
