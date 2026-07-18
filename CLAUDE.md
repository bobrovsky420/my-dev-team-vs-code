# Project instructions

## Preserve the backend/client separation

The agent pipeline is split into three layers - the **engine** (`src/engine/`,
the brain: agents, prompts, model router, workflow), the **client**
(`src/tools/`, `src/client/`, `src/ui/`, the hands: tool implementations,
approval, rendering), and the **protocol** (`src/protocol/`, the contract
between them). This separation is load-bearing: the engine is meant to run not
only in-process (today's `LocalEngine`) but eventually as a **standalone remote
backend**, or as a **sidecar process** behind either a VS Code client **or an
IntelliJ IDEA (JVM/Kotlin) client**. An IntelliJ plugin cannot import the
TypeScript engine, so the only way to share the brain across editors is to run
the same engine as a separate process and reimplement just the thin client half
per editor.

Every change to `engine/` or `protocol/` must keep that future viable. Hold to
four invariants:

1. **No `vscode` import in `src/engine/`** (or `src/protocol/`). The engine
   knows nothing about any editor.
2. **Everything crossing the protocol is wire-serializable** - plain data, no
   functions, class instances, or `Uri`s that only survive in one process.
3. **Config and secrets are injected, not read in-process** - the engine reads
   user settings through the injected `config/runtimeConfig.ts` seam (and
   compile-time constants from `config/limits.ts`), never `config/settings.ts`
   or `vscode`; cloud keys come through the injectable `SecretSource` in
   `config/credentials.ts` (default env-only; the host injects a SecretStorage
   source for the local engine - `client/secrets.ts`), so the engine module
   itself stays `vscode`-free. New engine code must keep this: read config via
   `runtimeConfig()`/`limits` and keys via `credentials`, never `settings`,
   SecretStorage, or `vscode`.
4. **Tools stay inverted** - the engine only ever *asks* for a side effect
   through the `ToolHost`; it never touches the workspace itself.

When unsure, ask: "would this still work if the engine were a separate process
talking to a Kotlin client?" If no, the change belongs on the client side of
the protocol. See the "Deployment targets" note in docs/DESIGN.md (the Architecture
section) for the full rationale.

## Keep docs/DESIGN.md in sync

docs/DESIGN.md is the developer documentation: architecture, request flow, the
engine protocol, configuration, the model router, the tools, development
setup, and the roadmap. Every time a significant change is made, update
docs/DESIGN.md in the same piece of work - do not leave it for a follow-up.
Significant means anything docs/DESIGN.md describes or a reader would rely on,
e.g.:

- architecture: new/renamed/deleted files in `src/`, new layers or seams
- configuration: the `.md` config formats (agents, models, tools), frontmatter
  fields, capability vocabulary, registered models
- behavior: the request flow, what `@devteam` does, model selection results
- workflow: build/test scripts, prerequisites (e.g. which Ollama models to pull)

Check in particular the architecture tree, the config table, the
capability-router section, "Current behavior", "Prerequisites", and the
scripts table - they name concrete files and models and drift easily.

Pure refactors that change no structure or behavior, and test-only changes, do
not require a docs/DESIGN.md update.

## Keep docs/CONFIG.md in sync

docs/CONFIG.md is the exhaustive configuration reference: every parameter the
extension reads, grouped by source (user `myDevTeam.*` settings, the
`backend.json` operator floor, secrets, build-time constants, and the author
`.md` configs), with its default, scope, read cadence, and usage, plus the
precedence/merge rules. Whenever a change adds, renames, removes, or changes the
default of any of these, update the matching row in docs/CONFIG.md in the same piece
of work - do not leave it for a follow-up. That means:

- a new/renamed/removed `myDevTeam.*` setting or a changed default (keep it
  consistent with `package.json`, `config/settings.ts`, and the docs/DESIGN.md
  user-settings table)
- a new/changed `config/backend.json` field, secret key, or notable
  build-time constant in `config/settings.ts`
- a change to the precedence or merge semantics (override vs union, the floor
  rules)

The source of truth is the code; docs/CONFIG.md follows it. Test-only changes and
pure refactors that touch no parameter need no docs/CONFIG.md update.

## Keep README.md high-level

README.md is the front page, written to attract developers and end users: a
short pitch, the highlights, links to docs/QUICKSTART.md and docs/HOWTO.md (end users)
and docs/DESIGN.md (developers), a minimal getting-started snippet, the tech stack,
and the license. Keep it at that altitude - detail belongs in docs/DESIGN.md,
docs/HOWTO.md, or docs/QUICKSTART.md, never here. Update it only when the pitch-level
facts change: what the extension is and does, a headline feature, the tech
stack, the build/launch one-liner, the license, or the set of documents it
links to.

## Keep docs/QUICKSTART.md in sync

docs/QUICKSTART.md is the short post-install guide: the shortest path from a
downloaded `.vsix` to a working chat, written as explicit numbered GUI steps
(which button to press, what to type and where). It targets a corporate end
user who cannot run the AI locally, so connecting to a hosted AI service is the
central step, with two options - an Ollama server reached by endpoint, or an
Azure OpenAI deployment (base URL + API key via the Set API Key command or
`OPENAI_API_KEY`). Keep it narrow - install, connect, open a folder, say hello.
Anything beyond that first-run path belongs in docs/HOWTO.md, not here. Update it
when the post-install flow changes: the install steps, the connection options
(endpoint / base URL / API-key setup), or the first-run experience. Keep both
docs/QUICKSTART.md and docs/HOWTO.md pointing at each other.

## Keep docs/HOWTO.md in sync

docs/HOWTO.md is the full end-user guide: it tells a non-developer how to set up,
launch, and use the extension. Every time a change affects what an end user
sees or does, update it in the same piece of work - do not leave it for a
follow-up. That means changes to:

- setup: prerequisites, which Ollama models to pull, build/launch steps
- usage: what `@devteam` does, the slash commands and their effects,
  attachments, follow-ups
- the approval flow: which actions ask first, what the prompts show, what
  Approve/Decline/cancel do, the "Dev Team" terminal
- user-facing settings: any added/renamed/removed `myDevTeam.*` setting or a
  changed default
- feedback and troubleshooting: the 👍/👎 flow, the eval log, common failure
  modes and their fixes

Keep it written for an end user, not a developer: plain language, no
architecture or implementation detail, no source file paths. Internal
changes (refactors, new seams, protocol work) that do not change what the
user experiences do not require an update.

Every time a significant change is made, add a CHANGELOG.md entry in the same
piece of work, following the file's existing Keep a Changelog format (newest
version first, `## [x.y.z] - date`, changes under `### Added` / `### Changed`
/ `### Fixed` / `### Security` / `### Removed`):

- one entry per change: a bold short title plus 1-2 sentences - what changed
  and why it matters, no commit hashes, no implementation detail
- skip negligible changes entirely: pure renames, documentation-only changes,
  test-only changes, formatting, and minor tweaks get no entry
- propose the version with the entry. The three numbers move independently:
  - **major version** (the first number) is **never bumped automatically** -
    only when the user explicitly requests it. Even a breaking change or a
    milestone like the first stable release does not bump major on its own;
    surface it and let the user decide.
  - **minor version** (the middle number) is bumped **only for significant
    changes** - a new feature, a behavior change, or an architecture change.
  - **patch version** (the last number) is bumped for **everything else** -
    fixes, hardening, and refactors.
- the rule below turns on whether the version in `package.json` has already
  been **committed**. Check `git status`/`git log` first:
  - **the current version is already committed** (a clean tree, or your change
    is the first uncommitted work on top of a released version): this is a new
    release, so bump it - patch for a fix/hardening/refactor, minor for a
    significant change - even when the committed version is a `major.minor.0`.
    A small change on top of a committed `0.47.0` becomes `0.47.1`, and its
    CHANGELOG entry goes under a new `## [0.47.1]` section, not under the
    already-released `0.47.0`.
  - **the current version is itself uncommitted** (a previous change in this
    same uncommitted batch already bumped it, so `package.json` is dirty): do not
    bump again for a fix/hardening/refactor - leave the version as is and add
    your entry under that pending section, whether it is a `major.minor.0` or a
    patch. The only time you bump is when your change is significant enough to
    escalate a pending patch to a new minor (`0.50.1` -> `0.51.0`). This keeps
    one in-flight batch from inflating the version several times before it lands.

## Keep unit tests in sync

When a change needs it, update the affected unit tests and add new ones in the
same piece of work - not as a follow-up:

- new logic or config (a module, a registry entry, a schema field) gets new
  tests covering it
- changed behavior gets its existing tests updated to assert the new behavior,
  not deleted or loosened to make them pass
- run `npm test` before considering the work done

Tests live in `test/` and run on Vitest in plain Node: `vscode` is aliased to
the in-memory fake in `test/mocks/vscode.ts`, and Mastra agents are stubbed so
tests never construct a model or reach Ollama. Follow those patterns rather
than introducing real I/O or network calls.

## Propose a commit message

After every change, propose a short, concise one-line commit message for the
work, written in the repository's existing style (a sentence-case noun phrase,
no conventional-commit prefix). Only propose it - never create the commit or
apply it yourself unless the user explicitly asks. When a turn makes no change
to the repository (a question, an investigation, a read-only analysis), do not
propose a commit message at all.

## No en/em dashes

Never use the en dash (–) or em dash (—) in anything written: code strings,
comments, docs, prompts, commit messages, and chat replies. Always use the
plain hyphen (-) instead.
