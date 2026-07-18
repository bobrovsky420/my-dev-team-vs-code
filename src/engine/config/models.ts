/**
 * Registered model catalogue and capability-based selection. Each model the
 * router may pick from is described by a `.md` file in ./models: frontmatter
 * carries the structured fields (id, provider, provider-specific model name,
 * and capability scores) and the markdown body is a human-facing note on what
 * the model is good for.
 *
 * Capability scores rate how good a model is at a capability (0–1). Agents
 * declare the same capabilities as *weights* — how much that capability
 * matters to them (see agents.ts) — and `selectModel` picks the registered
 * model with the highest weighted score. Selection is pure configuration
 * logic; turning the winner into an AI SDK instance is provider wiring and
 * lives in core/models.ts.
 *
 * To register a new model, drop a `.md` file into ./models — the glob import
 * below discovers it at build time. Only register models that are actually
 * available (e.g. pulled in Ollama) — selection assumes every registered
 * model can run.
 *
 * Users can register extra models at runtime without republishing the
 * extension, through the injected `myDevTeam.customModels` config (see
 * `runtimeConfig().customModels`): the same structured fields as the
 * frontmatter, validated here against the same schema. Those are *add-only* -
 * they can only name an already-wired provider (a custom model needs no new
 * code because the provider's wiring already takes any model-name string), and
 * an id that collides with a built-in (or an earlier custom entry) is dropped.
 * Hence `modelRegistry()` is a function, not a constant: it re-merges the
 * build-time models with whatever the user has registered now.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { Complexity, ComplexitySchema } from '../../protocol/types';
import {
  providerIds,
  providerLabels as registryProviderLabels,
  type ProviderName,
} from '../../config/providers';
import { runtimeConfig, type CustomModelInput } from '../../config/runtimeConfig';
import modelFiles from 'glob:./models/*.md';

export type { ProviderName } from '../../config/providers';

/**
 * The capability vocabulary models are scored on and agents weight: the
 * unified 8-name set shared with the my-dev-team pipeline through the
 * my-dev-team-config registry (its models.yaml speaks exactly these names).
 */
export const capabilityNames = [
  'reasoning',
  'code-generation',
  'code-analysis',
  'classification',
  'planning',
  'fast-utility',
  'structured-output',
  // How well the model handles a very large input - in practice, how big its
  // context window is. Scored roughly by window size, so an agent that must read
  // a lot at once (the compacter, which summarizes the whole conversation) can
  // weight this high and Auto routes it to a big-window model.
  'long-context',
] as const;

export type Capability = (typeof capabilityNames)[number];

/**
 * Capability → number in [0,1]. On a model it is a score (how good the model
 * is); on an agent it is a weight (how much the agent cares).
 */
export type CapabilityScores = Partial<Record<Capability, number>>;

/**
 * The pre-unification dialect names, still accepted in hand-written config
 * (a user's `myDevTeam.customModels` entries predate the rename) and expanded
 * to their unified equivalents on load. `coding` was the fold of the two code
 * capabilities, so it expands to both; an explicit unified name in the same
 * map wins over the alias expansion.
 */
const CAPABILITY_ALIASES: Record<string, readonly Capability[]> = {
  coding: ['code-generation', 'code-analysis'],
  speed: ['fast-utility'],
};

function normalizeCapabilityNames(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const entries = Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [name, score] of entries) {
    if (!(name in CAPABILITY_ALIASES)) {
      out[name] = score;
    }
  }
  for (const [name, score] of entries) {
    for (const target of CAPABILITY_ALIASES[name] ?? []) {
      if (!(target in out)) {
        out[target] = score;
      }
    }
  }
  return out;
}

export const CapabilityScoresSchema = z.preprocess(
  normalizeCapabilityNames,
  z
    .partialRecord(z.enum(capabilityNames), z.number().min(0).max(1))
    .refine((scores) => Object.keys(scores).length > 0, {
      message: 'At least one capability must be given.',
    })
);

const ModelFrontmatterSchema = z.object({
  /** Stable registry id, also the memoisation key for wired instances. */
  id: z.string(),
  /**
   * User-facing display name shown in the model picker and the "which model
   * ran" line - the one place the protocol exposes a concrete model identity.
   */
  label: z.string(),
  /**
   * Which provider hosts the model. The allowed ids are generated from the
   * provider registry (config/providers.ts), so a model file naming an unknown
   * provider fails at load with a clear message rather than registering a model
   * the wiring cannot build.
   */
  provider: z.enum(providerIds, {
    error: () =>
      `Unknown provider in a model config file. Known providers: ${providerIds.join(', ')}.`,
  }),
  /** Provider-specific model name, e.g. the Ollama tag or the API model id. */
  model: z.string(),
  /**
   * The model's weight class: how demanding a request it is meant for. The
   * executor's candidate pool is narrowed to the request's complexity tier
   * before capability scoring (see `selectModel`), so "simple" work routes to
   * a cheaper model and "complex" work to a stronger one. Orthogonal to the
   * capability scores (what kind of work), which still break ties within a
   * tier. Defaults to "moderate" when a model file omits it.
   */
  tier: ComplexitySchema.default('moderate'),
  /**
   * When true, the model is eligible only for the internal triage classifier,
   * never the Auto work pool (planner/answerer/executor/summarizer) - see
   * `workModels` in core/models.ts. It keeps a tiny local model from being
   * handed real work it cannot do well, while an explicit pin (a model id or a
   * `provider:<name>`) still routes to it, since a pin always wins in
   * `selectModel`. Defaults to false (eligible for every agent).
   */
  triageOnly: z.boolean().default(false),
  /** How good this model is at each capability, 0–1. */
  capabilities: CapabilityScoresSchema,
  /**
   * The model's context window in tokens, used to warn when a run's context is
   * filling up (see `contextWindowFor` in core/models.ts and the executor's
   * context-usage check-in). For a local model this is the theoretical maximum;
   * the effective window is whatever the server was launched with, so a user can
   * correct any model's value with `myDevTeam.modelContextWindows`. Optional: a
   * model that omits it (and has no override) simply gets no context warnings.
   */
  contextWindow: z.number().int().positive().optional(),
});

export interface ModelInfo extends z.infer<typeof ModelFrontmatterSchema> {
  /** Human-facing note on the model's strengths (the markdown body). */
  description: string;
}

function loadModel(raw: string): ModelInfo {
  const { data, body } = parseFrontmatter(raw);
  return { ...ModelFrontmatterSchema.parse(data), description: body.trim() };
}

/**
 * Parse a set of model config files into registry entries, rejecting
 * duplicate ids: the id is the memoisation key for wired instances, so two
 * entries sharing one would silently alias each other.
 */
export function loadModels(files: readonly string[]): ModelInfo[] {
  const models = files.map(loadModel);
  const seen = new Set<string>();
  for (const info of models) {
    if (seen.has(info.id)) {
      throw new Error(`Duplicate model id "${info.id}" in config/models.`);
    }
    seen.add(info.id);
  }
  return models;
}

/** The build-time models, discovered from the `.md` files (filename order). */
const builtinModels: readonly ModelInfo[] = loadModels(modelFiles);

/**
 * A custom model's schema: the same structured fields as a built-in, but with
 * two relaxations for hand-written config. `capabilities` is optional (a user
 * pinning a freshly released model should not have to invent scores - a pin
 * wins outright regardless; the default below only matters if Auto ever
 * considers it), and `description` is an optional inline field since there is
 * no markdown body to carry it.
 */
const CustomModelSchema = ModelFrontmatterSchema.extend({
  capabilities: CapabilityScoresSchema.optional(),
  description: z.string().optional(),
});

/**
 * The capability profile a custom model gets when it declares none: a neutral
 * 0.5 across the vocabulary, so Auto neither favours nor avoids it. An explicit
 * pin ignores scores, so this only affects Auto/provider-pin routing.
 */
const DEFAULT_CUSTOM_CAPABILITIES: CapabilityScores = Object.fromEntries(
  capabilityNames.map((name) => [name, 0.5])
);

/**
 * Validate the user's custom-model entries and turn the valid ones into
 * registry entries, add-only: an entry that fails the schema, names a duplicate
 * id (`taken` seeds the built-in ids, then each accepted custom id is added), is
 * dropped with a warning rather than throwing - one bad entry must not break
 * every run. Returns the accepted entries in input order.
 */
function loadCustomModels(
  raw: readonly CustomModelInput[],
  taken: ReadonlySet<string>
): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set(taken);
  for (const entry of raw) {
    const parsed = CustomModelSchema.safeParse(entry);
    if (!parsed.success) {
      console.warn(
        `Ignoring an invalid custom model: ${parsed.error.issues[0]?.message ?? 'invalid entry'}.`
      );
      continue;
    }
    const data = parsed.data;
    if (seen.has(data.id)) {
      console.warn(
        `Ignoring custom model "${data.id}": that id is already registered (custom models can only add new models, not redefine one).`
      );
      continue;
    }
    seen.add(data.id);
    out.push({
      ...data,
      capabilities: data.capabilities ?? DEFAULT_CUSTOM_CAPABILITIES,
      description: data.description?.trim() ?? '',
    });
  }
  return out;
}

/** The accepted custom models, memoised by the raw config's content signature
 * so the validation (and its warnings) runs only when the setting changes. */
let customCache: { signature: string; models: ModelInfo[] } | undefined;
function customModels(): readonly ModelInfo[] {
  const raw = runtimeConfig().customModels ?? [];
  const signature = JSON.stringify(raw);
  if (!customCache || customCache.signature !== signature) {
    const taken = new Set(builtinModels.map((m) => m.id));
    customCache = { signature, models: loadCustomModels(raw, taken) };
  }
  return customCache.models;
}

/**
 * All models the router may select: the build-time models plus any the user
 * registered via `myDevTeam.customModels` (add-only - see the file header). A
 * function, not a constant, because the custom set is injected at runtime and
 * can change with the user's settings.
 */
export function modelRegistry(): readonly ModelInfo[] {
  const custom = customModels();
  return custom.length === 0 ? builtinModels : [...builtinModels, ...custom];
}

/**
 * The sentinel a client sends (or omits) to let the capability router pick per
 * agent, rather than pinning one model. Anything that is not a registered id
 * is treated the same way, so an unknown pin (version skew) degrades to Auto.
 */
export const AUTO_MODEL = 'auto';

/**
 * Prefix marking a choice that pins a *provider* rather than a single model:
 * e.g. "provider:anthropic" routes the work agents to the best Anthropic model
 * per agent, instead of one fixed model. The catalogue (Engine.listModels)
 * emits these alongside Auto and the individual models.
 */
export const PROVIDER_PIN_PREFIX = 'provider:';

/**
 * User-facing display names for the registry's providers, re-exported from the
 * provider registry (config/providers.ts) so this stays the engine's single
 * import surface for provider identity.
 */
export const providerLabels: Record<ProviderName, string> = registryProviderLabels;

/** The registered model with this id, or undefined for "auto"/unknown ids. */
export function modelById(id: string | undefined): ModelInfo | undefined {
  return id === undefined ? undefined : modelRegistry().find((m) => m.id === id);
}

/**
 * The provider a "provider:<name>" pin names, or undefined when the pin is not
 * a provider pin (or names a provider with no registered models, so it can
 * degrade to Auto rather than route among nothing).
 */
export function providerPinOf(pin: string | undefined): ProviderName | undefined {
  if (!pin || !pin.startsWith(PROVIDER_PIN_PREFIX)) {
    return undefined;
  }
  const name = pin.slice(PROVIDER_PIN_PREFIX.length) as ProviderName;
  return modelRegistry().some((m) => m.provider === name) ? name : undefined;
}

/** Tier as a 0-2 ordinal, so "nearest available tier" is an integer distance. */
const tierOrdinal: Record<Complexity, number> = { simple: 0, moderate: 1, complex: 2 };

/**
 * Narrow a candidate pool to the request's complexity tier. Models tagged for
 * that exact tier are preferred; when the pool has none (e.g. a local-only box
 * with no "complex" model, or a provider missing a tier), it falls back to the
 * nearest available tier by ordinal distance, breaking a distance tie toward
 * the cheaper (lower) tier. The result is always non-empty when the pool is, so
 * scoring still has something to choose from.
 */
export function tierPool(
  pool: readonly ModelInfo[],
  complexity: Complexity
): readonly ModelInfo[] {
  const exact = pool.filter((m) => m.tier === complexity);
  if (exact.length > 0) {
    return exact;
  }
  const want = tierOrdinal[complexity];
  let bestTier: Complexity | undefined;
  let bestKey = Infinity;
  for (const m of pool) {
    const ord = tierOrdinal[m.tier];
    // Distance dominates (each step weighs 10, more than any ordinal); a
    // distance tie then prefers the lower ordinal, i.e. the cheaper tier.
    const key = Math.abs(ord - want) * 10 + ord;
    if (key < bestKey) {
      bestKey = key;
      bestTier = m.tier;
    }
  }
  return bestTier === undefined ? pool : pool.filter((m) => m.tier === bestTier);
}

/** Weighted fit of a model for a requirement profile: Σ weight × score. */
export function scoreModel(info: ModelInfo, requirements: CapabilityScores): number {
  let total = 0;
  for (const [capability, weight] of Object.entries(requirements)) {
    total += weight * (info.capabilities[capability as Capability] ?? 0);
  }
  return total;
}

/**
 * Pick the model for a requirement profile. A `pin` naming a registered model
 * overrides the router and returns that model outright - the user asked for
 * it, even if it is not in `candidates`. A `provider:<name>` pin narrows the
 * choice to that provider's models (all of them, like a model pin bypassing
 * availability) and routes by weight within it. "auto", an unknown id, or no
 * pin falls back to the highest weighted fit among `candidates` (the whole
 * registry by default; the caller passes a narrower set to keep Auto from
 * routing to a model that cannot run - see core/models.ts).
 *
 * A `complexity` narrows the pool to the request's tier before scoring (see
 * `tierPool`), so the same capability profile picks a cheaper model for simple
 * work and a stronger one for complex work. It is skipped for a model pin (the
 * user chose) and when the caller passes none; the provider-pin pool is still
 * tier-narrowed, so e.g. "provider:anthropic" + simple picks Haiku.
 *
 * `isEnabled` is the disable predicate the runtime injects (core/models.ts): a
 * disabled model is dropped from the provider-pin pool and from a candidate
 * default, and a disabled pinned model falls through to scoring rather than
 * being returned outright - so disabling cannot be bypassed by any kind of pin.
 * It defaults to "everything enabled", keeping the pure function usable on its
 * own (and in tests) without the runtime.
 */
export function selectModel(
  requirements: CapabilityScores,
  pin?: string,
  candidates?: readonly ModelInfo[],
  complexity?: Complexity,
  isEnabled: (info: ModelInfo) => boolean = () => true
): ModelInfo {
  const pinned = modelById(pin);
  if (pinned && isEnabled(pinned)) {
    return pinned;
  }
  const provider = providerPinOf(pin);
  const base = provider
    ? modelRegistry().filter((m) => m.provider === provider && isEnabled(m))
    : (candidates ?? modelRegistry()).filter(isEnabled);
  const pool = complexity ? tierPool(base, complexity) : base;
  let best: ModelInfo | undefined;
  let bestScore = -Infinity;
  for (const info of pool) {
    const score = scoreModel(info, requirements);
    if (score > bestScore) {
      best = info;
      bestScore = score;
    }
  }
  if (!best) {
    throw new Error(
      'No models are available to select from (every candidate may be disabled).'
    );
  }
  return best;
}
