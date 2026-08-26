/**
 * The universal backend config: operator-owned settings the engine enforces,
 * distinct from the user's VS Code settings (config/settings.ts). It ships as a
 * single JSON file at the project root (`config/backend.json`), inlined into the
 * build by this module's import - the engine reads no file at runtime, so this is
 * the backend equivalent of the model/tool `.md` configs: edit the file, rebuild,
 * and the new floor takes effect.
 *
 * Today the "backend" runs in-process on the client, so the file ships with the
 * extension; a future remote backend would carry the same file server-side. It
 * is deliberately namespaced (a `models` section here, room for `tools`,
 * `limits`, ... later) and every field defaults to empty, so a partial or empty
 * file is valid and new sections can be added without breaking older ones.
 *
 * Two sections today:
 *  - `models`: the providers and individual models the operator has disabled. A
 *    disabled provider/model is an *unbypassable* floor - the router never
 *    routes to it and a user pin cannot resurrect it (see the enabled predicate
 *    in core/models.ts). The per-user equivalent is the
 *    `myDevTeam.disabledProviders`/`disabledModels` settings, which narrow
 *    further but can never re-enable what the backend disabled.
 *  - `providers`: per-provider settings, all **deployment defaults the user can
 *    override** (not enforced floors - the only enforced floor is the disable
 *    list above). The endpoint default (Ollama's `endpoint`, the cloud providers'
 *    `baseUrl`) gives a deployment a sensible server to ship with; the user's
 *    `myDevTeam.ollama.endpoint` / `myDevTeam.<provider>.baseUrl` *wins over* it
 *    when set, an empty/blank value here just means "no default" (resolution in
 *    core/models.ts). `requestsPerMinute` is the per-provider request rate
 *    (0 = no throttle); likewise the user's `myDevTeam.provider.requestsPerMinute`
 *    wins over it when set, in either direction, since a request rate is the
 *    user's own quota to manage (resolution in core/rateLimiter.ts'
 *    `resolveRequestsPerMinute`). An unset user setting defers to the default here.
 *  - `agents.triage.model`: how the (always-engine-side) triage classifier is
 *    routed. A registered model id pins that exact model; a provider name (e.g.
 *    "ollama", "anthropic") routes by capability among that provider's models;
 *    the default is the "ollama" provider (the local models, triage's historic
 *    home). The resolution lives in core/models.ts (`triageRouting`).
 */
import { z } from 'zod';
import rawBackendConfig from '../../../config/backend.json';

/** A list of provider/model identifiers, defaulting to empty when omitted. */
const idList = z.array(z.string()).default([]);

/**
 * A provider endpoint override: an http(s) URL with any trailing slash trimmed,
 * or undefined when omitted/blank (meaning "no override"). A non-blank value
 * that is not an http(s) URL fails validation at load, a loud error the operator
 * fixes - rather than silently ignoring a typo'd gateway.
 */
const endpointOverride = z
  .string()
  .optional()
  .transform((value) => (value ?? '').trim().replace(/\/+$/, ''))
  .refine((value) => value === '' || /^https?:\/\/.+/.test(value), {
    message: 'a provider endpoint override must be an http(s) URL',
  })
  .transform((value) => (value === '' ? undefined : value));

/**
 * An agent's routing choice: a registered model id or a provider name. It is a
 * free string (the model registry is not known here), resolved leniently at
 * runtime; blank/omitted defaults to the "ollama" provider - triage's home.
 */
const modelOrProvider = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? 'ollama' : trimmed;
  });

/**
 * A provider's operator request-rate floor: a non-negative integer (requests
 * per minute), defaulting to 0 (no throttle) when omitted. A negative or
 * non-integer value fails validation at load - a loud error the operator fixes,
 * matching how a bad endpoint override is rejected rather than silently ignored.
 */
const requestsPerMinute = z.number().int().min(0).default(0);

export const BackendConfigSchema = z
  .object({
    /** Model-router floor: providers and model ids the operator disabled. */
    models: z
      .object({
        /** Provider names (e.g. "anthropic") the router must never use. */
        disabledProviders: idList,
        /** Registered model ids (e.g. "qwen3-coder") the router must never use. */
        disabledModels: idList,
      })
      // prefault (not default): a missing section parses from `{}`, so the inner
      // field defaults still fill the empty arrays.
      .prefault({}),
    /** Per-provider endpoint overrides; each wins over its user setting. */
    providers: z
      .object({
        /** Ollama server origin (no `/api` suffix), like `myDevTeam.ollama.endpoint`. */
        ollama: z.object({ endpoint: endpointOverride, requestsPerMinute }).prefault({}),
        /** llama.cpp (`llama-server`) origin (no `/v1` suffix), like `myDevTeam.llamacpp.endpoint`. */
        llamacpp: z.object({ endpoint: endpointOverride, requestsPerMinute }).prefault({}),
        /** OpenAI base URL, like `myDevTeam.openai.baseUrl`. */
        openai: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
        /** Anthropic base URL, like `myDevTeam.anthropic.baseUrl`. */
        anthropic: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
        /** Groq base URL, like `myDevTeam.groq.baseUrl`. */
        groq: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
        /** DeepSeek base URL, like `myDevTeam.deepseek.baseUrl`. */
        deepseek: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
        /** Z.AI base URL, like `myDevTeam.zai.baseUrl`. */
        zai: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
        /** Moonshot Kimi base URL, like `myDevTeam.kimi.baseUrl`. */
        kimi: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
        /** Google (Gemini) base URL, like `myDevTeam.google.baseUrl`. */
        google: z.object({ baseUrl: endpointOverride, requestsPerMinute }).prefault({}),
      })
      .prefault({}),
    /** Per-agent routing config. Today only triage is configurable. */
    agents: z
      .object({
        triage: z
          .object({
            /**
             * A registered model id (pin that exact model) or a provider name
             * (route by capability within it); blank/omitted falls back to the
             * "ollama" provider.
             */
            model: modelOrProvider,
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .prefault({});

export type BackendConfig = z.infer<typeof BackendConfigSchema>;

/**
 * The parsed, validated backend config. An invalid file fails the build's first
 * load (a loud, early failure the operator fixes), rather than silently
 * degrading the floor.
 */
export const backendConfig: BackendConfig = BackendConfigSchema.parse(rawBackendConfig);
