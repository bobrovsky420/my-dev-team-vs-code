import { Agent } from '@mastra/core/agent';
import type { ModelMessage } from 'ai';
import { contextWindowFor, resolveModel, routeModel } from './models';
import {
  buildAgentTools,
  renderDynamicToolsSection,
  PROGRESS_TOOL,
  ProgressReportSchema,
} from './agentTools';
import { estimateTokenCounts, readUsage, UsageReporter } from './usage';
import {
  runToolLoop,
  CheckpointPrompt,
  ContextWarningSink,
  StreamBatch,
} from './toolLoop';
import { condenseThinking } from './thinking';
import { agents } from '../config/agents';
import { withSteering } from '../config/steering';
import { toolConfigs } from '../config/tools';
import { limits } from '../../config/limits';
import { runtimeConfig } from '../../config/runtimeConfig';
import {
  DynamicToolDef,
  ExecutionEvent,
  Execution,
  ExecutionSchema,
  PartialExecution,
} from '../../protocol/types';
import { Complexity } from '../../protocol/types';
import { ToolHost } from '../../protocol/toolContract';

export type { CheckpointPrompt, ContextWarningSink } from './toolLoop';

export { ExecutionSchema } from '../../protocol/types';
export type { ExecutionEvent, PartialExecution } from '../../protocol/types';

/**
 * The execution transcript shapes live in the protocol (src/protocol/types.ts):
 * the ordered interleaving of model commentary and tool calls *is* the
 * user-visible product of this agent, so its schema is part of the wire
 * contract. This file produces those events; the input/result previews are
 * computed here, bounded by config/limits.ts, because the engine is what
 * saw the full values.
 */
export type ExecutionResult = Execution;

/** Receives execution snapshots as the run produces them. Must not throw. */
export type ExecutionProgress = (partial: PartialExecution) => void;

/**
 * Receives a condensed line of the executor's reasoning as it works (the last
 * non-empty line of a reasoning model's `<think>` output, replaced as it
 * grows). Ephemeral and kept out of the transcript - it is a live status
 * signal, not part of what the run produced. Must not throw.
 */
export type ThinkingProgress = (line: string) => void;

/**
 * The wrap-up instruction appended to the conversation when execution is cut
 * short - by the user choosing "stop" at a check-in, or by hitting the step
 * ceiling - so the run ends with a real, in-context answer drawn from the work
 * already done rather than an abrupt, resultless cut-off. Streamed with tools
 * turned off so the model can only conclude, not start more work.
 */
const FINALIZE_INSTRUCTION =
  'Stop here and do not call any more tools. Based on everything you have ' +
  'gathered so far, give your best answer and conclusion now, noting briefly ' +
  'anything you did not get to.';

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Display preview of a tool call's arguments. When the tool's config names a
 * `previewArg`, only that value is shown - the transcript should say
 * "write calculator.py", not dump the args JSON with the file contents.
 * Otherwise falls back to compact JSON without Mastra's metadata.
 */
function inputPreview(tool: string, args: unknown): string {
  const max = limits.executor.inputPreviewMaxChars;
  if (typeof args !== 'object' || args === null) {
    return truncate(JSON.stringify(args) ?? '{}', max);
  }
  const { __mastraMetadata, ...rest } = args as Record<string, unknown>;
  const previewArg = toolConfigs[tool]?.previewArg;
  const headline = previewArg === undefined ? undefined : rest[previewArg];
  if (typeof headline === 'string' && headline) {
    return truncate(headline, max);
  }
  return truncate(JSON.stringify(rest), max);
}

/**
 * Multi-line snippet of a tool call's snippet argument: its first
 * `runtimeConfig().toolSnippetLines` lines (each bounded like the input
 * preview), with a truncation message when more follow. Undefined when the
 * tool has no `snippetArg`, the argument is missing or empty, or snippets
 * are turned off (line count 0).
 */
function inputSnippet(tool: string, args: unknown): string | undefined {
  const snippetArg = toolConfigs[tool]?.snippetArg;
  if (snippetArg === undefined || typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[snippetArg];
  const maxLines = runtimeConfig().toolSnippetLines;
  if (typeof value !== 'string' || !value.trim() || maxLines <= 0) {
    return undefined;
  }
  const lines = value.trimEnd().split('\n');
  const head = lines
    .slice(0, maxLines)
    .map((line) => truncate(line, limits.executor.inputPreviewMaxChars));
  if (lines.length > maxLines) {
    head.push('. . . (truncated)');
  }
  return head.join('\n');
}

/** Bounded preview of a tool result (ours return strings; be safe anyway). */
function resultPreview(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return truncate(text, limits.executor.resultPreviewMaxChars);
}

/**
 * Executes the drafted plan for a "planning" request. Unlike the planner and
 * the answerer this agent carries tools: Mastra drives the tool-calling loop
 * (model call -> tool calls -> results back to the model, up to
 * `settings.executor.maxSteps` iterations) over proxies that delegate every
 * call to the client's ToolHost - the host owns the implementations and the
 * approval gate, the engine only decides what to call.
 */
export class Executor {
  private readonly modelName: string;
  /** Registry id of the routed model, for the context-window lookup. */
  private readonly modelId: string;
  /** Display label of the routed model, shown in a context warning. */
  private readonly modelLabel: string;
  private readonly agent: Agent;
  /**
   * The current run's cancellation signal, set for the duration of `execute`.
   * The tool proxies read it through the getter handed to `buildAgentTools`,
   * so a cancelled request stops an in-flight command or write even though
   * the toolset itself is built once here.
   */
  private currentSignal: AbortSignal | undefined;

  /**
   * `modelPin` is the user's per-run model choice (a registry id, or "auto"/
   * undefined for the capability router). `complexity` is triage's judgement of
   * how demanding the work is: it narrows the routed model to the request's tier
   * (cheaper for simple work, stronger for complex), unless the user pinned a
   * model or turned `complexityRouting` off. The executor is built once the
   * complexity is known (the workflow's execute step builds it), so both are
   * resolved here.
   */
  constructor(
    toolHost: ToolHost,
    modelPin?: string,
    complexity?: Complexity,
    // The run's MCP tools (discovered client-side, shipped on the request).
    // Each becomes a tool proxy, and they are listed in an extra prompt section
    // so the model knows they exist alongside the built-in tools.
    dynamicTools?: readonly DynamicToolDef[]
  ) {
    const routed = routeModel(agents.executor.capabilities, modelPin, undefined, complexity);
    this.modelName = routed.model;
    this.modelId = routed.id;
    this.modelLabel = routed.label;
    const dynamicSection = renderDynamicToolsSection(dynamicTools ?? []);
    const steered = withSteering(agents.executor.instructions, routed);
    const instructions = dynamicSection ? `${steered}\n\n${dynamicSection}` : steered;
    this.agent = new Agent({
      id: agents.executor.id,
      name: agents.executor.name,
      description: agents.executor.description,
      instructions,
      model: resolveModel(agents.executor.capabilities, modelPin, undefined, complexity),
      tools: buildAgentTools(toolHost, () => this.currentSignal, dynamicTools),
    });
  }

  async execute(
    prompt: string,
    onPartial?: ExecutionProgress,
    signal?: AbortSignal,
    onUsage?: UsageReporter,
    onThinking?: ThinkingProgress,
    onCheckpoint?: CheckpointPrompt,
    onContextWarning?: ContextWarningSink
  ): Promise<ExecutionResult> {
    this.currentSignal = signal;
    try {
      return await this.run(
        prompt,
        onPartial,
        signal,
        onUsage,
        onThinking,
        onCheckpoint,
        onContextWarning
      );
    } finally {
      this.currentSignal = undefined;
    }
  }

  private async run(
    prompt: string,
    onPartial: ExecutionProgress | undefined,
    signal: AbortSignal | undefined,
    onUsage: UsageReporter | undefined,
    onThinking: ThinkingProgress | undefined,
    onCheckpoint: CheckpointPrompt | undefined,
    onContextWarning: ContextWarningSink | undefined
  ): Promise<ExecutionResult> {
    const events: ExecutionEvent[] = [];
    // Tool results arrive by call id, possibly after further chunks; map the
    // id back to the event the matching tool-call chunk created.
    const pendingCalls = new Map<string, ExecutionEvent & { kind: 'tool' }>();
    // Snapshots are shallow copies: the sink must see the state as of each
    // emission, not a live view that later mutations of the last event change.
    const emit = () => onPartial?.({ events: events.map((event) => ({ ...event })) });

    // The model's reasoning, accumulated only to condense the latest line for
    // the thinking sink. Deliberately not added to `events`: thinking is an
    // ephemeral status signal, not part of the transcript the run produced.
    let reasoning = '';

    // Drain one batch's full chunk stream into the shared transcript: reading it
    // is what drives that batch's tool-calling loop to completion, so this runs
    // even when nobody listens to `onPartial`. Throws on an `error` chunk so a
    // broken run fails the step (the UI then renders the executor error).
    const drainBatch = async (stream: ReadableStream<unknown>): Promise<void> => {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value as { type: string; payload?: any };
        switch (chunk.type) {
          // A reasoning model streams its `<think>` monologue as reasoning chunks
          // (Mastra surfaces them as `reasoning-delta`/`reasoning`). Condense the
          // buffer to its latest line and forward it as live thinking; never push
          // it to `events`, so it stays out of the transcript. Skipped entirely
          // when nobody is listening (the setting is off).
          case 'reasoning-delta':
          case 'reasoning': {
            if (onThinking) {
              const delta: string = chunk.payload?.text ?? '';
              if (delta) {
                reasoning += delta;
                const line = condenseThinking(reasoning, limits.thinking.lineMaxChars);
                if (line) {
                  onThinking(line);
                }
              }
            }
            break;
          }
          case 'text-delta': {
            const delta: string = chunk.payload?.text ?? '';
            if (!delta) {
              break;
            }
            const last = events[events.length - 1];
            if (last?.kind === 'text') {
              last.text += delta;
            } else {
              events.push({ kind: 'text', text: delta });
            }
            emit();
            break;
          }
          case 'tool-call': {
            const tool = String(chunk.payload?.toolName ?? '');
            // The progress tool is engine-only: rather than a transcript tool
            // call, its arguments become a `progress` checklist event. A
            // malformed or empty report is dropped (it only fails to render,
            // never the run), and its result chunk is ignored below because it
            // was never put in `pendingCalls`.
            if (tool === PROGRESS_TOOL) {
              const parsed = ProgressReportSchema.safeParse(chunk.payload?.args);
              if (parsed.success && parsed.data.items.length > 0) {
                events.push({ kind: 'progress', items: parsed.data.items });
                emit();
              }
              break;
            }
            const snippet = inputSnippet(tool, chunk.payload?.args);
            const event = {
              kind: 'tool' as const,
              tool,
              input: inputPreview(tool, chunk.payload?.args),
              ...(snippet === undefined ? {} : { snippet }),
            };
            events.push(event);
            pendingCalls.set(String(chunk.payload?.toolCallId ?? ''), event);
            emit();
            break;
          }
          case 'tool-result': {
            const event = pendingCalls.get(String(chunk.payload?.toolCallId ?? ''));
            if (event) {
              event.result = resultPreview(chunk.payload?.result);
              if (chunk.payload?.isError) {
                event.failed = true;
              }
              emit();
            }
            break;
          }
          case 'tool-error': {
            const event = pendingCalls.get(String(chunk.payload?.toolCallId ?? ''));
            if (event) {
              event.result = resultPreview(
                chunk.payload?.error instanceof Error
                  ? chunk.payload.error.message
                  : chunk.payload?.error
              );
              event.failed = true;
              emit();
            }
            break;
          }
          case 'error': {
            // The run itself broke (model unreachable, stream aborted…); fail
            // the step so the UI renders the executor error with the hint.
            const error = chunk.payload?.error;
            throw error instanceof Error ? error : new Error(String(error));
          }
        }
      }
    };

    // One batch: stream the model over the carried messages, drain its chunks
    // into the transcript, and report the metadata the loop aggregates. Reading
    // the response and usage is best-effort - a provider that surfaces neither
    // must never fail the run the work already produced.
    const streamBatch: StreamBatch = async (messages, control) => {
      const options: Record<string, unknown> = {};
      if (agents.executor.modelSettings) {
        options.modelSettings = agents.executor.modelSettings;
      }
      if (control.stopWhen !== undefined) {
        options.stopWhen = control.stopWhen;
      }
      if (control.toolChoice !== undefined) {
        options.toolChoice = control.toolChoice;
      }
      if (control.signal) {
        options.abortSignal = control.signal;
      }
      const output = await this.agent.stream(messages, options as never);
      await drainBatch(output.fullStream as ReadableStream<unknown>);
      let responseMessages: ModelMessage[] = [];
      try {
        const response = (await output.response) as { messages?: ModelMessage[] };
        if (Array.isArray(response?.messages)) {
          responseMessages = response.messages;
        }
      } catch {
        // No response messages to carry; the next batch re-sends what we have.
      }
      const counts = await readUsage(output);
      let steps = 0;
      let finishReason: string | undefined;
      try {
        steps = (await output.steps)?.length ?? 0;
        finishReason = await output.finishReason;
      } catch {
        // Treat missing metadata as a cut-off batch (not a natural finish).
      }
      return { steps, finishReason, counts, responseMessages };
    };

    const { totals, anyReported } = await runToolLoop({
      prompt,
      streamBatch,
      finalizeInstruction: FINALIZE_INSTRUCTION,
      lastActionLabel: () => lastActionLabel(events),
      signal,
      onCheckpoint,
      contextWindow: onContextWarning ? contextWindowFor(this.modelId) : undefined,
      modelLabel: this.modelLabel,
      onContextWarning,
    });

    // The transcript's text events are the model's prose output; join them as
    // the reply estimate for when the SDK reports no counts.
    const replyText = events
      .map((event) => (event.kind === 'text' ? event.text : ''))
      .join('');
    onUsage?.({
      model: this.modelName,
      ...(anyReported ? totals : estimateTokenCounts(prompt, replyText)),
    });

    // Validate rather than cast, mirroring the planner: a malformed transcript
    // fails here with a schema error instead of rendering broken markdown.
    return ExecutionSchema.parse({ events });
  }
}

/**
 * A short label of the most recent action for a check-in prompt: the last
 * transcript tool call's name, or undefined when none has happened yet (so the
 * prompt can omit it rather than show an empty value).
 */
function lastActionLabel(events: readonly ExecutionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'tool') {
      return event.tool;
    }
  }
  return undefined;
}
