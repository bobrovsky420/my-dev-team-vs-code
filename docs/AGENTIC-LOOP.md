# The agentic loop and agent routing

This document explains, with code references, how MyDevTeam turns one user
message into a reply: the multi-agent orchestration, the inner tool-calling
loop, and the two layers of routing (which agent handles a request, and which
model backs each agent).

There are two distinct "loops", living at different layers:

1. The **orchestration loop** - the multi-agent pipeline in
   [workflow.ts](../src/engine/core/workflow.ts). This is a directed graph of
   steps, not a `while` loop.
2. The **tool-calling loop** - the inner agentic loop where one agent (the
   Executor) repeatedly calls the model, runs tools, and feeds results back
   ([executor.ts](../src/engine/core/executor.ts)). This is the real `for(;;)`
   loop.

Cutting across both is **routing**, which happens at two levels: which agent
handles the request (triage / intent routing) and which model backs each agent
(the capability router).

---

## 1. The orchestration loop (the agent pipeline)

The whole pipeline is a [Mastra](https://mastra.ai) workflow built in
[createDevTeamWorkflow](../src/engine/core/workflow.ts#L632). The shape:

```
triage --> branch --> draft-plan       (intent === "planning")
       |          \-> answer-directly  (intent === "oneshot")
       v
          branch --> execute-plan      (a plan was drafted and not cancelled)
                 \-> deliver-answer    (oneshot / plan-only; pass-through)
```

Each box is a `createStep`, wired declaratively at the bottom of the file
([workflow.ts:1135-1159](../src/engine/core/workflow.ts#L1135)):

```ts
return base()
  .then(triageStep)
  .branch([
    [async ({ inputData }) => inputData.intent === 'planning', draftPlan],
    [async ({ inputData }) => inputData.intent === 'oneshot', answerDirectly],
    [async ({ inputData }) => inputData.intent === 'direct', directStage],
    [async ({ inputData }) => inputData.intent === 'clarify', clarifyStage],
  ])
  // branch() emits { [stepId]: output }; flatten to the single staged reply.
  .map(async ({ inputData }) =>
    inputData[stepIds.plan] ?? inputData[stepIds.answer] ??
    inputData[stepIds.direct] ?? inputData[stepIds.clarify])
  .branch([
    [shouldExecute, executePlan],
    [async (args) => !(await shouldExecute(args)), deliverAnswer],
  ])
  .map(async ({ inputData }) => inputData[stepIds.execute] ?? inputData[stepIds.deliver])
  .commit();
```

So the "loop" over agents is really a fan-out by intent, then a fan-out by
whether there is work to execute. Each step is a separate agent (Triage,
Planner, Answerer, Executor, Summarizer), and each agent gets its own model via
the router (section 3).

### The intents

Triage classifies every request into one of four intents
([triage.ts:11-26](../src/engine/core/triage.ts#L11)):

- **`oneshot`** - the deliverable is text (explanation, review). Goes to the
  **Answerer**, which streams an answer. Done.
- **`direct`** - a small, fully-specified change. Skips the planner and goes
  straight to the Executor with no plan.
- **`planning`** - a larger or uncertain change. Goes to the **Planner**, which
  drafts a plan, optionally gates for approval, then the Executor executes it.
- **`clarify`** - too ambiguous to route; the run terminates by asking the user
  questions instead of doing work.

### What carries between steps

Steps are pure data transforms with Zod input/output schemas - load-bearing for
the engine/client split (everything crossing must be wire-serializable). The
triage step emits a `TriagedSchema` (request + decision), the branch steps emit
a `StagedReplySchema`, and the final steps strip back down to the protocol's
`Reply`. The typed boundary at
[workflow.ts:359-366](../src/engine/core/workflow.ts#L359):

```ts
export type ReplyResult = Reply;
```

Using the protocol schema as the workflow's output schema is the guarantee that
the engine cannot emit a reply the contract does not describe.

### Side-channels (streaming, usage, thinking, approval)

The steps do not return progressively - they push through sinks passed via
Mastra's `RequestContext`, keyed by string
([workflow.ts:393-539](../src/engine/core/workflow.ts#L393)):

- `replyProgressKey` - streams reply snapshots (partial plan/answer/transcript)
  to the UI
- `usageSinkKey` - per-step token metering (the billing seam)
- `thinkingSinkKey` - a reasoning model's live `<think>` line
- `contextWarningKey` - "context window filling up" cautions
- `planReviewKey` - the approval gate callback
- `continueReviewKey` - the executor check-in callback
- `abortSignalKey` - cancellation

These are kept out of the reply schema deliberately - they are ephemeral or
client-bound, so they ride the context channel rather than widening the wire
contract.

### The plan approval gate

Inside the planning route, [gatePlan](../src/engine/core/workflow.ts#L577) is
its own small loop - draft, ask the user, redraft on revision, repeat:

```ts
let proceed = true;
while (gates(plan)) {
  sink?.({ ...view, plan });
  const decision = await review!(plan, plan.complexity ?? view.complexity ?? 'moderate');
  if (decision.kind === 'approve') break;
  if (decision.kind === 'cancel') { proceed = false; break; }
  plan = await redraft(revisionPrompt(inputData, decision.comment));
}
return { plan, proceed };
```

`gates()` consults `myDevTeam.planApproval`: `always` pauses on every plan,
`auto` only on `complex` ones. Cancelling sets `proceed: false`, which makes
`shouldExecute` route to `deliver-answer` (plan-only) instead of executing.

### Combined mode (an optimization)

A second workflow shape is selected by `myDevTeam.triage.mode = "combined"`
([workflow.ts:1121](../src/engine/core/workflow.ts#L1121)). Instead of triage +
draft-plan/answer as separate model calls, a single **Responder** step does
routing and produces the answer/plan in one call, committing its `intent`
mid-stream ([workflow.ts:879-924](../src/engine/core/workflow.ts#L879)). A
pinned slash command still falls back to the dedicated agents so `/plan` and
`/fix` keep their behaviour.

---

## 2. The tool-calling loop (the Executor)

This is the actual agentic loop. The Executor carries the full toolset and is
the canonical example (the Planner runs the same shared loop with a read-only
subset - read/search plus `clarify` - see section 1); the docstring at
[executor.ts:145-152](../src/engine/core/executor.ts#L145) sums it up: Mastra
drives the tool-calling loop (model call -> tool calls -> results back to the
model, up to `executor.maxSteps` iterations) over proxies that delegate every
call to the host.

The core is the `for(;;)` loop in
[run](../src/engine/core/executor.ts#L485-L545). Simplified:

```ts
for (;;) {
  const remaining = ceiling - totalSteps;
  if (remaining <= 0) { cutShort = true; break; }

  // A "batch" runs until the check-in interval, or to the ceiling.
  const batchCap = stepInterval > 0 ? Math.min(stepInterval, remaining) : remaining;
  const stopWhen = [stepCountIs(batchCap), /* + optional time trigger */];

  const { steps, finishReason } = await runBatch(stopWhen);
  totalSteps += steps;
  checkContext();

  const cutByBudget = steps >= batchCap || timedOut;
  if (finishReason === 'stop' || !cutByBudget) break;   // model finished on its own

  if (totalSteps >= ceiling || !checksIn) { cutShort = true; break; }

  // Otherwise pause and ask the user: keep going or stop?
  const decision = await onCheckpoint!({ stepsDone: totalSteps, ... });
  if (decision.kind === 'stop') { cutShort = true; break; }
  // "continue": next batch picks up the accumulated context.
}

if (cutShort) {                          // hit ceiling or user said stop
  messages.push({ role: 'user', content: FINALIZE_INSTRUCTION });
  await runBatch(undefined, 'none');     // conclude with tools OFF
}
```

Key design points:

**Batches and check-ins.** Rather than running blindly to `maxSteps`, the loop
runs in batches bounded by `checkpointEverySteps` / `checkpointEverySeconds`.
Between batches it can pause and ask the user "keep working?" via the
`onCheckpoint` seam ([executor.ts:526](../src/engine/core/executor.ts#L526)).
With no client seam, it runs straight to the ceiling
(`limits.executor.maxSteps`) - the runaway backstop.

**Each batch is one Mastra `stream` call**
([runBatch, executor.ts:438](../src/engine/core/executor.ts#L438)). Mastra runs
the inner model -> tool -> model micro-loop; `stopWhen: stepCountIs(batchCap)`
caps it. The conversation accumulates across batches:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: prompt }];
// ... after each batch:
const response = await output.response;
if (Array.isArray(response?.messages)) messages.push(...response.messages);
```

So a batch after a "continue" resumes with the full context the model built, not
just the truncated transcript.

**The graceful wrap-up.** If cut short (ceiling or user stop), it appends
`FINALIZE_INSTRUCTION` ([executor.ts:83](../src/engine/core/executor.ts#L83))
and runs one final batch with `toolChoice: 'none'` - so the run yields a real
in-context answer instead of an abrupt stop.

**The stream drain**
([drainBatch, executor.ts:268](../src/engine/core/executor.ts#L268)) is what
actually builds the transcript. It switches on chunk type:

- `text-delta` -> appended to the transcript as model commentary
- `tool-call` -> a `tool` event (only the `progress` tool is intercepted
  engine-side and never reaches the client; `skill` is a real client call now)
- `tool-result` / `tool-error` -> matched back to the pending call by id
- `reasoning` -> condensed and pushed to the thinking sink (never stored in the
  transcript)
- `error` -> throws, failing the step

### Tool inversion - the heart of the engine/client split

The Executor never touches the workspace. Its tools are proxies built by
[buildAgentTools](../src/engine/core/agentTools.ts#L150), each delegating to the
host. The engine decides *when* to call a tool; the client owns *how* it runs
(implementation, workspace access, approval).

Crucially, that delegation is one seam, not many. Every engine->client request -
running a tool, but also approving a plan and the executor check-in - crosses a
single `ClientHost.invoke(capability, payload)` method
([capabilities.ts](../src/protocol/capabilities.ts)), named by capability. There
are just three: `tool` (everything the *model* calls - the workspace tools, MCP
tools, and the engine-built `clarify` and `skill`, all dispatched by the tool
name in the payload, all "args in, text out"), plus `reviewPlan` and
`confirmContinue` (the two the *workflow* triggers). The engine reaches it
through a typed facade, `hostFacade(host)`, that is itself a `ToolHost` - so the
tool proxies just call `host.execute(name, args)`, which is `invoke('tool', …)`
underneath. `clarify` and `skill` are not special-cased: they are model tools
with engine-side schemas that dispatch to the client by name, where the client
shows the question pop-up / serves the skill body and composes the result string.

The LocalEngine hands the host straight in; a remote/sidecar engine satisfies the
same calls with one `invoke` message over the wire (answered by one
`invoke-result`), and the agent cannot tell the difference. This keeps invariant
#4 from CLAUDE.md intact - and because *one* mechanism carries every request, the
whole loop would work unchanged if the engine were a separate process talking to
a Kotlin client, with no per-request bridge to reimplement.

---

## 3. Routing

Two orthogonal routing decisions happen per request.

### 3a. Intent routing (which agent)

Done by **Triage** ([triage.ts:71](../src/engine/core/triage.ts#L71)) - a single
structured-output model call returning `{ intent, complexity, reason,
questions? }`. The intent enum drives the branch (section 1). Two wrinkles:

**Slash commands pin the route without a model call**
([workflow.ts:668-686](../src/engine/core/workflow.ts#L668)):

```ts
const command = commandFor(inputData);
if (command) {
  decision = { intent: command.intent, complexity: command.complexity,
               reason: pinnedReason(command.name) };
  // shadowTriage can still run triage anyway, just to score the pin.
} else {
  decision = await triage.classify(triagePrompt(inputData), ...);
}
```

Typing `/fix` is the routing decision - no latency, no chance to misroute.

**Triage output is repaired, not trusted.** `classify` wraps the call in
[parseWithRepair](../src/engine/core/triage.ts#L76): on a schema violation it
re-asks once with the Zod issues appended before failing - small local
classifiers routinely need that nudge.

**Coercions** in the triage step keep the run from dead-ending
([workflow.ts:698-709](../src/engine/core/workflow.ts#L698)): a `clarify` with no
usable question (or clarifying disabled) becomes `oneshot`; a `direct` becomes
`planning` when the user approves every plan (a direct change has no plan to
approve, so it gets drafted into one).

### 3b. Model routing (which model backs each agent)

This is the capability router. Agents never name a concrete model. Instead:

- Each **model** is a `.md` file scored 0-1 on a capability vocabulary
  ([models.ts:44-56](../src/engine/config/models.ts#L44)): `reasoning, coding,
  classification, planning, speed, structured-output, long-context`.
- Each **agent** declares the same vocabulary as weights - how much it cares
  ([agents.ts:47-52](../src/engine/config/agents.ts#L47)).
- The router picks the model with the highest weighted score (Sum of weight x
  score) ([scoreModel](../src/engine/config/models.ts#L313)):

```ts
export function scoreModel(info: ModelInfo, requirements: CapabilityScores): number {
  let total = 0;
  for (const [capability, weight] of Object.entries(requirements)) {
    total += weight * (info.capabilities[capability as Capability] ?? 0);
  }
  return total;
}
```

The selection logic is
[selectModel](../src/engine/config/models.ts#L344). Precedence:

1. **Model pin** (`pinned && isEnabled`) -> returns that exact model outright,
   even if its key is missing (the run then fails with a helpful hint). The user
   asked for it.
2. **Provider pin** (`provider:anthropic`) -> narrows to that provider's models,
   then scores within.
3. **Auto / unknown / no pin** -> highest weighted fit among `candidates`.

Layered on top, two refinements:

**Complexity tiering** ([tierPool](../src/engine/config/models.ts#L288)). Only
the Executor passes a `complexity`. Before scoring, the pool is narrowed to the
request's tier (`simple`/`moderate`/`complex`), falling back to the nearest
available tier by ordinal distance (tie broken toward cheaper). So the same
capability profile routes simple work to a cheap model and complex work to a
strong one - gated by `myDevTeam.complexityRouting`
([core/models.ts:351-362](../src/engine/core/models.ts#L351)):

```ts
export function routeModel(requirements, pin?, candidates = workModels(), complexity?) {
  const tier = runtimeConfig().complexityRoutingEnabled ? complexity : undefined;
  return selectModel(requirements, effectivePin(pin), candidates, tier, isModelEnabled);
}
```

The executor passes the planner's post-exploration complexity when available,
not triage's pre-exploration guess
([workflow.ts:1032](../src/engine/core/workflow.ts#L1032)) - the planner has
actually seen the workspace, so its read is the better one to size the heavy
step on.

**Candidate pools**
([core/models.ts:245-267](../src/engine/core/models.ts#L245)) enforce who is
eligible:

- `availableModels()` - Ollama (assumed pulled) + cloud models with keys set,
  minus disabled. This is triage's pool.
- `workModels()` - the above minus `triageOnly` models, so Auto never hands real
  work to the tiny classifier-only model. The default pool for
  planner/answerer/executor/summarizer.

**Disable layers** are unbypassable: `effectivePin`
([core/models.ts:228](../src/engine/core/models.ts#L228)) drops a pin naming a
disabled model/provider down to Auto, and `isModelEnabled` is injected into
`selectModel` so even a pinned-provider's individually-disabled members are
excluded. Disabling is a hard block however the model would have been reached.

**Triage's own routing** cascades specially
([triageRouting](../src/engine/core/models.ts#L303)): `myDevTeam.triage.model`
wins, else the work model (`myDevTeam.model`) if concrete, else the
`backend.json` floor - the cheap local classifier the default deployment ships.
So an all-Auto setup classifies for free locally, but a user who points the work
agents at a cloud provider gets triage there too rather than a missing-Ollama
failure.

Finally, the winning registry entry becomes a real AI SDK instance in
[resolveModel](../src/engine/core/models.ts#L379), wrapped in the rate-limiter
middleware and memoised per `(provider-config-signature, model-id)` so an
endpoint/key change rebuilds it.

---

## Putting it together: one request's journey

1. **LocalEngine** receives the request, binds the client seams (approval,
   check-in, sinks) into a `RequestContext`, and starts the workflow.
2. **Triage** (or a pinned command) -> `{ intent, complexity, reason }`. Its
   model came from `triageRouting` + the capability router.
3. **Branch by intent**:
   - `oneshot` -> **Answerer** streams text. End.
   - `clarify` -> carry questions to the client. End.
   - `planning` -> **Planner** drafts a plan (model sized by triage's
     complexity), `gatePlan` optionally pauses for approval.
   - `direct` -> pass through, no plan.
4. **Branch by `shouldExecute`**: if there is a plan (or it is `direct`) and not
   cancelled -> **Executor**.
5. **Executor's tool-calling loop** runs in batches against client-side tool
   proxies, checking in with the user, warning on context, finalizing gracefully
   if cut short. Its model was sized by the planner's post-exploration
   complexity.
6. If files changed, **Summarizer** recaps (best-effort - never fails the run).
7. The final step strips carried fields back to a protocol `Reply`.

The separation is the point: intent routing decides which agents run, capability
routing decides which models back them, and tool inversion means none of it
touches the workspace directly - so the whole brain could lift out into a remote
process behind a Kotlin client without changing a line of the loop.
