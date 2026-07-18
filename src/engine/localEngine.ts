/**
 * The in-process implementation of the engine port (src/protocol/engine.ts):
 * the whole agent pipeline - triage, planner, answerer, executor, the model
 * router, every prompt - running inside the extension, exactly as before the
 * protocol existed. A Phase-B RemoteEngine implements the same interface by
 * forwarding the protocol over HTTP; the client cannot tell them apart,
 * which is what makes the `myDevTeam.engine` setting a safe switch.
 *
 * Everything in src/engine/ is implementation a future backend hides. The
 * boundary discipline: ui/, tools/, and client/ may import this file and the
 * protocol, never anything in engine/core or engine/config.
 */
import { RequestContext } from '@mastra/core/request-context';
import { Triage } from './core/triage';
import { Planner } from './core/planner';
import { Responder } from './core/responder';
import { Answerer } from './core/answerer';
import { Executor } from './core/executor';
import { Summarizer } from './core/summarizer';
import { Compacter } from './core/compacter';
import { AgentUsage, estimateTokens } from './core/usage';
import { pinnedReason } from './config/commands';
import {
  createDevTeamWorkflow,
  abortSignalKey,
  planReviewKey,
  continueReviewKey,
  contextWarningKey,
  replyProgressKey,
  stepIds,
  usageSinkKey,
  thinkingSinkKey,
  triageShadowKey,
  ReplyProgress,
  StepUsage,
} from './core/workflow';
import { agents, AgentName } from './config/agents';
import {
  AUTO_MODEL,
  PROVIDER_PIN_PREFIX,
  modelById,
  modelRegistry,
  providerLabels,
  providerPinOf,
  ModelInfo,
  ProviderName,
} from './config/models';
import {
  routeModel,
  routeTriageModel,
  isModelAvailable,
  isModelEnabled,
  isProviderEnabled,
  effectivePin,
  contextWindowFor,
  ollamaEndpoint,
  llamacppEndpoint,
} from './core/models';
import { isRateLimited } from './core/rateLimiter';
import { limits } from '../config/limits';
import { runtimeConfig } from '../config/runtimeConfig';
import { messages } from '../config/messages';
import {
  CheckpointInfo,
  Complexity,
  ComplexitySchema,
  ContextWarning,
  DynamicToolDef,
  ExecutionEvent,
  HistoryTurn,
  Intent,
  PartialSummary,
  ModelChoice,
  ModelSelection,
  Plan,
  PROTOCOL_VERSION,
  Reply,
  ReplySchema,
  RunRequest,
  RunRequestSchema,
} from '../protocol/types';
import { RunEvent, RunStep } from '../protocol/events';
import { ToolHost } from '../protocol/toolContract';
import { hostFacade } from '../protocol/capabilities';
import {
  Engine,
  RunClient,
  RunHandle,
  RunCancelledError,
  RunFailedError,
} from '../protocol/engine';

/**
 * The Ollama models the router selects for the registered agents, deduplicated -
 * the set the startup probe checks are pulled. The work agents are routed with
 * the user's `myDevTeam.model` pin (the same value a run carries), and triage per
 * `myDevTeam.triage.model` (which cascades to the work model, then the backend
 * floor, when unset); like the other agents, only an Ollama choice is an Ollama
 * tag to probe, so a fully cloud-pinned setup yields no tags and the probe never
 * pings a server the user does not run.
 */
export function routedModels(): string[] {
  const names = new Set<string>();
  // The work model pin (`myDevTeam.model`); "auto" routes by capability, so pass
  // it through as no pin to keep Auto's candidate pool.
  const work = runtimeConfig().workModel;
  const pin = work === AUTO_MODEL ? undefined : work;
  const addIfOllama = (info: ModelInfo) => {
    if (info.provider === 'ollama') {
      names.add(info.model);
    }
  };
  // In combined mode the responder replaces triage + the answerer/planner on
  // the unpinned path, so its model is the one a plain request routes to; probe
  // it instead of triage's. Classic mode probes triage as before.
  if (runtimeConfig().triageMode === 'combined') {
    addIfOllama(routeModel(agents.responder.capabilities, pin));
  } else {
    addIfOllama(routeTriageModel(agents.triage.capabilities));
  }
  addIfOllama(routeModel(agents.answerer.capabilities, pin));
  // The planner and the executor are both sized by complexity now, so a run can
  // route either to a different Ollama tag per tier; probe all of them so the
  // startup check warns about any that is not pulled.
  for (const complexity of ComplexitySchema.options) {
    addIfOllama(routeModel(agents.planner.capabilities, pin, undefined, complexity));
    addIfOllama(routeModel(agents.executor.capabilities, pin, undefined, complexity));
  }
  return [...names];
}

/**
 * Which model each step will use for this run, for the protocol's
 * `model-selected` event and the reply's `selection`. Deterministic from the
 * route and the user's pin, so the streamed event and the final reply always
 * agree. Triage follows `myDevTeam.triage.model` (which cascades to the work
 * model, then the local backend floor, when unset), routed independently of the
 * run's pin; the work agents honour the pin (or, in Auto, the best available
 * model). Only the steps the route will run are listed: triage always, then
 * plan+execute, or answer.
 */
export function modelSelection(
  intent: Intent,
  modelPin?: string,
  // Two tiers, because the planner and executor are now sized differently: the
  // planner by triage's pre-exploration guess, the executor by the planner's
  // post-exploration judgement. `planComplexity` is known only after the plan
  // is drafted, so the streamed model-selected event (emitted right after
  // triage) passes only `triageComplexity` and the final reply's selection -
  // computed once the run finishes - corrects the executor entry.
  triageComplexity?: Complexity,
  planComplexity?: Complexity,
  // Combined mode: the unpinned path runs one responder (built per run with the
  // pin) instead of triage + the answerer/planner. Its model is reported under
  // the `plan`/`answer` step (so the "which model ran" line names it as before),
  // and there is no separate triage entry. Set by the caller as
  // `combinedMode && !command` - a pinned command still uses the dedicated
  // agents even in combined mode, so the classic selection applies then.
  combined = false
): ModelSelection {
  // A disabled pin is hard-blocked to Auto, so the reported mode is derived from
  // the *effective* pin - the same value routeModel routes on - keeping the
  // model-selected event and reply honest about what actually ran.
  const pin = effectivePin(modelPin);
  // pinned (a model id) > provider (a "provider:<name>" pin) > auto.
  const providerPin = providerPinOf(pin);
  const mode: ModelSelection['mode'] = modelById(pin)
    ? 'pinned'
    : providerPin
    ? 'provider'
    : 'auto';
  const entry = (step: string, info: ModelInfo) => ({
    step,
    id: info.id,
    label: info.label,
  });
  // The combined responder is not sized by complexity (it decides complexity in
  // the same call), so its model is the same whatever the route; the executor it
  // hands a plan to is still complexity-sized.
  const responderInfo = () => routeModel(agents.responder.capabilities, modelPin);
  const models = combined
    ? []
    : [entry('triage', routeTriageModel(agents.triage.capabilities))];
  if (intent === 'planning') {
    // The planner is sized by triage's complexity, the executor by the
    // planner's (falling back to triage's until the plan is drafted) - matching
    // the tiers the draft-plan and execute steps build their agents with.
    models.push(
      combined
        ? entry('plan', responderInfo())
        : entry('plan', routeModel(agents.planner.capabilities, modelPin, undefined, triageComplexity))
    );
    models.push(
      entry(
        'execute',
        routeModel(
          agents.executor.capabilities,
          modelPin,
          undefined,
          planComplexity ?? triageComplexity
        )
      )
    );
  } else if (intent === 'direct') {
    // The direct route skips the planner: only the executor runs, sized by
    // triage's (pre-exploration) complexity since there is no plan to size it.
    // No plan/answer step, so the "which model ran" line falls back to the
    // executor (see messages.model.block).
    models.push(
      entry(
        'execute',
        routeModel(agents.executor.capabilities, modelPin, undefined, triageComplexity)
      )
    );
  } else if (intent === 'clarify') {
    // The clarify route runs no work agent in classic mode (only triage decided
    // to ask), so the triage entry above is the whole selection. In combined
    // mode the responder is what asked, so name it under the answer step.
    if (combined) {
      models.push(entry('answer', responderInfo()));
    }
  } else {
    models.push(
      combined
        ? entry('answer', responderInfo())
        : entry('answer', routeModel(agents.answerer.capabilities, modelPin))
    );
  }
  return providerPin
    ? { mode, provider: providerLabels[providerPin], models }
    : { mode, models };
}

/**
 * Translates the workflow's grow-only ReplyProgress snapshots into the
 * protocol's event stream. The mapping is exact: a client folding the events
 * back (protocol/events.ts ReplyFolder) reproduces each snapshot at the same
 * point, so rendering from events is pixel-identical to rendering from the
 * snapshots directly - the property that makes local and remote runs look
 * the same.
 */
export class ProgressTranslator {
  private triaged = false;
  private executorCorrected = false;
  private answerChars = 0;
  private executionSeen: ExecutionEvent[] = [];
  private summarySeen: string | undefined;

  /**
   * `selectionFor` (when given) maps the decided route and complexity to the
   * run's model selection, so the translator can emit `model-selected` right
   * after the first `triaged` - the route decides which steps run and the
   * complexity sizes the executor's model.
   */
  constructor(
    private readonly emit: (event: RunEvent) => void,
    private readonly selectionFor?: (
      intent: Intent,
      triageComplexity?: Complexity,
      planComplexity?: Complexity
    ) => ModelSelection
  ) {}

  push(progress: ReplyProgress): void {
    if (!this.triaged) {
      this.triaged = true;
      this.emit({
        type: 'triaged',
        intent: progress.intent,
        reason: progress.reason,
        ...(progress.complexity ? { complexity: progress.complexity } : {}),
      });
      if (this.selectionFor) {
        this.emit({
          type: 'model-selected',
          selection: this.selectionFor(progress.intent, progress.complexity),
        });
      }
    }
    // Plans stream as snapshots while they are being drafted; once execution
    // output exists the plan is final and already emitted.
    if (progress.plan && !progress.execution) {
      this.emit({ type: 'plan-snapshot', plan: progress.plan });
    }
    if (progress.answer !== undefined && progress.answer.length > this.answerChars) {
      this.emit({ type: 'answer-delta', text: progress.answer.slice(this.answerChars) });
      this.answerChars = progress.answer.length;
    }
    if (progress.execution) {
      // Execution has started, so the planner's complexity is now settled: the
      // first model-selected (emitted right after triage) could only size the
      // executor by triage's guess, so re-emit the selection with the executor
      // entry corrected to the model that actually runs. Done before the first
      // execution event so the execution header renders the final model from the
      // start - the streamed output never has to retract an already-shown one.
      if (!this.executorCorrected && this.selectionFor) {
        this.executorCorrected = true;
        this.emit({
          type: 'model-selected',
          selection: this.selectionFor(
            progress.intent,
            progress.complexity,
            progress.plan?.complexity
          ),
        });
      }
      // Transcripts are grow-only with only the last event still mutating, so
      // comparing from the previously-last event finds every change.
      const events = progress.execution.events;
      const start = Math.max(0, this.executionSeen.length - 1);
      for (let index = start; index < events.length; index++) {
        const event = events[index];
        if (
          index >= this.executionSeen.length ||
          JSON.stringify(event) !== JSON.stringify(this.executionSeen[index])
        ) {
          this.emit({ type: 'execution-event', index, event: { ...event } });
          this.executionSeen[index] = { ...event };
        }
      }
    }
    // The summary streams in as small grow-only snapshots once execution is
    // done; emit each new one (deduplicated, so a re-pushed identical snapshot
    // does not produce a redundant event).
    if (progress.summary) {
      const json = JSON.stringify(progress.summary);
      if (json !== this.summarySeen) {
        this.summarySeen = json;
        this.emit({ type: 'summary-snapshot', summary: progress.summary as PartialSummary });
      }
    }
  }
}

/**
 * Which protocol step (and which agent's routed model, for the Ollama hint) a
 * failed workflow step maps onto. Checked in pipeline-reverse order so the
 * deepest step that failed wins; an unattributable failure falls back to
 * triage, matching the pre-protocol error rendering.
 */
const failureMap: ReadonlyArray<{ stepId: string; step: RunStep; agent: AgentName }> = [
  { stepId: stepIds.execute, step: 'execute', agent: 'executor' },
  { stepId: stepIds.plan, step: 'plan', agent: 'planner' },
  { stepId: stepIds.answer, step: 'answer', agent: 'answerer' },
  // Combined mode's single step (triage + answer/plan). The route is unknown on
  // failure, so it reports as a plan-step error; the hint names the responder's
  // model, which is the same whatever the route.
  { stepId: stepIds.respond, step: 'plan', agent: 'responder' },
  { stepId: stepIds.triage, step: 'triage', agent: 'triage' },
];

function failureDetail(error: unknown): string {
  // Mastra serializes step errors to plain `{ message, … }` objects, so the
  // value here may be an Error, a serialized error, or anything thrown.
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

/**
 * The troubleshooting hint for a failed agent, naming the model it actually
 * used. A persistent rate limit (a 429 that outlasted the retries) points at
 * the throttle setting; otherwise an Ollama model points at the server + tag to
 * pull and a cloud model at its missing/invalid API key. Triage routes per
 * `myDevTeam.triage.model`, so its hint can point at a cloud key too.
 */
function failureHint(agent: AgentName, modelPin?: string, error?: unknown): string {
  const info =
    agent === 'triage'
      ? routeTriageModel(agents.triage.capabilities)
      : routeModel(agents[agent].capabilities, modelPin);
  if (isRateLimited(error)) {
    return messages.rateLimitHint(info.label);
  }
  if (info.provider === 'ollama') {
    return messages.ollamaHint(ollamaEndpoint(), info.model);
  }
  if (info.provider === 'llamacpp') {
    return messages.llamacppHint(llamacppEndpoint());
  }
  return messages.cloudKeyHint(info.label, info.provider);
}

function mapFailure(
  error: unknown,
  steps: Record<string, { status: string }>,
  modelPin?: string
): RunFailedError {
  const detail = failureDetail(error);
  for (const { stepId, step, agent } of failureMap) {
    if (steps[stepId]?.status === 'failed') {
      return new RunFailedError(step, detail, failureHint(agent, modelPin, error));
    }
  }
  return new RunFailedError('triage', detail, failureHint('triage', modelPin, error));
}

/** Shape of the Ollama `GET /api/tags` response, as far as the probe reads it. */
interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * The agents the LocalEngine runs the workflow with. Injectable so tests can
 * drive the engine with scripted fakes; the default set is the real, routed
 * agents. The executor is a factory because it is bound to the run's ToolHost.
 */
export interface LocalEngineAgents {
  /**
   * Triage is shared across runs - it never honours the run's model pin. Its
   * own routing follows `myDevTeam.triage.model`, which cascades to the work
   * model setting (then the backend floor) when unset (see `triageRouting`).
   */
  triage: Triage;
  /**
   * Built per run with the request's pin and ToolHost (the planner now drives a
   * tool-calling loop - it reads and searches before committing), plus the
   * complexity triage decided - which sizes the planner's model, so it is
   * supplied when the draft-plan step runs, not at run setup (mirroring the
   * executor). The planner's `clarify` tool is built from the host's offered
   * tools, so no clarify seam is passed.
   */
  createPlanner: (
    toolHost: ToolHost,
    modelPin?: string,
    complexity?: Complexity
  ) => Planner;
  createAnswerer: (modelPin?: string) => Answerer;
  /**
   * Built per run with the request's pin for combined mode (`myDevTeam.triage.mode`
   * = "combined"): one agent that triages and produces the answer or plan in a
   * single call. Optional so a test agent set that does not exercise combined
   * mode can leave it out; the engine then keeps the classic three-agent path.
   */
  createResponder?: (modelPin?: string) => Responder;
  /**
   * Built per run with the request's pin and ToolHost, plus the complexity the
   * triage step decided - which sizes the executor's model, so it is supplied
   * when the execute step runs, not at run setup. The executor's `skill` tool
   * reaches the client through the host (it fetches a body on demand; the engine
   * holds none), so no skill loader is passed.
   */
  createExecutor: (
    toolHost: ToolHost,
    modelPin?: string,
    complexity?: Complexity,
    dynamicTools?: readonly DynamicToolDef[]
  ) => Executor;
  /**
   * Built per run with the request's pin to recap an executed plan. Optional so
   * a test agent set that does not exercise the summary can leave it out; the
   * execute step then simply produces no summary.
   */
  createSummarizer?: (modelPin?: string) => Summarizer;
  /**
   * Built per `/compact` run with the request's pin to condense the conversation.
   * Optional so a test agent set that does not exercise compaction can leave it
   * out; a compact request then falls back to the normal workflow path.
   */
  createCompacter?: (modelPin?: string) => Compacter;
}

function defaultAgents(): LocalEngineAgents {
  return {
    triage: new Triage(),
    createPlanner: (toolHost, modelPin, complexity) =>
      new Planner(toolHost, modelPin, complexity),
    createAnswerer: (modelPin) => new Answerer(modelPin),
    createResponder: (modelPin) => new Responder(modelPin),
    createExecutor: (toolHost, modelPin, complexity, dynamicTools) =>
      new Executor(toolHost, modelPin, complexity, dynamicTools),
    createSummarizer: (modelPin) => new Summarizer(modelPin),
    createCompacter: (modelPin) => new Compacter(modelPin),
  };
}

/**
 * The slash command that triggers compaction. Matches the engine command
 * registry's `compact` (config/commands/compact.md, kept for autocomplete and
 * route-pinning); the LocalEngine intercepts it before the workflow so it runs
 * the dedicated compacter rather than the answerer.
 */
const COMPACT_COMMAND_NAME = 'compact';

/** The conversation rendered for the compacter, matching the workflow's format. */
function renderConversation(turns: readonly HistoryTurn[]): string {
  const lines = turns.map(
    (turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`
  );
  return `--- Conversation so far ---\n${lines.join('\n\n')}\n--- End of conversation ---`;
}

/**
 * Split the conversation into the passes a compaction runs, oldest-first. The
 * whole conversation is summarized - nothing is dropped: when it fits one pass
 * (`inputWindowFraction` of the compacter model's window) it is a single chunk;
 * when it does not, it is chunked for a rolling refine, where each later pass
 * carries the briefing-so-far plus the next chunk. The first chunk may use the
 * whole per-pass budget (no briefing yet); later chunks reserve
 * `briefingReserveFraction` of it for the carried briefing. An unknown window
 * (no built-in value and no `modelContextWindows` override) cannot be sized, so
 * it is one pass over everything - the client's coarse ceiling still bounds it.
 * A turn larger than a chunk budget stands as its own chunk rather than being
 * split, so a single huge turn never wedges the loop.
 */
export function planCompactionChunks(
  turns: readonly HistoryTurn[],
  window: number | undefined
): HistoryTurn[][] {
  if (turns.length === 0) {
    return [];
  }
  if (!window) {
    return [[...turns]];
  }
  const perPass = Math.max(1, Math.floor(window * limits.compaction.inputWindowFraction));
  const total = turns.reduce((sum, turn) => sum + estimateTokens(turn.text), 0);
  if (total <= perPass) {
    return [[...turns]];
  }
  const restBudget = Math.max(
    1,
    perPass - Math.floor(perPass * limits.compaction.briefingReserveFraction)
  );
  const chunks: HistoryTurn[][] = [];
  let current: HistoryTurn[] = [];
  let currentTokens = 0;
  // The first chunk has no carried briefing, so it may use the whole budget.
  let budget = perPass;
  for (const turn of turns) {
    const cost = estimateTokens(turn.text);
    if (current.length > 0 && currentTokens + cost > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
      budget = restBudget;
    }
    current.push(turn);
    currentTokens += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * The refine prompt for a later compaction pass: the briefing built from the
 * earlier chunks, then the next chunk to fold into it. The compacter agent is
 * told to keep all of the briefing's detail and only add the new material (see
 * config/agents/compacter.md), so the already-summarized part is not
 * re-compressed - only the new part is summarized in.
 */
function refinePrompt(briefing: string, chunk: readonly HistoryTurn[]): string {
  return (
    `--- Briefing so far ---\n${briefing}\n--- End of briefing so far ---\n\n` +
    `The briefing above summarizes the earlier part of the conversation. Keep all ` +
    `of its detail and update it to incorporate this next part:\n\n` +
    renderConversation(chunk)
  );
}

/**
 * The run's model selection for a compaction: a single `answer` step naming the
 * compacter's routed model, with the mode (pinned/provider/auto) derived the
 * same way as `modelSelection` so the "which model ran" header reads honestly.
 */
function compactSelection(modelPin: string | undefined, compacter: Compacter): ModelSelection {
  const pin = effectivePin(modelPin);
  const providerPin = providerPinOf(pin);
  const mode: ModelSelection['mode'] = modelById(pin)
    ? 'pinned'
    : providerPin
    ? 'provider'
    : 'auto';
  const models = [{ step: 'answer', id: compacter.modelId, label: compacter.modelLabel }];
  return providerPin
    ? { mode, provider: providerLabels[providerPin], models }
    : { mode, models };
}

export class LocalEngine implements Engine {
  readonly kind = 'local' as const;
  private readonly agents: LocalEngineAgents;

  constructor(agentSet?: LocalEngineAgents) {
    this.agents = agentSet ?? defaultAgents();
  }

  startRun(request: RunRequest, client: RunClient): RunHandle {
    const abort = new AbortController();
    let cancelled = false;
    let activeRun: { cancel(): unknown } | undefined;

    // Event delivery must never throw into the run: the engine is producing,
    // the client is only watching.
    const emit = (event: RunEvent) => {
      try {
        client.onEvent(event);
      } catch {
        // A broken sink loses events, never the run.
      }
    };

    const result = (async (): Promise<Reply> => {
      const input = RunRequestSchema.parse(request);
      if (input.protocolVersion !== PROTOCOL_VERSION) {
        throw new RunFailedError(
          undefined,
          `Protocol version ${input.protocolVersion} is not supported (this engine speaks ${PROTOCOL_VERSION}).`
        );
      }

      // The user's per-run model choice ("auto"/absent lets the router pick).
      // Triage ignores it (it follows its own myDevTeam.triage.model); the work
      // agents are built per run with it, since the pin changes which model they wire.
      const modelPin = input.model;

      // /compact is its own path, not the normal workflow: it runs the compacter
      // agent (which prefers a big-window model) over the conversation, trimming
      // the history to that model's window. Falls back to the workflow when no
      // compacter is wired (a test agent set that does not exercise compaction).
      if (input.command === COMPACT_COMMAND_NAME && this.agents.createCompacter) {
        return await this.runCompaction(input, modelPin, emit, abort.signal, () => cancelled);
      }

      // Combined mode runs one responder on the unpinned path instead of triage
      // + the answerer/planner. A slash command still pins the route and uses the
      // dedicated agents, so the combined selection (and graph) only applies to
      // an unpinned request. Gated on the responder factory being wired.
      const createResponder = this.agents.createResponder;
      const combined =
        runtimeConfig().triageMode === 'combined' && createResponder !== undefined;
      const combinedSelection = combined && input.command === undefined;

      const selectionFor = (
        intent: Intent,
        triageComplexity?: Complexity,
        planComplexity?: Complexity
      ) =>
        modelSelection(intent, modelPin, triageComplexity, planComplexity, combinedSelection);

      // The one inversion seam, viewed through the engine-side typed facade: it
      // is a ToolHost (so the planner/executor reach their tools through it) and
      // also exposes the plan-review, check-in, clarify, and skill-load seams,
      // every one riding the client's single `invoke`. `supports` gates the
      // additive seams below to what this client actually implements.
      const host = hostFacade(client);

      // The work agents are bound to this run's pin; the executor also to the
      // host (its ToolHost view). It is passed as a factory because its model is
      // sized by the request's complexity, decided inside the run. Workflow
      // assembly is plain object composition, cheap per run.
      const createSummarizer = this.agents.createSummarizer;
      const workflow = createDevTeamWorkflow(
        this.agents.triage,
        (complexity) => this.agents.createPlanner(host, modelPin, complexity),
        this.agents.createAnswerer(modelPin),
        (complexity) =>
          this.agents.createExecutor(host, modelPin, complexity, input.dynamicTools),
        createSummarizer ? () => createSummarizer(modelPin) : undefined,
        combined ? () => createResponder!(modelPin) : undefined
      );
      const run = await workflow.createRun();
      activeRun = run;
      if (cancelled) {
        throw new RunCancelledError();
      }

      const translator = new ProgressTranslator(emit, selectionFor);
      const requestContext = new RequestContext();
      requestContext.set(abortSignalKey, abort.signal);
      requestContext.set(replyProgressKey, (progress: ReplyProgress) =>
        translator.push(progress)
      );
      requestContext.set(usageSinkKey, (usage: StepUsage) =>
        emit({ type: 'usage', ...usage })
      );
      // Thinking is a side-channel like usage: forwarded straight to the event
      // stream, never folded into a reply snapshot. The UI shows it as
      // transient progress and drops it when the run produces real output.
      requestContext.set(thinkingSinkKey, (line: string) =>
        emit({ type: 'thinking', text: line })
      );
      requestContext.set(triageShadowKey, (predicted: Intent) =>
        emit({ type: 'triage-shadow', predicted })
      );
      // Context-usage warnings are a one-way side-channel like thinking and
      // usage: forwarded straight to the event stream as a caution the UI shows.
      requestContext.set(contextWarningKey, (warning: ContextWarning) =>
        emit({ type: 'context-warning', warning })
      );
      // The two workflow-triggered seams, each wired only when the client
      // implements that capability - both riding the host's single `invoke`
      // underneath, so they reach the in-process, sidecar, and remote clients
      // identically. Absent, each degrades additively: no plan gate, no executor
      // check-in. (The planner's clarify and the executor's skill are ordinary
      // model tools now, dispatched through the host's `tool` capability, so they
      // need no seam wiring here.)
      if (host.supports('reviewPlan')) {
        requestContext.set(planReviewKey, (plan: Plan, complexity: Complexity) =>
          host.reviewPlan(plan, complexity)
        );
      }
      if (host.supports('confirmContinue')) {
        requestContext.set(continueReviewKey, (info: CheckpointInfo) =>
          host.confirmContinue(info)
        );
      }

      let outcome;
      try {
        outcome = await run.start({
          inputData: {
            prompt: input.prompt,
            instructions: input.instructions,
            attachments: input.attachments,
            history: input.history,
            skills: input.skills,
            command: input.command,
            shadowTriage: input.shadowTriage,
          },
          requestContext,
        });
      } catch (err) {
        if (cancelled) {
          throw new RunCancelledError();
        }
        throw err;
      }

      if (cancelled || (outcome.status as string) === 'canceled') {
        throw new RunCancelledError();
      }
      if (outcome.status === 'success') {
        // Parse rather than cast: the protocol schema is the promise the
        // engine makes to every client, local or remote. The selection is
        // attached here (deterministic from the route), matching the
        // model-selected event the translator already emitted.
        const reply = ReplySchema.parse(outcome.result);
        // The executor entry is now corrected to the planner's complexity (the
        // streamed model-selected event only had triage's estimate).
        return {
          ...reply,
          selection: selectionFor(reply.intent, reply.complexity, reply.plan?.complexity),
        };
      }
      if (outcome.status === 'failed') {
        throw mapFailure(outcome.error, outcome.steps, modelPin);
      }
      throw new RunFailedError(
        undefined,
        `The run ended with unexpected status "${outcome.status}".`
      );
    })();

    // Mirror the outcome onto the event stream, so a consumer watching only
    // events sees the same ending the result promise reports.
    const reported = result
      .then((reply) => {
        emit({ type: 'done', reply });
        return reply;
      })
      .catch((err) => {
        if (!(err instanceof RunCancelledError)) {
          emit({
            type: 'error',
            step: err instanceof RunFailedError ? err.step : undefined,
            message: err instanceof Error ? err.message : String(err),
            hint: err instanceof RunFailedError ? err.hint : undefined,
          });
        }
        throw err;
      });

    return {
      result: reported,
      cancel: () => {
        cancelled = true;
        abort.abort();
        void activeRun?.cancel();
      },
    };
  }

  /**
   * The `/compact` path: condense the conversation with the compacter agent
   * instead of the workflow. Emits the same events a oneshot answer would
   * (`triaged`, `model-selected`, streaming `answer-delta`s, `usage`) so the
   * client renders it identically, but the producing model is the compacter -
   * which prefers a big window - and the conversation is sized to that model's
   * window. The whole conversation is summarized, nothing dropped: when it fits
   * the window it is one pass; when it does not it is a rolling refine over
   * oldest-first chunks, each later pass carrying the briefing-so-far plus the
   * next chunk. Only the final pass streams as the visible answer; earlier passes
   * show a progress line and sum their usage. A failure maps to a helpful
   * `answer`-step error; cancellation aborts the stream.
   */
  private async runCompaction(
    input: RunRequest,
    modelPin: string | undefined,
    emit: (event: RunEvent) => void,
    signal: AbortSignal,
    isCancelled: () => boolean
  ): Promise<Reply> {
    const compacter = this.agents.createCompacter!(modelPin);
    const reason = pinnedReason(COMPACT_COMMAND_NAME);
    const selection = compactSelection(modelPin, compacter);
    // Render as a oneshot answer: the route, then the chosen model.
    emit({ type: 'triaged', intent: 'oneshot', reason });
    emit({ type: 'model-selected', selection });
    if (isCancelled()) {
      throw new RunCancelledError();
    }

    const chunks = planCompactionChunks(
      input.history ?? [],
      contextWindowFor(compacter.modelId)
    );
    const onUsage = (usage: AgentUsage) => emit({ type: 'usage', step: 'answer', ...usage });
    let answerChars = 0;
    try {
      let briefing = '';
      for (let i = 0; i < chunks.length; i++) {
        if (isCancelled()) {
          throw new RunCancelledError();
        }
        const isFinal = i === chunks.length - 1;
        const prompt =
          i === 0 ? renderConversation(chunks[i]) : refinePrompt(briefing, chunks[i]);
        // Only the final pass is the visible reply; earlier passes show a
        // progress line (a thinking event the UI renders as transient progress)
        // and do not stream, so the chat is not filled with intermediate drafts.
        if (!isFinal) {
          emit({ type: 'thinking', text: messages.context.compactingPass(i + 1, chunks.length) });
        }
        const onPartial = isFinal
          ? (textSoFar: string) => {
              if (textSoFar.length > answerChars) {
                emit({ type: 'answer-delta', text: textSoFar.slice(answerChars) });
                answerChars = textSoFar.length;
              }
            }
          : undefined;
        briefing = await compacter.compact(prompt, onPartial, onUsage, signal);
      }
      if (isCancelled()) {
        throw new RunCancelledError();
      }
      return ReplySchema.parse({ intent: 'oneshot', reason, answer: briefing, selection });
    } catch (err) {
      if (isCancelled() || err instanceof RunCancelledError) {
        throw new RunCancelledError();
      }
      if (err instanceof RunFailedError) {
        throw err;
      }
      throw new RunFailedError(
        'answer',
        failureDetail(err),
        failureHint('compacter', modelPin, err)
      );
    }
  }

  /**
   * The set of Ollama tags installed on the configured server, or undefined
   * when the server could not be reached. Ollama reports untagged pulls as
   * "<model>:latest", so both the tag and its `:latest` alias are stored.
   */
  private async installedOllamaTags(): Promise<Set<string> | undefined> {
    try {
      const res = await fetch(`${ollamaEndpoint()}/api/tags`, {
        signal: AbortSignal.timeout(limits.startupProbeTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const tags = (await res.json()) as TagsResponse;
      return new Set(
        (tags.models ?? [])
          .flatMap((m) => [m.name, m.model])
          .filter((n): n is string => typeof n === 'string')
      );
    } catch {
      return undefined;
    }
  }

  /** Whether `model` (or its ":latest" alias) is in the installed tag set. */
  private static ollamaInstalled(model: string, installed: Set<string>): boolean {
    return installed.has(model) || installed.has(`${model}:latest`);
  }

  /**
   * Ping the configured Ollama endpoint and report (never show - surfacing is
   * the UI's job) whether the server is unreachable or any Auto-routed local
   * model is not pulled, instead of letting the first run be what fails. Cloud
   * models are not Ollama tags, so they are not probed here.
   *
   * When no agent routes to Ollama at all (e.g. triage and the work agents all
   * resolve to a cloud provider), Ollama is not needed for this configuration,
   * so the probe is skipped entirely and the server's reachability is never
   * mentioned - a fully cloud setup must not warn about an Ollama server it does
   * not use.
   */
  async startupWarnings(): Promise<string[]> {
    const routed = routedModels();
    if (routed.length === 0) {
      return [];
    }
    const installed = await this.installedOllamaTags();
    if (!installed) {
      return [messages.startup.unreachable(ollamaEndpoint())];
    }
    const missing = routed.filter(
      (model) => !LocalEngine.ollamaInstalled(model, installed)
    );
    return missing.length > 0 ? [messages.startup.missingModels(missing)] : [];
  }

  /**
   * The models the `/model` picker offers: "Auto" first, then every registered
   * model with whether it can run now. An Ollama model is available when it is
   * pulled (probed once here; if the server is unreachable we cannot tell, so
   * we report it available rather than hide it); a cloud model when its API
   * key is set. A model/provider disabled at either layer (the backend floor or
   * the user's settings) is flagged `disabled` and reported unavailable, so the
   * picker shows it greyed out rather than letting the user pin something that
   * is hard-blocked from running.
   */
  async listModels(): Promise<ModelChoice[]> {
    const installed = await this.installedOllamaTags();
    const auto: ModelChoice = {
      id: AUTO_MODEL,
      label: messages.model.autoLabel,
      description: messages.model.autoDescription,
      available: true,
    };
    const available = (info: ModelInfo): boolean =>
      info.provider === 'ollama'
        ? installed === undefined || LocalEngine.ollamaInstalled(info.model, installed)
        : isModelAvailable(info);
    // One "best available within this provider" choice per provider that has
    // registered models, available when any of its models can run now. A
    // disabled provider is flagged and never available.
    const registry = modelRegistry();
    const providers = [...new Set(registry.map((m) => m.provider))];
    const providerChoices: ModelChoice[] = providers.map((provider: ProviderName) => {
      const disabled = !isProviderEnabled(provider);
      return {
        id: `${PROVIDER_PIN_PREFIX}${provider}`,
        label: messages.model.providerLabel(providerLabels[provider]),
        description: messages.model.providerDescription(providerLabels[provider]),
        available:
          !disabled && registry.some((m) => m.provider === provider && available(m)),
        ...(disabled ? { disabled: true } : {}),
      };
    });
    const models = registry.map((info) => {
      const disabled = !isModelEnabled(info);
      return {
        id: info.id,
        label: info.label,
        description: info.description,
        available: !disabled && available(info),
        ...(disabled ? { disabled: true } : {}),
      };
    });
    return [auto, ...providerChoices, ...models];
  }
}
