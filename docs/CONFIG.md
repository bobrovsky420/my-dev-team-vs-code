# Configuration reference

The complete inventory of every configuration parameter the extension reads:
where it lives, who owns it, when it is read, and what it does. This is the
detailed companion to the configuration sections of
[DESIGN.md](DESIGN.md#configuration-vs-code-config) - DESIGN.md explains how
configuration fits the architecture; this file enumerates the parameters.

> **Keep this file in sync.** Whenever you add, rename, remove, or change the
> default of a setting, a `backend.json` field, a secret key, or a notable
> build-time constant, update the matching row here in the same change. The
> source of truth is the code: user settings in
> [src/config/settings.ts](../src/config/settings.ts) (mirrored in
> `package.json` `contributes.configuration`), the operator floor in
> [config/backend.json](../config/backend.json) (validated by
> [backend.ts](../src/engine/config/backend.ts)), and secrets in
> [src/config/credentials.ts](../src/config/credentials.ts) (key names from
> [providers.ts](../src/config/providers.ts)).

## Configuration sources

Configuration lives in five places, each with a different owner, scope, and
read cadence:

| Source | File(s) | Owner / scope | When read |
| ------ | ------- | ------------- | --------- |
| Operator floor | [config/backend.json](../config/backend.json) via [backend.ts](../src/engine/config/backend.ts) | Operator / distributor; build-wide | Load time (bundled into the build) |
| User settings | `myDevTeam.*` in `package.json` via [settings.ts](../src/config/settings.ts) | End user; per VS Code instance | **Live, on every access** (no reload) |
| Secrets | env vars (+ SecretStorage for the local engine) via [credentials.ts](../src/config/credentials.ts) / [secrets.ts](../src/client/secrets.ts) | End user | Live, on every access |
| Build-time constants | [limits.ts](../src/config/limits.ts) (engine) + non-getter fields of [settings.ts](../src/config/settings.ts) (client) | Developer; compile-time | Baked into the bundle |
| Author config | `src/engine/config/{agents,models,tools,commands,skills}/*.md` | Developer / author; bundled | Load time |

**How the engine reads config.** The engine never imports `config/settings.ts`
(which needs `vscode`). It reads user settings through the injected
[runtimeConfig.ts](../src/config/runtimeConfig.ts) seam - a live view in the
extension host, a pushed snapshot in the sidecar child - and compile-time
constants from [limits.ts](../src/config/limits.ts). This is what lets the same
engine run in a separate process.

**Why config lives in two folders.** The root-level `config/` holds
**operator/deployment config** - the knobs you turn to customize an *install*
(today only `backend.json`), editable without touching `src/` and carried
server-side by a future remote backend. Everything under `src/engine/config/`
(and `src/config/`) is **authored product source** - the system prompts, the
model registry, the tool/command/skill definitions, and the typed loaders that
consume them. Those assets *are* the engine's behavior and travel with the
engine, so they stay co-located with their loaders rather than moving to the
root. That is why `backend.json` is the only data file outside `src/`: it is the
one file with operator, rather than author, semantics. See
[DESIGN.md](DESIGN.md#configuration-vs-code-config).

Two layered relationships matter and are not the same rule (see
[Precedence and merge semantics](#precedence-and-merge-semantics)):

- **Disable lists** are a **monotonic union** and the one enforced floor - the
  operator's and the user's lists are unioned, so the user can only ever disable
  *more*, never re-enable what the operator disabled.
- **Endpoints, base URLs, request rates, triage model** are **deployment
  defaults the user overrides** - the operator's `backend.json` value is used
  only when the user has set nothing; the user's `myDevTeam.*` setting wins when
  present.

## 1. User settings (`myDevTeam.*`)

The runtime knobs an end user may turn, declared in `package.json`
(`contributes.configuration`) and read **live** by
[settings.ts](../src/config/settings.ts) on every access - a change takes effect on
the next request with no reload. Invalid values (wrong type, non-positive
number, non-http(s) URL, path-escaping entry) silently fall back to the default,
so consumers can always trust what they read.

| Setting | Default | Usage | Floor / layer interaction |
| ------- | ------- | ----- | ------------------------- |
| `engine` | `local` | Which engine handles runs: `local` (in-process), `sidecar` (same engine in a forked child), or `remote` (Phase B; warns and falls back to local) | - |
| `model` | `auto` | Planner/answerer/executor model: a model id, `provider:<name>`, or `auto`. Set via `/model` or the status-bar menu; picking a provider/Auto there also sets `triage.model` to match. Also read by the engine (via the runtime-config seam) as triage's default and for the startup probe | - |
| `triage.model` | `""` | Triage classifier model, separate from `model`. Empty cascades to `model` (when it names a concrete model/provider), then the floor. Set from `/model`'s "Triage only" group, by a provider/Auto pick (which sets both), or directly. Ignored in `combined` triage mode | empty -> `model` (if concrete) -> `agents.triage.model` floor |
| `triage.mode` | `classifier` | How a request is routed: `classifier` (triage call, then answerer/planner) or `combined` (one responder triages + answers-or-plans in a single call on the `model` work model). Only the unpinned path is affected - a slash command still pins the route and uses the dedicated agents | - |
| `complexityRouting` | `true` | Size the model to the task's complexity tier; off routes by capability alone. In `combined` mode the responder is not complexity-sized; the executor still is | a model pin bypasses regardless |
| `planApproval` | `auto` | When a drafted plan must be approved: `auto` (only when complex), `always`, `never`. On `always`, a `direct`-route change is escalated to a drafted plan so there is something to approve | - |
| `planApproval.preview` | `auto` | When a paused plan also opens as a read-only editor preview: `auto` (only a big plan), `always`, `never` (chat only) | client-only (not on the engine runtime-config seam); applies only when `planApproval` pauses |
| `verbosity` | `verbose` | How much each reply renders: `verbose` (intent + reason + complexity + full plan with step details + every built-in tool call's output) or `default` (intent only; plan summary + step titles; a tool call shows only the tool name and its key argument, a failed call still surfaces its error, dynamic/MCP tools are not gated). Set via `/verbose`, "Select Output Mode", or the status-bar menu | client-only (not on the engine runtime-config seam); a pure rendering choice, the full reply data crosses the protocol either way |
| `attachActiveEditor` | `true` | Auto-attach the open file (or just the selection when text is selected) as context on every request, so "the current file"/"this selection" resolves without the user attaching anything | client-only (not on the engine runtime-config seam); de-duped against an explicitly-attached/implicit reference to the same file |
| `approval.fileChanges` | `false` | Gate `write`/`edit` behind approval like `run`; off applies changes directly | `run` stays gated regardless |
| `disabledProviders` | `[]` | Providers the router must never use | **union** with floor; cannot re-enable a floor-disabled provider |
| `disabledModels` | `[]` | Model ids the router must never use | **union** with floor |
| `customModels` | `[]` | Extra model definitions merged on top of the built-in registry (each: `id`, `label`, `provider`, `model`, optional `tier`/`capabilities`/`description`) | **add-only**: each must name an already-wired provider; an id colliding with a built-in (or an earlier entry) is dropped, never overrides |
| `ollama.endpoint` | `""` (unset) | Ollama server origin (no `/api` suffix) | **user wins** over `providers.ollama.endpoint` default; unset -> deployment default -> built-in localhost |
| `llamacpp.endpoint` | `""` (unset) | llama.cpp (`llama-server`) origin (no `/v1` suffix); keyless local provider | **user wins** over `providers.llamacpp.endpoint` default; unset -> deployment default -> built-in `http://localhost:8080` |
| `openai.baseUrl` | `""` | OpenAI / Azure / compatible gateway base URL | **user wins** over `providers.openai.baseUrl` default; unset -> deployment default -> SDK default |
| `anthropic.baseUrl` | `""` | Anthropic proxy/gateway base URL | **user wins** over backend default |
| `groq.baseUrl` | `""` | Groq proxy/gateway base URL | **user wins** over backend default |
| `deepseek.baseUrl` | `""` | DeepSeek proxy/gateway base URL | **user wins** over backend default |
| `zai.baseUrl` | `""` | Z.AI (GLM) proxy/gateway base URL | **user wins** over backend default; unset -> deployment default -> Z.AI default (`https://api.z.ai/api/paas/v4`) |
| `provider.requestsPerMinute` | `null` (unset) | Override of the per-provider request rate; `0` disables throttling, `N` sets N/min | **user wins** over the backend per-provider default (either direction); unset defers to it |
| `run.commandTimeoutMs` | `60000` | `run` tool shell-command timeout (ms) | - |
| `run.allowedCommands` | `[]` | Command prefixes/globs the `run` tool runs without an approval prompt (e.g. `git status`, `npm test`, `npm run *`) | only a single, non-chained command matches; a denylisted command never matches; the "Always allow commands like this" choice appends here; invalid entries dropped |
| `run.deniedCommands` | `[]` | Extra command patterns that always prompt and are treated as destructive | **unioned with** a non-removable built-in floor - POSIX (`rm`, `git push`, `git reset`, `git clean/checkout/rebase`, `curl`, `wget`, ...) and PowerShell (`Remove-Item`, `Clear-Content`, `Stop-Process`, `Stop-Computer`, `Format-Volume`, `Invoke-Expression`, ...); overrides the agent's `dangerous` flag and any `run` Allow-All grant; case-insensitive; scans each chained segment |
| `read.maxLines` | `200` | Max lines one `read` call returns | - |
| `search.globMaxResults` | `200` | Max files a glob search returns | - |
| `search.contentScanLimit` | `500` | Max files a content search scans | - |
| `search.contentMaxMatches` | `50` | Max match lines before a content search stops | - |
| `chat.toolSnippetLines` | `5` | Leading lines of a write/edit shown in the transcript (`0` hides) | - |
| `executor.checkpointEverySteps` | `100` | Steps between executor/planner check-ins ("keep going or stop?"); `0` turns the step trigger off | the planner now drives a tool-calling loop too and shares this; whichever of steps/seconds is reached first triggers it; must be `< executor.maxSteps` to fire |
| `executor.checkpointEverySeconds` | `600` | Seconds between executor/planner check-ins; `0` turns the time trigger off | shared by the planner's loop; whichever of steps/seconds is reached first triggers it |
| `executor.contextWarnThresholds` | `[75, 85, 95]` | Context-usage levels (% of the model's window) that each warn once during an executor or planner run; each level below `history.autoCompactThreshold` also offers a "Compact now" action | cleaned to whole percents in (0,100], de-duped, sorted; empty/all-invalid -> default |
| `history.autoCompact` | `true` | Auto-compact the conversation once a run crosses `history.autoCompactThreshold`: the next message runs `/compact` first and continues against the summary | client-only (history is client state); anything but literal `false` is on |
| `history.autoCompactThreshold` | `95` | Context-usage level (% of the model's window) at/above which the conversation auto-compacts on the next message (when `history.autoCompact` is on); below it a warning only offers "Compact now" | cleaned to a whole percent in (0,100]; unset/invalid -> default; set it to one of `executor.contextWarnThresholds` to line up with a warning |
| `modelContextWindows` | `{}` | Per-model context-window sizes in tokens keyed by model id, e.g. `{"qwen3-coder": 32768}` | overrides the model's built-in `contextWindow`; matters most for local models (real `num_ctx`); only positive whole numbers kept |
| `write.protectedPaths` | `[".vscode"]` | Root-relative paths `write`/`edit` refuse to touch | `.git/` is always protected and not removable; `..` entries -> default |
| `usage.showInChat` | `true` | Append a `Tokens:` line under each reply | status-bar total and report are independent |
| `changes.showInChat` | `true` | Append a `Changes:` line when a turn wrote files | - |
| `summary.showInChat` | `true` | Three-section summary after a file-changing run | off skips the summarizer model call entirely |
| `thinking.showInChat` | `true` | Capture a reasoning model's thinking so its duration can be timed (the live indicator is VS Code's own built-in progress, shown either way) | off skips capturing reasoning entirely, and removes the duration line |
| `thinking.showDuration` | `true` | Append a `Thought for Ns` line after a reasoning model finishes | client-only; needs `thinking.showInChat` on to have timed anything; anything but `false` counts as on |
| `clarify.enabled` | `true` | Let the engine end an ambiguous run by asking the user (the "clarify" route) instead of guessing | off coerces a clarify decision to a normal answer, so a run always produces work; anything but `false` counts as on |
| `instructions.files` | `["AGENTS.md", "CLAUDE.md"]` | Root-relative instruction file names probed in order | plain names only; a `/` or `..` entry -> default list |
| `skills.directories` | `[".devteam/skills", ".claude/skills"]` | Dirs scanned for `<dir>/<name>/SKILL.md` (workspace roots + home) | absolute or `..` entry -> default list |
| `mcp.servers` | `{}` | stdio MCP servers: name -> `{ command, args?, env? }` | ignored in an untrusted workspace; invalid entries dropped |
| `telemetry.evalLog` | `false` | Opt-in local eval log of run/feedback records | nothing leaves the machine |
| `telemetry.shadowTriage` | `false` | Also run triage on pinned runs to score it | only collects while `evalLog` is on |
| `debug` | `false` | Log every layer of a run (client<->backend protocol + each provider-API call's raw request/response) to the "My Dev Team (Debug)" output channel | read live; works for the local and sidecar engine; diagnostic only - verbose, carries the run's raw content, stays on the machine; anything but literal `true` is off |

## 2. Operator config (`backend.json`)

Operator-owned settings, distinct from user settings, bundled into the build and
validated by Zod at load ([backend.ts](../src/engine/config/backend.ts)) - an
invalid file fails the build loudly. A future remote backend would carry the
same file server-side. Every field defaults to empty, so a partial or empty file
is valid. Two roles, not one: the **disable lists are an enforced floor** (a user
can narrow further but can never re-enable what the operator disabled), while
**everything else is a deployment default the user can override** (endpoints,
base URLs, request rates, triage model). The "Semantics vs user" column says
which is which.

| Key | Default | Usage | Semantics vs user |
| --- | ------- | ----- | ----------------- |
| `models.disabledProviders` | `[]` | Providers no one may use | **union** floor; a user cannot re-enable |
| `models.disabledModels` | `[]` | Model ids no one may use | **union** floor |
| `providers.ollama.endpoint` | `""` | Ollama origin **default** | user `myDevTeam.ollama.endpoint` **wins** when set; this is the fallback |
| `providers.llamacpp.endpoint` | `""` | llama.cpp (`llama-server`) origin **default** | user `myDevTeam.llamacpp.endpoint` **wins** when set; this is the fallback |
| `providers.openai.baseUrl` | `""` | OpenAI base URL **default** | user `myDevTeam.openai.baseUrl` **wins** when set |
| `providers.anthropic.baseUrl` | `""` | Anthropic base URL **default** | user `myDevTeam.anthropic.baseUrl` **wins** when set |
| `providers.groq.baseUrl` | `""` | Groq base URL **default** | user `myDevTeam.groq.baseUrl` **wins** when set |
| `providers.deepseek.baseUrl` | `""` | DeepSeek base URL **default** | user `myDevTeam.deepseek.baseUrl` **wins** when set |
| `providers.zai.baseUrl` | `""` | Z.AI base URL **default** | user `myDevTeam.zai.baseUrl` **wins** when set; unset -> Z.AI default endpoint |
| `providers.<id>.requestsPerMinute` | `0` (per provider) | Per-provider request-rate **default** (requests/min; `0` = no throttle) | user `myDevTeam.provider.requestsPerMinute` **wins** when set (either direction); unset defers to it |
| `agents.triage.model` | `"ollama"` | Triage routing **default**, used only when both `triage.model` and the work `model` are unset/`auto`: a model id pins it, a provider name routes by capability | user `triage.model` **wins** when set, then the work `model` when it names a concrete model/provider |

## 3. Secrets (API keys)

Cloud-provider API keys resolve through an **injectable secret source**
([credentials.ts](../src/config/credentials.ts)), so the engine reads them
without importing `vscode`. The default source - and the **only** source for the
`sidecar` engine (and a future remote) - is **environment variables**, which the
sidecar child inherits, so no secret crosses the process boundary. The in-process
**`local` engine** additionally accepts keys stored in the editor via the "Set
API Key" command: the host injects a SecretStorage-backed source
([client/secrets.ts](../src/client/secrets.ts)) that reads SecretStorage first,
then the environment variable. The set of cloud providers and these key names
derive from the provider registry ([providers.ts](../src/config/providers.ts)) -
a cloud provider is any non-keyless descriptor. Read live by the provider wiring.

| Provider | Environment variable | SecretStorage key (local engine) |
| -------- | -------------------- | -------------------------------- |
| `openai` | `OPENAI_API_KEY` | `myDevTeam.openai.apiKey` |
| `anthropic` | `ANTHROPIC_API_KEY` | `myDevTeam.anthropic.apiKey` |
| `groq` | `GROQ_API_KEY` | `myDevTeam.groq.apiKey` |
| `deepseek` | `DEEPSEEK_API_KEY` | `myDevTeam.deepseek.apiKey` |
| `zai` | `ZAI_API_KEY` | `myDevTeam.zai.apiKey` |
| `ollama` | - (keyless, local) | - |
| `llamacpp` | - (keyless, local) | - |

The SecretStorage keys share the `myDevTeam.` prefix but are **not**
`settings.json` entries - they never appear in the Settings UI, and the sidecar
engine ignores them.

## 4. Build-time constants

Not user-tunable. The engine-read constants live in
[limits.ts](../src/config/limits.ts) (the single source); the client-read UI
constants live in [uiLimits.ts](../src/config/uiLimits.ts); the rest are
non-getter fields of [settings.ts](../src/config/settings.ts). Change them in
code and rebuild. They bound how much work the tools and UI do.

| Group | Constant | Default |
| ----- | -------- | ------- |
| Rate-limit retry | `provider.maxRateLimitRetries` | `5` |
| | `provider.maxRetryWaitMs` | `60000` |
| | `provider.retryBufferMs` | `250` |
| `run` tool | `runCommandMaxBufferBytes` | `10 MB` |
| | `runResultMaxChars` | `200000` |
| | `runMirrorBacklogMaxChars` | `200000` |
| `read` tool | `read.maxChars` | `200000` |
| | `read.maxFileSizeBytes` | `10 MB` |
| `search` tool | `search.contentMaxMatchesPerFile` | `5` |
| | `search.contentPreviewMaxChars` | `200` |
| | `search.excludeGlob` | node_modules, .git, dist, out, coverage |
| | `search.maxFileSizeBytes` | `1 MB` |
| | `search.scanCandidateLimit` | `25000` |
| Structured output | `structuredOutput.repairAttempts` | `1` |
| Executor | `executor.maxSteps` | `1000` (the runaway-step ceiling shared by the executor and the planner loops) |
| | `executor.inputPreviewMaxChars` | `200` |
| | `executor.resultPreviewMaxChars` | `400` |
| Thinking | `thinking.lineMaxChars` | `200` |
| Compaction | `compaction.inputWindowFraction` | `0.6` (fraction of the compacter model's window the conversation may fill per pass) |
| | `compaction.briefingReserveFraction` | `0.4` (per-pass budget reserved for the carried briefing in a multi-pass refine) |
| Telemetry | `telemetry.evalLogMaxChars` | `1000000` |
| Instructions | `instructions.maxChars` | `8000` |
| Skills | `skills.maxSkills` | `24` |
| | `skills.maxChars` | `8000` (caps each skill body the client serves on demand) |
| MCP | `mcp.maxTools` | `64` |
| | `mcp.connectTimeoutMs` | `10000` |
| | `mcp.callTimeoutMs` | `60000` |
| | `mcp.resultMaxChars` | `50000` |
| References | `references.codebaseMaxTerms` | `4` |
| | `references.codebaseMaxFiles` | `8` |
| | `references.codebaseSnippetFiles` | `3` |
| | `references.codebaseSnippetLines` | `20` |
| | `references.codebaseMaxChars` | `8000` |
| | `references.changesMaxChars` | `12000` |
| Attachments | `maxAttachmentChars` | `20000` |
| | `maxAttachmentReadBytes` | `10 MB` |
| History | `history.maxTurns` | `10` |
| | `history.maxTurnChars` | `2000` |
| | `history.compactInputMaxChars` | `120000` (coarse client ceiling; engine does the real window-aware trim) |
| | `history.compactSummaryMaxChars` | `8000` |
| Startup | `startupProbeTimeoutMs` | `3000` |
| Sidecar | `sidecar.queryTimeoutMs` | `10000` |
| | `sidecar.readyTimeoutMs` | `10000` |
| | `sidecar.respawnWindowMs` | `60000` |
| | `sidecar.maxRespawns` | `3` |
| UI (client; `uiLimits.ts`) | `planPreview.minChars` | `1400` |
| | `planPreview.minSteps` | `8` |
| | `approval.mcpArgsPreviewMaxChars` | `500` |
| | `statusBar.priority` | `100` |

## 5. Author config (the `.md` files)

Prompt material and the model registry, bundled at build time (esbuild inlines
each file as a string). These are configuration an author tunes, not runtime
settings; see [DESIGN.md](DESIGN.md#configuration-vs-code-config) for how they
are discovered and rendered.

| Folder | Per-file frontmatter |
| ------ | -------------------- |
| `agents/*.md` | `id`, `name`, `description`, capability weights (unified vocabulary, see `models/*.md`), `tools`, optional sampling params `temperature`/`top_p`/`top_k` (unset = provider defaults; ride each call as AI SDK `modelSettings`) |
| `models/*.md` | `id`, `label`, `provider`, `model`, `tier`, optional `triageOnly` (default `false`; `true` = eligible for triage only, not the Auto work pool - a pin still overrides), optional `contextWindow` (tokens, for the context-usage warnings; overridable per id via `myDevTeam.modelContextWindows`), capability scores on the unified 8-name vocabulary (`reasoning`, `code-generation`, `code-analysis`, `classification`, `planning`, `fast-utility`, `structured-output`, `long-context`; the legacy `coding`/`speed` names are accepted in hand-written config and normalised). Generated from the shared `my-dev-team-config` registry (`models.yaml` + `scripts/sync_models.py`) - edit there, not here |
| `tools/*.md` | `name`, `sideEffecting`, optional `previewArg`/`snippetArg` + description |
| `commands/*.md` | `name`, `description`, `intent`, `execute`, optional `complexity` + preamble |
| `skills/*.md` | `name`, `description` + instruction body |
| `partials/*.md` | `name` + a shared prompt block; agents embed it with `{{ include <name> }}` (path and `.md` in the directive are optional). Generated from the shared `my-dev-team-config` partials library (`partials/*.md` + `scripts/sync_partials.py`) - edit there, not here |

**Discovered content files** (read per request, not bundled - workspace roots
and the user's home dir): the standing-instruction file (`AGENTS.md` /
`CLAUDE.md`, names from `instructions.files`) and skill packages
(`<dir>/<name>/SKILL.md`, dirs from `skills.directories`). These carry prose, not
parameters. The client ships the instruction file in full, but for skills it
ships only the metadata (name + description) and serves a body on demand when the
model loads it; the engine bundles no skills of its own.

## Precedence and merge semantics

When the same concept is set in more than one source, resolution follows one of
two rules, decided per field (not a single deep merge):

1. **User-wins override** (endpoints, base URLs, per-provider `requestsPerMinute`,
   triage model): resolved as **user setting else backend default else compiled
   default**. The operator's `backend.json` supplies the value a deployment ships
   with; when the user sets the matching `myDevTeam.*` setting their value wins
   outright - for `requestsPerMinute` in either direction (raise or lower). The
   rationale: an endpoint and a request rate govern the user's own machine and
   quota, so they are the user's to choose, with the deployment only providing a
   sensible default. Implemented in
   [engine/core/models.ts](../src/engine/core/models.ts) (`ollamaEndpoint`,
   `resolveProviderConfig`, `triageRouting`) and
   [engine/core/rateLimiter.ts](../src/engine/core/rateLimiter.ts)
   (`resolveRequestsPerMinute`).

2. **Monotonic / narrowing floor** (disable lists): resolved as the **union** of
   the backend floor and the user setting - the one place the operator enforces
   rather than defaults. A provider/model is enabled only when neither layer
   disabled it, so the user layer can narrow further but can never re-enable what
   the floor disabled. Implemented as `isProviderEnabled` / `isModelEnabled` in
   [engine/core/models.ts](../src/engine/core/models.ts).

Secrets are never part of this merge: they reach the provider wiring through the
secret source (environment variables, plus SecretStorage for the local engine),
never through a config file. See [Secrets](#3-secrets-api-keys).
