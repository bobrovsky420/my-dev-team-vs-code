# My Dev Team - How-to guide

This is the full end-user guide. If you have just installed the extension and
only want the shortest path to a working chat, start with
[QUICKSTART.md](QUICKSTART.md) and come back here for the details.

My Dev Team is an AI chat participant for VS Code. You talk to it as
`@devteam` in the normal chat panel, and it can answer questions, draft
step-by-step plans, and carry them out: reading, searching, creating, and
editing files in your workspace and running shell commands - asking you first
before it runs a command (file changes apply directly to your Git-backed
workspace, where they are easy to review and revert). It is geared to software
development and code analysis - it answers your coding questions and the
everyday work around them (naming things, a commit message, explaining a
concept), and keeps a personal or off-topic aside brief before steering back to
the work rather than acting as a general chatbot. Out of the box everything
runs locally against your own [Ollama](https://ollama.com) server and nothing
leaves your machine; if you prefer, you can also point it at a cloud model
(OpenAI, Anthropic, Groq, DeepSeek, Z.AI, or Kimi) by adding an API key - see
[Choosing a model](#4-choosing-a-model).

It is meant to work alongside GitHub Copilot, not just replace it (though you
can use it as a replacement if you want). Because it sits in the same chat
panel and can run on a free local model, it is a handy companion: send the
quick, throwaway, or exploratory questions to `@devteam` so you do not burn
through your Copilot budget on them, and when that budget is used up and
Copilot chat stops responding, `@devteam` keeps answering.

## 1. What you need

- **VS Code** 1.95 or newer
- **Node.js** 20.x - only if you want to build the extension yourself; not
  needed to install a `.vsix` someone gave you
- **Ollama** installed and running locally, with these models pulled:

  ```bash
  ollama serve                 # listens on http://localhost:11434
  ollama pull qwen3:8b
  ollama pull qwen3:14b
  ollama pull qwen3-coder
  ollama pull gemma3:4b
  ```

  If your Ollama server listens somewhere else, set the
  `myDevTeam.ollama.endpoint` setting (see [Settings](#7-settings)).

  Cloud models (OpenAI, Anthropic, Groq, DeepSeek, Z.AI, Kimi) are optional and need only an API key,
  no Ollama pull - see [Choosing a model](#4-choosing-a-model).

## 2. Install

The extension is not on the marketplace yet. You install it from a packaged
`.vsix` file - either one you were given, or one you build yourself.

### Install a `.vsix` you were given

If you received a file like `my-dev-team-vs-code-0.39.1.vsix`, install it one
of two ways:

- **In VS Code:** open the Extensions view (**Ctrl+Shift+X**), click the
  **...** menu at the top of the view, choose **Install from VSIX...**, and
  pick the file.
- **From a terminal:**

  ```bash
  code --install-extension my-dev-team-vs-code-0.39.1.vsix
  ```

To update later, install the newer `.vsix` the same way - it replaces the old
version. Reload VS Code if it asks you to.

### Build the `.vsix` yourself

If you have the source instead, build the package (needs Node.js 20.x):

```bash
npm install
npm run build
npx @vscode/vsce package
```

That writes a `my-dev-team-vs-code-<version>.vsix` into the project folder;
install it with either method above.

After installing, open a workspace folder and you are ready to use `@devteam`.
On startup the extension checks your Ollama server and warns you if it is
unreachable or one of the models above is missing - if you see no warning,
you are good to go. If you have set everything up to run on a cloud provider
instead (no local models in use), it skips this check and stays quiet about
Ollama.

## 3. First steps

Open the Chat view (**Ctrl+Alt+I**) and address the participant:

```
@devteam hello
```

Then try a real request:

- **Ask a question** - the reply streams straight into the chat:

  ```
  @devteam what does a .gitignore file do?
  ```

- **Have it build something** - it drafts a numbered plan, then executes it
  step by step:

  ```
  @devteam create a console calculator in calculator.py with add, subtract, multiply and divide
  ```

- **The file you have open is included automatically** - so you can just say
  "explain the current file" or "fix this", and if you have text selected, only
  that selection is sent. You do not need to attach anything for the agent to
  know what you are looking at. To turn this off, switch off
  `myDevTeam.attachActiveEditor` (see [Settings](#7-settings)).

- **Attach more context** - use the paperclip (or `#`-references) to attach
  other files, a selection, or a symbol; the agent receives their full text. A
  really huge file (tens of megabytes) is skipped with a note - attach a
  selection from it instead.

- **Point at your code inline** - type these markers anywhere in your message
  and the agent pulls in the matching context for you:

  - `#codebase` - searches your workspace for code relevant to your message and
    attaches the matching files (with a peek at the top ones), so you do not
    have to find and attach them yourself.
  - `#changes` - attaches your uncommitted git changes, handy for "review what
    I changed" or "fix the bug I just introduced".

  ```
  @devteam where is the retry logic? #codebase
  @devteam review my work so far #changes
  ```

- **Follow up** - the conversation carries over, so "now rename it too" or
  "add a test for that" resolves against what was just done.

- **Set standing rules** - put an `AGENTS.md` (or `CLAUDE.md`) file in your
  project root with your conventions ("always run the tests", "use tabs",
  "never touch the generated folder") and the agent follows them on every
  request - no need to repeat them in chat. Edits to the file take effect on
  your very next message. If both files exist, `AGENTS.md` wins.

- **Add a skill** - a skill is a named set of instructions for a specific kind
  of task (how to write a commit message, how your team formats a migration)
  that the agent loads only when a task matches. Skills are entirely yours - the
  extension ships none of its own. To add one, create a folder under
  `.devteam/skills/` (or `.claude/skills/`) in your workspace with a `SKILL.md`
  file in it:

  ```
  .devteam/skills/migration/SKILL.md
  ```

  Start the file with a short header naming the skill and when it applies, then
  write the instructions:

  ```
  ---
  name: migration
  description: How to write a database migration in this project - use when adding or changing a migration.
  ---

  Put migrations in db/migrate, name them with a timestamp prefix, and always
  write a matching down migration...
  ```

  The same folders are also checked in your **home directory**
  (`~/.devteam/skills/` and `~/.claude/skills/`), so a skill you want in every
  project lives there instead of in one workspace. If a project skill and a
  personal skill share a name, the project one wins.

  The agent sees the name and description of every skill, and pulls in the full
  instructions only when a task matches the description - so unrelated requests
  are unaffected. Edits take effect on your next message. Change where skills
  are looked for with `myDevTeam.skills.directories` (see [Settings](#7-settings)).

- **Connect an MCP server** - an MCP (Model Context Protocol) server gives the
  agent extra tools beyond reading, searching, and editing your files - for
  example a database, a browser, or an issue tracker. List the servers you want
  in the `myDevTeam.mcp.servers` setting, as a name to definition map. For
  example, to let the agent work with files through the standard filesystem
  server:

  ```json
  "myDevTeam.mcp.servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
  ```

  Each server is started in the background; its tools appear to the agent named
  `mcp__<server>__<tool>` (e.g. `mcp__filesystem__read_file`). **Every MCP tool
  call asks for your approval first** - the same Approve/Allow All/Decline prompt
  the run command uses, with Allow All scoped to that one tool - because an MCP
  server is third-party code. Servers are launched
  once when you start using the chat, so after adding or changing one, reload the
  window (the "Developer: Reload Window" command). MCP servers are not contacted
  at all in a workspace you have not trusted.

The agent decides on its own how to handle your request: a question gets
answered directly in the chat; a **small, clearly-described change** (a few
lines, or one little function) is made straight away, with just an execution
transcript - no plan needed; and a **larger change** is planned first, then
executed. You watch the plan (when there is one) and an execution transcript
stream into the chat as it happens. On a longer task it also prints a
**Progress** checklist from time to time - the plan steps with each one ticked
off as it goes - so you can see where it stands without reading every tool call.

If you want to approve every change before it runs, set `myDevTeam.planApproval`
to **always** (see the settings table): a small direct change is then turned
into a plan too, so there is always something to approve first.

Sometimes a request is genuinely unclear - it could mean two different things,
or it leaves out something only you can decide. Rather than guess, the agent may
**ask you first**: instead of an answer or a plan, the reply is one short
question (sometimes two), each with a few suggested answers. Click a suggestion
to send it, or just type your own reply - either way your answer continues the
work on the next message, with the agent now knowing what you meant. It asks
sparingly, only when it really cannot tell; if you would rather it always make a
reasonable assumption and get on with it, turn this off by setting
`myDevTeam.clarify.enabled` to **false**.

While it is **drafting a plan** for a larger change, the agent can also pause to
ask you a quick question the same way - it now reads and searches your project
first so the plan fits what is actually there, and if it hits a real fork it
cannot decide (which of two features you mean, an approach only you can choose)
a small pop-up appears with the choices, plus an "answer in your own words"
option. Pick one and it keeps drafting straight away; dismiss it and the agent
just makes a reasonable assumption instead. It is the same "ask only when it
really matters" behaviour, now during planning rather than only before it.

On a long task the agent also **checks in with you** so it never runs on and on
without a word: every so often it pauses and shows a **Still working - Keep
going or Stop & summarize?** line with two links. Click **Keep going** and it
carries on; click **Stop & summarize** and it wraps up right there, giving you
its best answer from the work it has already done instead of stopping cold. By
default it checks in roughly every 100 steps (or after 10 minutes on a slow
task); you can change how often, or turn it off, with
`myDevTeam.executor.checkpointEverySteps` and
`myDevTeam.executor.checkpointEverySeconds` (set either to `0` to disable that
trigger - see [Settings](#7-settings)). If you do nothing and just keep working
elsewhere, the task keeps going on its own.

On a long task that reads a lot, the agent also warns you when it is filling up
the model's **context window** - a line like "Context ~90% full" - so you know
it is getting close to the model's limit. Each warning comes with a **Compact
now** action you can click to summarize the conversation so far and free up the
window (the same thing `/compact` does). And when it gets very close (95% by
default), the conversation **compacts itself automatically** on your next
message: that message opens with a short summary standing in for everything
before it, so the session never silently overflows. You can change the level
this happens at with `myDevTeam.history.autoCompactThreshold`, or turn the
automatic part off with `myDevTeam.history.autoCompact` (leaving you the Compact
now button and `/compact`). The levels it warns at are configurable too
(`myDevTeam.executor.contextWarnThresholds`). For a local model, set its real
window size with `myDevTeam.modelContextWindows` (e.g. `{"qwen3-coder": 32768}`)
so the percentage is accurate - a local server only uses the size it was started
with, which the built-in estimate cannot know.

If the model you are using is a "thinking" model, you see VS Code's own progress
indicator while it works - the usual rotating **Thinking** / **Generating** label,
not its inner monologue. It disappears once the real answer or transcript arrives.
When the model is done, a small **Thought for 12s** line is added under the reply
so you can see how long it spent thinking. Don't want the duration line? Turn off
`myDevTeam.thinking.showDuration`. Turning off `myDevTeam.thinking.showInChat`
stops the extension capturing the reasoning at all, which also removes the
duration line (the progress indicator still shows either way; see
[Settings](#7-settings)).

## 4. Choosing a model

By default the model is **Auto**: My Dev Team picks the best available model
for each part of your request, and shows you what it chose on a **Model:** line
under each reply. (When it works through a plan, the model running the steps is
named in the **Execution** section instead, since that choice is only made once
the plan is ready.) To change it, type **`/model`** in the chat (or use the
**My Dev Team** button in the status bar at the bottom of the window: hover it
for a popup that shows the active model, the current routing mode, the current
output mode, and the session token total with a **Select model** link, or click
it and choose **Select model**) and pick from the list - or type the name
directly, e.g. `/model Claude Sonnet 4.6`.

The same hover and menu also let you switch the **routing mode** (a **Select
routing mode** link / **Routing mode** row): **Classifier** (the default - a
quick triage step, then the answerer or planner) or **Combined** (one agent that
decides and answers-or-plans in a single step on your main model). See
`myDevTeam.triage.mode` in the settings table below.

The list is grouped so the common case is one click:

- **Use one provider for everything** (the top group) - **Auto**, or a provider
  like "Anthropic (best available)". Picking one here points the **whole team**
  at it: the quick internal triage step and the planning/coding agents all use
  it. This is the simplest way to "just use Anthropic" (or `ollama`, `openai`).
  Type `/model anthropic` (or `auto`) as a shortcut for the same thing.
- **Or pin one model** - always use that one specific model for the
  planning and the actual work (triage is left as it is).
- **Triage only (advanced)** - change just the quick triage step, leaving the
  work agents alone. Useful for a split setup, e.g. cheap local triage with a
  cloud model doing the work.

Out of the box the list is your local Ollama models. To use a cloud model, give
it an API key one of two ways:

1. **Run the "My Dev Team: Set API Key" command** (Ctrl+Shift+P) and paste your
   OpenAI, Anthropic, Groq, DeepSeek, Z.AI, or Kimi key. It is stored securely and never written to
   your settings file. This works with the default (local) engine.
   **Or** set the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, or `ZAI_API_KEY`
   environment variable before launching VS Code - the only option if you run
   the `sidecar` engine, which reads keys from the environment. If you switch to
   the `sidecar` engine while a key is set only via "Set API Key", a warning
   reminds you to set the matching environment variable (or switch back to the
   local engine), so the key does not silently stop working.
2. Pick the model with `/model` - cloud models you have a key for become
   selectable; the rest show as unavailable.

Notes:

- Pinning a specific model (the middle group) uses it for the planning and the
  actual work only. The quick internal "is this a question or a task?" step is
  left alone - by default it stays on a fast local Ollama model, so it costs you
  nothing. If you have no Ollama server, point triage at a cloud provider (or a
  local llama.cpp server) from the **Triage only** group, the `/model` shortcut
  for a provider/Auto (which sets both at once), or the `myDevTeam.triage.model`
  setting (e.g. `provider:openai`, or `provider:llamacpp` - see "Running a local
  model without Ollama" below); see [Settings](#7-settings).
- **Auto sizes the model to the job.** When the model is Auto (or you picked a
  provider rather than one fixed model), My Dev Team also judges how demanding a
  task is and uses a cheaper/smaller model for simple work (e.g. "write a
  command-line calculator") and a stronger one for hard work (multi-file
  changes, tricky debugging). The reply shows a **Complexity:** line with the
  plan so you can see what it decided (it refines its first guess once it has
  looked at the work). Pinning one specific model turns this off for that model;
  the `myDevTeam.complexityRouting` setting turns it off entirely.
- **Auto** only uses a cloud model once you have set its key; until then it
  stays on your local models. Add a key and Auto will start preferring the
  stronger cloud model on its own.
- Using a cloud model sends your request to that provider. Local Ollama models
  keep everything on your machine.
- **Turning a provider or model off.** If you never want a particular provider
  or model used, add it to `myDevTeam.disabledProviders` (e.g. `["anthropic"]`)
  or `myDevTeam.disabledModels` (e.g. `["qwen3-coder"]`). A disabled choice shows
  as disabled in the `/model` list and never runs - even if you had it pinned,
  the request quietly falls back to Auto among what is left. (Some builds also
  turn providers or models off for everyone; those you cannot switch back on from
  settings.)
- **Adding a model the build does not ship.** When a provider releases a new
  model and you do not want to wait for an extension update, add it yourself in
  the `myDevTeam.customModels` setting (Settings -> "My Dev Team" -> Custom
  Models, or `settings.json`). Each entry needs an `id` you choose, a `label` to
  show in the list, a `provider` already supported (`anthropic`, `openai`,
  `ollama`, `llamacpp`, `groq`, `deepseek`, or `zai`), and the provider's own `model` name. For
  example, a brand-new Anthropic model:

  ```json
  "myDevTeam.customModels": [
    {
      "id": "claude-opus-9",
      "label": "Claude Opus 9 (Anthropic)",
      "provider": "anthropic",
      "model": "claude-opus-9-20990101"
    }
  ]
  ```

  It then appears in the `/model` list straight away - pick it like any other
  (a cloud model still needs that provider's API key, set the same way as above).
  You can only add models for a provider that is already supported, and you
  cannot replace a model the build ships (an entry whose `id` matches a built-in
  is ignored). Optionally add a `tier` (`simple`/`moderate`/`complex`) and
  `capabilities` scores if you want **Auto** to consider it; without them it is
  still fully usable when you pick it directly.
- For Azure or another gateway, set `myDevTeam.openai.baseUrl`,
  `myDevTeam.anthropic.baseUrl`, `myDevTeam.groq.baseUrl`,
  `myDevTeam.deepseek.baseUrl`, or `myDevTeam.zai.baseUrl` to its URL (see
  [Settings](#7-settings)). (Some builds pin a provider's endpoint - including
  the Ollama server - for everyone; that takes precedence over these settings.)

### Running a local model without Ollama

If you would rather not install Ollama, My Dev Team can also talk to a local
**llama.cpp** server (`llama-server`), which serves a model you download
yourself.

**Install llama-server:**

1. Get `llama-server` from llama.cpp. The easiest options:
   - **Windows:** install with `winget install ggml.llamacpp`, or download a
     prebuilt release `.zip` from the
     [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases)
     and unzip it.
   - **macOS:** install with `brew install llama.cpp`.
   - **Linux:** download a prebuilt release from the same releases page, or build
     it from source.
2. Start the server, picking a small model - it downloads on first run:

   ```
   llama-server -hf ggml-org/Qwen2.5-Coder-1.5B-Instruct-Q8_0-GGUF
   ```

   By default it listens on `http://localhost:8080`. Leave it running while you
   use My Dev Team.

   To swap in a different model, pick a **GGUF** build (the only format
   `llama-server` loads) and prefer an **Instruct** (chat-tuned) variant: My Dev
   Team asks the model for results in a specific shape, and instruct models
   follow those output-format instructions where base/completion models do not.

Then point My Dev Team at that server:

1. Set `myDevTeam.llamacpp.endpoint` to the server's address (origin only, no
   `/v1`); the default is `http://localhost:8080`. If you started `llama-server`
   with `--port`, use that port instead.
2. To use it for the quick triage step, set `myDevTeam.triage.model` to
   `provider:llamacpp`.

No API key is needed - it is a local server, like Ollama. The bundled llama.cpp
model is a small one, so it is set up for triage only: Auto will not use it for
planning or the actual work, only the quick triage step. If you really want it to
do the work too, pick it from the `/model` list (it shows with the "(llama.cpp)"
suffix, e.g. "Qwen2.5 Coder 1.5B (llama.cpp)") - choosing it there overrides the
triage-only default. Heavier planning and coding still do better on a larger
Ollama model or a cloud model.

## 5. Slash commands

Type `/` after `@devteam` to pick a command. A command skips the automatic
question-vs-work decision and tells the agent exactly what kind of help you
want:

| Command    | What it does                                                        |
| ---------- | ------------------------------------------------------------------- |
| `/ask`     | Ask a quick side question - answered directly, and it never joins the conversation (typing `btw ...` does the same) |
| `/explain` | Explain a file, selection, or concept in the chat - no changes made |
| `/review`  | Review the attached code or selection - findings in chat, no edits  |
| `/plan`    | Draft the step-by-step plan but do not execute it; say "go ahead" in a follow-up to run it |
| `/do`      | Plan and execute workspace changes - skip straight to doing         |
| `/fix`     | Diagnose a bug, fix its root cause, and verify the fix              |
| `/test`    | Write or update tests for the target code, then run them            |
| `/compact` | Summarize the conversation so far; the summary then stands in for it in future turns |
| `/clear`   | Start fresh: drop the conversation so far from future requests      |
| `/model`   | Choose the model (or Auto); see [Choosing a model](#4-choosing-a-model) |
| `/verbose` | Choose how much each reply shows: `verbose` (everything) or `default` (terser); see [Settings](#7-settings) |

Commands work in follow-ups too: `/explain what you just did` refers back to
the earlier turns.

`/compact` and `/clear` manage the conversation context. Long sessions are
capped (only the most recent turns travel with each request), so on a long
task old decisions silently fall away - `/compact` condenses them into one
summary the agent keeps seeing, while `/clear` is for changing topic without
opening a new chat. The chat panel still shows everything; the commands only
change what the models receive. To preserve as much as possible, `/compact`
summarizes from the whole conversation (not just the recent turns) and prefers a
model with a large context window, fitting in as much history as that window
allows. If you run a big-window model locally, set its real window with
`myDevTeam.modelContextWindows` so the summary can use all of it. If a `/compact`
fails (e.g. Ollama is down), your history is untouched - the summary only takes
over once it actually succeeded.

### Side questions: "btw ..."

Mid-task curiosity ("how do I sort an array in Python?") does not have to
derail the work. Start a message with `btw` (or use `/ask`) and it is treated
as a **side question**: answered right there in the chat, but kept out of the
conversation - the agent's next turn neither sees the question nor the answer,
so a follow-up like "now do step 3 differently" still refers to the real work.
Only a leading `btw` counts; a sentence merely containing "btw" is handled
normally.

One consequence to know: because a side question never joins the conversation,
its answer cannot be followed up on either - "and in reverse order?" as the
next message would arrive with no memory of the sorting question. Ask side
questions self-contained.

### Ask while the agent is busy: the quick-question hotkey

While a long `@devteam` turn is still running, the chat input is held by that
turn - but you can still ask on the side. Press `Ctrl+Alt+Q` (`Cmd+Alt+Q` on
macOS), or run **My Dev Team: Ask a Quick Question** from the command palette,
type your question, and the answer opens in a small read-only preview beside
your editor while the main task keeps running undisturbed. The notification
that appears while it thinks has a Cancel button. These questions are
answered from the model's knowledge alone - they never read or change your
files - and their tokens count in the session total like any other request.

Tip: a second chat session (the `+` button in the Chat view, or a chat in a
new window) can also talk to `@devteam` in parallel; use `/ask` there for the
same keep-it-out-of-the-conversation behavior.

**From the editor, without typing `@devteam`.** Three shortcuts open the chat
for you with the right command already filled in, so you can start from the
code you are looking at:

- **Fix with Dev Team** - hover a squiggle (a warning or error) and open the
  lightbulb / Quick Fix menu (`Ctrl+.`); pick **Fix with Dev Team** to send
  `/fix` with the problem and your uncommitted changes attached.
- **Explain with Dev Team** - select some code, right-click, and choose
  **Explain with Dev Team** to send `/explain` with that selection.
- **Write/repair tests** - open a test file (one named like `*.test.ts`,
  `*_test.go`, `test_*.py`, or under a `tests/` folder) and click the
  **Write/update tests** lens at the top; if the file currently shows errors it
  reads **Repair tests** instead. Either way it sends `/test`.

Each one opens the chat and runs that command for you; everything from there
(approvals, the streamed reply, follow-ups) works exactly as if you had typed
it yourself.

## 6. Approvals: you stay in control

**Approving the plan.** For demanding work, My Dev Team shows you the plan and
waits for your go-ahead before it changes anything. By default this happens only
when it judges a task **complex** (multi-file changes, tricky debugging); you get
three buttons:

- **Approve** - carry the plan out.
- **Cancel** - keep the plan but run nothing; say "go ahead" later to run it.
- **Revise** - type a comment ("split this into smaller steps", "don't touch the
  config") and the plan is redrafted and shown again.

For a big or complex plan, the full plan also opens as a **read-only preview** in
the editor beside the chat, so you can read all the steps - and, for a complex
change, the key design decisions behind them - on a proper page while you decide.
The preview is just for reading; the Approve/Cancel/Revise buttons stay in the
chat, and it closes itself once you choose. Nothing is saved to your project.

You can change when this happens with two settings:

- `myDevTeam.planApproval` - when My Dev Team pauses for approval at all: `auto`
  (the default, complex plans only), `always` (every plan), or `never` (run plans
  straight through). The `/plan` command always stops at the plan regardless.
- `myDevTeam.planApproval.preview` - when the editor preview opens: `auto` (the
  default, only a big plan), `always` (every plan it pauses on), or `never`
  (review in the chat only).

**Approving a command.** Running a shell command stops and asks you first, right in the chat: a
**Run Command** prompt shows the exact command, and you click **Approve** to
let it run, **Allow All** to let it and every later command run without asking,
**Always allow `…`** to let that kind of command run without asking from now on
(see below), or **Decline** to skip it. Declining does not abort the run: the
agent is told the command was not approved, carries on with the rest of the
plan, and notes the skip in its report. If you have more than one folder open
(a multi-root workspace), the prompt also names the folder the command will
run in.

**Skip the prompt for commands you trust.** If you find yourself approving the
same safe commands over and over (`npm test`, `git status`, `tsc`), you have two
ways to stop being asked. Clicking **Always allow `git status`** on a prompt
remembers that command for good - it is added to the
**`myDevTeam.run.allowedCommands`** list and runs without asking in every future
chat and session (not just this one). You can also edit that list yourself: each
entry is a command start or a pattern with `*`, for example `git status`,
`npm test`, or `npm run *`. Only a single, plain command is ever skipped this
way - a command that chains or pipes (`npm test && rm -rf build`) always asks,
and so does any command on the destructive list below, no matter what you have
allowed.

**Destructive commands stand out.** When the agent judges a command destructive
or irreversible - one that deletes or overwrites files, rewrites or force-pushes
Git history, resets your working state, or drops data (for example `rm -rf` or
`git reset --hard`) - the prompt is marked **"Run destructive command"** with a
warning, so you can tell it apart at a glance before approving. My Dev Team also
keeps its **own** list of risky commands - both POSIX (`rm`, `git push`,
`git reset`, `curl`, `wget`, ...) and the PowerShell equivalents on Windows
(`Remove-Item`, `Stop-Computer`, `Invoke-Expression`, `Format-Volume`, ...) -
that always show this warning and always ask - even if the
agent did not flag the command and even if you have allowed or "Allow All"-ed
ordinary commands. This is a safety net: it means a command that slipped through
the agent's own judgement still cannot run a destructive or network action
silently. You can add your own patterns with **`myDevTeam.run.deniedCommands`**;
the built-in ones cannot be removed.

**Allow All** remembers your choice only for the current chat and only for that
one kind of action: allowing all commands does not also allow file writes, and
each MCP tool is remembered on its own. Destructive commands are remembered
separately too - clicking **Allow All** on an ordinary command never lets a
destructive one through; that still asks, and its own **Allow All** is saved on
its own. It works the other way round, though: choosing **Allow All** on a
destructive command also stops ordinary commands from asking, since you have
already accepted the riskier ones. Starting a new chat (or running `/clear`)
forgets every "Allow All" and asks again, so the allowance can never outlive the
conversation you gave it in.

Reading, searching, writing, and editing files do not ask by default - they
apply directly. Writing and editing are safe to run unprompted because your
workspace is backed by Git: if the agent changes a file you did not want
changed, you can see it in your source-control view and revert it like any
other edit. (Commit or stash work you want to be sure of first; Git cannot
restore changes that were never committed.) The agent only touches files
inside your workspace folders - it cannot reach outside them, and it will not
write to or edit a few protected locations that can run code on their own:
`.git/` (always) and, by default, `.vscode/`. You can change the protected
list with the `myDevTeam.write.protectedPaths` setting.

If you would rather confirm every file change, turn on
**`myDevTeam.approval.fileChanges`**: each write and edit then shows the same
**Approve** / **Allow All** / **Decline** prompt as a command, naming the file,
and the change lands only when you approve. The run-command gate is always on
regardless of this setting.

Cancelling the chat request (the stop button) cancels everything, including a
command already running and any file change still in flight.

If you open a folder you have **not trusted** (VS Code's Restricted Mode), the
agent can still answer questions and read and search your files, but running
commands, writing, and editing are turned off until you trust the workspace.
In a **virtual workspace** (for example a repository opened in the browser),
everything works except running shell commands, which needs a real local
filesystem. In both cases the agent simply tells you why it could not do the
action.

Every approved command's full live output also appears in a read-only
**"Dev Team" terminal** in the terminal panel - open that tab to watch
commands run or to read the session log afterwards; the chat itself only
shows short previews.

## 7. Settings

Open Settings and search for "My Dev Team" (or edit `settings.json`).
Changes take effect immediately - no reload needed. This is also how you point
the extension at different servers or gateways: the endpoint settings below
(`myDevTeam.ollama.endpoint` and the cloud `*.baseUrl` settings) are plain VS
Code settings, so even if you installed from a packaged `.vsix` you just edit
them here - there is nothing to rebuild or reinstall. The ones you are most
likely to touch:

| Setting                          | Default                  | What it controls                                  |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `myDevTeam.model`                | `auto`                   | Which model, provider (`provider:<name>`), or `auto` to use; easier to set with `/model` or the **My Dev Team** status button |
| `myDevTeam.triage.model`         | `""`                     | What the quick triage step uses, kept separate from the model above. Easiest to set from the `/model` list's **Triage only** group (or a provider/Auto pick, which sets both). Empty follows your main model when it names a provider or model (so picking a cloud provider carries triage along), otherwise the build's default (a local Ollama model); set `provider:llamacpp` (a local llama.cpp server), `provider:openai` (or `anthropic`/`groq`/`deepseek`/`zai`), `auto`, or a model id to route triage differently. A provider/model the build disabled cannot be chosen. Not used in `combined` triage mode |
| `myDevTeam.triage.mode`          | `classifier`             | How a request is routed. `classifier` (the default) runs a quick triage step and then the answerer or planner. `combined` instead uses one agent that decides and answers-or-plans in a single step on your main model - a little faster, and it can never get "stuck" deciding a request is just a question when it really needed a change. Slash commands (`/fix`, `/plan`, ...) are unaffected |
| `myDevTeam.complexityRouting`    | `true`                   | Let Auto size the model to how hard the task is (cheaper for simple work, stronger for complex). Turn off to ignore difficulty; a pinned model is never affected |
| `myDevTeam.planApproval`         | `auto`                   | When to pause for you to approve a plan before it runs: `auto` (complex plans only), `always` (every plan), or `never`. At the prompt you can Approve, Cancel, or Revise (comment and redraft) |
| `myDevTeam.planApproval.preview` | `auto`                   | When a paused plan also opens as a read-only preview in the editor: `auto` (only a big plan), `always` (every plan it pauses on), or `never` (review in the chat only). The Approve/Cancel/Revise buttons always stay in the chat |
| `myDevTeam.verbosity`            | `verbose`                | How much each reply shows: `verbose` (the default - the agent's full reasoning: triage's intent, reason and complexity, the plan with step details, and the output each tool shows in the transcript - file contents, search matches, command output) or `default` (terser - the detected intent, the plan's summary and step titles, and each tool action showing just the tool name and what it acted on, like the file name, search query, or command). A failed action still shows its error in either mode. Easiest to switch with `/verbose` or the **My Dev Team** status button's menu. A display choice only - it changes nothing the agents do |
| `myDevTeam.attachActiveEditor`   | `true`                   | Automatically include the file you have open (or just your selection) as context on every request, so "the current file"/"this selection" works without attaching anything. On by default; turn it off to send nothing automatically (you can still attach files yourself) |
| `myDevTeam.disabledProviders`    | `[]`                     | Providers to never use (e.g. `["anthropic"]`); shown disabled in `/model` and never run, even if pinned or keyed |
| `myDevTeam.disabledModels`       | `[]`                     | Individual models to never use (e.g. `["qwen3-coder"]`); same as above but per model |
| `myDevTeam.customModels`         | `[]`                     | Extra models to register without updating the extension (e.g. a newly released Anthropic model): each entry needs an `id`, `label`, supported `provider`, and the provider's `model` name. Appears in `/model`; add-only - cannot replace a built-in. See [Choosing a model](#4-choosing-a-model) |
| `myDevTeam.ollama.endpoint`      | unset (uses `http://localhost:11434`) | Where your Ollama server listens. Leave blank for the default your install ships with (localhost if none); set it to point at your own server |
| `myDevTeam.llamacpp.endpoint`    | unset (uses `http://localhost:8080`) | Where your local llama.cpp server (`llama-server`) listens, origin only (no `/v1`). Lets you run a small local model without Ollama; see "Running a local model without Ollama" |
| `myDevTeam.openai.baseUrl`       | `""`                     | Custom OpenAI endpoint (Azure / compatible gateway); empty uses OpenAI's default |
| `myDevTeam.anthropic.baseUrl`    | `""`                     | Custom Anthropic endpoint (a proxy/gateway); empty uses Anthropic's default |
| `myDevTeam.groq.baseUrl`         | `""`                     | Custom Groq endpoint (a proxy/gateway); empty uses Groq's default |
| `myDevTeam.deepseek.baseUrl`     | `""`                     | Custom DeepSeek endpoint (a proxy/gateway); empty uses DeepSeek's default |
| `myDevTeam.zai.baseUrl`          | `""`                     | Custom Z.AI endpoint (the GLM models, a proxy/gateway); empty uses Z.AI's default (`https://api.z.ai/api/paas/v4`) |
| `myDevTeam.kimi.baseUrl`         | `""`                     | Custom Moonshot Kimi endpoint (a proxy/gateway); empty uses Kimi's default (`https://api.moonshot.ai/v1`) |
| `myDevTeam.provider.requestsPerMinute` | unset              | Your cap on requests per minute sent to each provider, to stay under its rate limit (e.g. a free-tier quota). Leave unset to use whatever rate your deployment ships with; set a number to override it, or `0` for no cap |
| `myDevTeam.run.commandTimeoutMs` | `60000`                  | How long a shell command may run before it is killed |
| `myDevTeam.run.allowedCommands`  | `[]`                     | Commands the agent may run without asking, as a command start or `*` pattern (e.g. `git status`, `npm test`, `npm run *`). The **Always allow** approval button adds to this. Only single, non-chained commands skip the prompt; a risky command (below) never does |
| `myDevTeam.run.deniedCommands`   | `[]`                     | Extra command patterns that always ask and always show the destructive warning, on top of a built-in list (`rm`, `git push`, `curl`, ...) you cannot remove. These are never skipped by an allowed command or an "Allow All" |
| `myDevTeam.chat.toolSnippetLines`| `5`                      | Lines of a written file previewed in the chat transcript (`0` hides the preview) |
| `myDevTeam.executor.checkpointEverySteps`   | `100`         | On a long task, how many steps between **Still working - keep going or stop?** check-ins (`0` turns the step-based check-in off) |
| `myDevTeam.executor.checkpointEverySeconds` | `600`         | On a long task, how many seconds between check-ins (`0` turns the time-based check-in off). Whichever of steps/seconds comes first triggers the check-in |
| `myDevTeam.executor.contextWarnThresholds`  | `[75, 85, 95]`| Context-fill levels (percent of the model's window) at which a "Context ~X% full" caution appears during a long run; each below the auto-compact level also offers a "Compact now" action |
| `myDevTeam.history.autoCompact`             | `true`        | Automatically compact the conversation when context gets very full: your next message opens with a summary of everything before it, so a long session never silently overflows. Turn off to only compact via the "Compact now" action or `/compact` |
| `myDevTeam.history.autoCompactThreshold`    | `95`          | How full the context must get (percent of the model's window) before the conversation auto-compacts on your next message; below it, a warning only offers "Compact now" |
| `myDevTeam.modelContextWindows`             | `{}`          | The context-window size (tokens) per model id, e.g. `{"qwen3-coder": 32768}` - set this for a local model so the context warning is accurate |
| `myDevTeam.usage.showInChat`     | `true`                   | Show the **Tokens** line under each reply; the status button's session total and the usage report stay regardless |
| `myDevTeam.changes.showInChat`   | `true`                   | Show the **Changes** line ("N files changed, +X -Y") under a reply that wrote files; it only appears when a turn changed files |
| `myDevTeam.summary.showInChat`   | `true`                   | After a task that changed files, show a **Summary** recap in three sections (What ships, How it's built, Tests and docs). Turning it off skips the extra summarizing step |
| `myDevTeam.thinking.showInChat`  | `true`                   | Capture a reasoning model's thinking so its duration can be timed. The live indicator while it works is VS Code's own built-in progress (the rotating **Thinking** / **Generating** label), shown either way; turning this off just stops capturing the reasoning, which also removes the **Thought for Ns** line |
| `myDevTeam.thinking.showDuration`| `true`                   | After a reasoning model finishes, show a small **Thought for Ns** line under the reply with how long it spent thinking. Needs `thinking.showInChat` on to have timed anything |
| `myDevTeam.clarify.enabled`      | `true`                   | Let the agent ask you a quick question (with clickable suggested answers) when a request is genuinely ambiguous, instead of guessing. Turn it off to have it always make a reasonable assumption and proceed |
| `myDevTeam.instructions.files`   | `["AGENTS.md", "CLAUDE.md"]` | Which project files in your workspace root hold standing rules for the agent; the first one found is used. An empty list turns the feature off |
| `myDevTeam.skills.directories`   | `[".devteam/skills", ".claude/skills"]` | Where to look for your skills, each at `<folder>/<name>/SKILL.md` - checked in your workspace and your home directory. An empty list turns off your own skills (the built-in ones still work) |
| `myDevTeam.mcp.servers`          | `{}`                     | MCP servers whose tools the agent may call, as a name -> `{ command, args, env }` map. Launched over stdio; every call asks for your approval. Not contacted in an untrusted workspace; reload the window after changing it |
| `myDevTeam.write.protectedPaths` | `[".vscode"]`            | Folders the agent will not write to or edit, on top of the always-protected `.git` (these can run code on their own). Add your own; an empty list keeps only `.git` protected |
| `myDevTeam.approval.fileChanges` | `false`                  | Ask you to approve every file write and edit (same Approve/Allow All/Decline prompt as a command). Off by default - changes apply directly since your workspace is Git-backed. Running commands is always gated regardless |
| `myDevTeam.telemetry.evalLog`    | `false`                  | Opt-in local log of runs and 👍/👎 feedback - stays on your machine, records no prompts or file contents |
| `myDevTeam.telemetry.shadowTriage` | `false`                | While the log is on, also check on each `/command` run how the router would have classified it, so the usage report can show how often it agrees. Adds a small background step per command run |
| `myDevTeam.engine`               | `local`                  | Where the agent runs: `local` (inside the extension) or `sidecar` (a separate process); see [Local vs sidecar engine](#local-vs-sidecar-engine). Takes effect on your next request |
| `myDevTeam.debug`                | `false`                  | Write a detailed log of everything a request does to the **My Dev Team (Debug)** output panel; see [Debug logging](#debug-logging). Off by default - turn it on only to diagnose a problem |

There are further knobs for read/search limits (`myDevTeam.read.*`,
`myDevTeam.search.*`).

### Local vs sidecar engine

Most people never touch this. The `myDevTeam.engine` setting picks **where** the
agent's "brain" runs - it does not change what `@devteam` does or which models
it uses:

- **`local`** (the default) - the agent runs inside the extension itself. This
  is what you want unless you have a reason not to.
- **`sidecar`** - the same agent runs in a separate background process. The
  parts you interact with (approval prompts, the chat transcript, file edits)
  stay in the editor; only the agent's reasoning is moved out into its own
  process, so a hiccup there cannot disturb the rest of VS Code.

To switch, open Settings, search for "My Dev Team", and set **Engine** to
`local` or `sidecar` (or edit `"myDevTeam.engine"` in `settings.json`). The
change takes effect on your **next message** - no reload needed.

One thing to know if you use a cloud model on the **sidecar** engine: it reads
API keys **only from environment variables** (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`), set before you launch VS Code - the
"My Dev Team: Set API Key" command does not reach it. If you switch to
`sidecar` while a key is stored only via that command, a one-time notice
reminds you to set the matching environment variable (or switch back to
`local`), so a cloud model does not quietly stop working. If the sidecar
process keeps crashing, the extension warns you once and falls back to the
local engine on its own until you switch engines or reload.

(A third value, `remote`, is reserved for running the agent on a remote server
and is not available yet - selecting it just falls back to `local` with a
warning.)

## 8. Token usage

Every reply ends with a **Tokens** line - how many tokens that request spent
(input and output). The **My Dev Team** button in the status bar keeps a running
**total for the session** (hover the button to see it, or read it on the
**Token usage** menu row); click the button and choose **Token usage**, or click
the **Token usage report** link in the hover, to open a **token usage report**: a
Highlights section (how much went to prompts vs answers, how often the prompt
cache helped, how many tokens sat behind your 👍/👎 votes, how fast runs were,
and - as you keep chatting - how much your prompts grow as the conversation
builds up), an **Input by source** table showing whether project instructions,
conversation history, or attachments are taking up your prompts, and breakdowns
by step, model, command, and day. Turn on `myDevTeam.telemetry.shadowTriage` and
it also reports how often the router agrees with the route your slash commands
pin. A `~` in front of a number means it includes an estimate, because the model
did not report exact counts.

- Don't want the per-reply line? Turn off `myDevTeam.usage.showInChat`. The
  status button's session total and the report stay.
- The report is built from the local log, so it only has data once you turn on
  `myDevTeam.telemetry.evalLog` (see below). Until then it tells you so.

When a request changes files, the reply also ends with a **Changes** line - for
example "4 files changed, +120 -30" - so you can see the size of the edit at a
glance, the way you would skim a pull request before reading it. It appears only
when files were actually written; turn it off with `myDevTeam.changes.showInChat`.

Right above that, a task that changed files gets a **Summary** recap in three
short sections - **What ships** (what the change delivers), **How it's built**
(the approach), and **Tests and docs** - so you get a pull-request-style
overview without rereading the whole transcript. It is written by a quick extra
step after the work is done, only when files changed; if you would rather skip
that step, turn off `myDevTeam.summary.showInChat`.

## 9. Feedback

Use the **👍 / 👎** buttons on any reply. With
`myDevTeam.telemetry.evalLog` enabled, your votes are stored locally next to
the run's routing and usage data, which helps tune the agents - nothing is
ever sent anywhere.

### Debug logging

If something is going wrong and you (or whoever is helping you) want to see
exactly what happened, turn on **`myDevTeam.debug`**. With it on, every request
writes a detailed log to a panel called **My Dev Team (Debug)**: open the
**Output** panel (View -> Output) and pick "My Dev Team (Debug)" from the
dropdown on the right. The log shows three things for each request:

- the message the chat client sends to the agent and the stream of updates it
  gets back,
- each tool the agent runs (read, search, run, write, edit) and its result, and
- each call to the AI provider, including the raw messages sent and the raw
  reply - whether the agent runs in the extension or as a separate process.

It is meant for diagnosing problems, so it is long and includes the raw content
of your request (your prompt, the file text it read, and the model's replies).
All of it stays on your machine - nothing is sent anywhere. Turn the setting
back off when you are done. The change takes effect on your next request. As a
reminder while it is on, hovering the **My Dev Team** status button shows a
"Debug mode: on" line.

## 10. Troubleshooting

- **"Ollama is unreachable" or a request fails on the first step** - make
  sure `ollama serve` is running and that `myDevTeam.ollama.endpoint`
  matches where it listens.
- **A request fails naming a model** - for a local model, pull it
  (`ollama pull <model>`); for a cloud model, the failure means its API key is
  missing or invalid - set it with "My Dev Team: Set API Key" or the provider's
  environment variable (see [Choosing a model](#4-choosing-a-model)).
- **A cloud model shows as unavailable in `/model`** - you have not set its API
  key yet; run "My Dev Team: Set API Key" (or set the provider's environment
  variable and restart VS Code).
- **A cloud request fails saying it was rate limited** - the extension already
  retries automatically after the wait the provider asks for, so brief limits
  recover on their own. If it still fails (a tight free-tier quota), set
  `myDevTeam.provider.requestsPerMinute` to slow the request rate, or upgrade
  your provider plan.
- **A command seems stuck** - long commands are killed after
  `myDevTeam.run.commandTimeoutMs` (60s by default); raise it for slow
  builds or test suites.
- **Replies feel slow** - the agents run on local models; speed depends on
  your hardware and the model sizes. Smaller models respond faster.
