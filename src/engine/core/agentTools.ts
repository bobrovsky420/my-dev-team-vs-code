/**
 * The engine-side tool proxies for the executor's (and planner's) tool-calling
 * loop. Each Mastra tool here is a thin delegate onto the host - the tool
 * inversion at the heart of the engine/client split: the engine decides *when*
 * to call a tool, the client owns *how* it runs (implementation, workspace
 * access, approval). Every call rides the host's single `tool` capability
 * (`host.execute(name, args)` -> `ClientHost.invoke('tool', …)`); the engine-built
 * `clarify` and `skill` go the same way, dispatched by name like a workspace
 * tool. The LocalEngine hands the host straight in; a remote/sidecar engine
 * satisfies the same calls with one `invoke` message over the wire, and the
 * agent cannot tell the difference. (Only `progress` is genuinely engine-local -
 * the executor intercepts it off the stream; it never reaches the client.)
 *
 * Names and descriptions come from the engine's tool configs
 * (../config/tools/*.md) - the same registry the planner's tool enum and the
 * agents' prompt sections are rendered from. Input schemas come from the
 * protocol's tool contract, so what the model is asked to produce is exactly
 * what the host validates against.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { convertJsonSchemaToZod } from 'zod-from-json-schema';
import { toolConfigs } from '../config/tools';
import { DynamicToolDef, ProgressStatusSchema } from '../../protocol/types';
import {
  clientTools,
  ClientToolName,
  ToolHost,
  CLARIFY_TOOL,
  SKILL_TOOL,
} from '../../protocol/toolContract';

/** Name of the engine-only progress tool (see ../config/tools/progress.md). */
export const PROGRESS_TOOL = 'progress';

/**
 * Input the planner's `clarify` tool takes: the one or two questions to ask.
 * Engine-built but a client call - unlike the workspace tools it has no client
 * contract in the protocol's `clientTools`, so its (model-facing) schema lives
 * here next to the tool. The model's call is validated against it before the
 * tool delegates to the client's `clarify` handler through the host.
 */
export const ClarifyInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe('The question to put to the user.'),
        options: z
          .array(z.string())
          .describe(
            'Likely answers offered as choices; leave empty for a free-form question.'
          ),
        allowOther: z
          .boolean()
          .describe('Whether the user may answer in their own words rather than pick an option.'),
      })
    )
    .min(1)
    .max(2)
    .describe('One or two focused questions to ask before drafting the plan.'),
});

/**
 * Input the executor's `skill` tool takes: the name of the skill to load.
 * Engine-built but a client call (the client holds the bodies) - it has no
 * client contract in `clientTools`, so its (model-facing) schema lives here.
 * The model's call is validated against it before the tool delegates to the
 * client's `skill` handler through the host.
 */
export const SkillInputSchema = z.object({
  name: z.string().describe('The name of the skill to load, as listed in "Available skills".'),
});

/**
 * Input the executor's `progress` tool takes: the plan steps to show and their
 * statuses. Unlike the workspace tools this never reaches the client - the
 * executor intercepts the call and turns it into a `progress` execution event
 * (see executor.ts), so the schema lives here, next to the tool, rather than
 * in the protocol's client tool contract.
 */
export const ProgressReportSchema = z.object({
  items: z
    .array(
      z.object({
        step: z
          .number()
          .int()
          .min(1)
          .describe('The 1-based number of the plan step, as drafted.'),
        status: ProgressStatusSchema.describe(
          'Where that step stands: "pending", "in_progress", or "done".'
        ),
      })
    )
    .describe('The plan steps to show, in the order to display them.'),
});

/**
 * The executor's tools observe the current run's AbortSignal so a cancelled
 * chat request stops them mid-flight (a running command is killed, a pending
 * write is dropped). The signal is per-run while the toolset is built once
 * per Executor, so it is read through a getter the Executor updates each run
 * rather than captured here.
 */
/**
 * Convert an MCP tool's published JSON Schema to a zod schema for Mastra, so
 * the model is told the tool's argument shape. Best effort: a schema that fails
 * to convert (or is not object-shaped) falls back to a permissive object, since
 * the client's MCP server is what actually validates the call's arguments - the
 * engine-side schema is only there to brief the model.
 */
function dynamicInputSchema(jsonSchema: unknown): z.ZodTypeAny {
  try {
    const schema = convertJsonSchemaToZod(jsonSchema as Record<string, unknown>);
    return schema as z.ZodTypeAny;
  } catch {
    return z.object({}).passthrough();
  }
}

/**
 * A proxy onto the client's ToolHost for one built-in tool: name and
 * description from the engine's tool config, input schema from the protocol's
 * tool contract, and an `execute` that delegates the call (and the run's abort
 * signal) to the host. Shared by the executor's full toolset and the planner's
 * read/search subset so the delegation lives in one place.
 */
function hostProxy(
  host: ToolHost,
  name: ClientToolName,
  getSignal?: () => AbortSignal | undefined
) {
  const config = toolConfigs[name];
  if (!config) {
    throw new Error(`Tool "${name}" has no engine-side config in config/tools.`);
  }
  return createTool({
    id: config.name,
    description: config.description,
    inputSchema: clientTools[name].inputSchema,
    execute: async (args) => host.execute(name, args, getSignal?.()),
  });
}

/**
 * A proxy for an engine-built model tool that has its own (model-facing) schema
 * rather than a `clientTools` contract - `clarify` and `skill`. The model's call
 * is validated against `inputSchema` by Mastra, then delegated to the client's
 * handler for that tool name through the host's `tool` capability, exactly like a
 * workspace tool. The client composes the model-facing result string (the
 * answers, or the skill body / a "no such skill" notice).
 */
function engineToolProxy(
  host: ToolHost,
  name: string,
  inputSchema: z.ZodTypeAny,
  getSignal?: () => AbortSignal | undefined
) {
  const config = toolConfigs[name];
  if (!config) {
    throw new Error(`Tool "${name}" has no engine-side config in config/tools.`);
  }
  return createTool({
    id: config.name,
    description: config.description,
    inputSchema,
    execute: async (args) => host.execute(name, args, getSignal?.()),
  });
}

export function buildAgentTools(
  host: ToolHost,
  getSignal?: () => AbortSignal | undefined,
  // The run's discovered MCP tools (client/mcp.ts), each surfaced as a proxy
  // that delegates to the host like the built-in tools. Absent or empty means
  // no MCP tools this run.
  dynamicTools?: readonly DynamicToolDef[]
) {
  const proxy = (name: ClientToolName) => hostProxy(host, name, getSignal);

  // The progress tool is the one genuinely engine-only tool: it has no client
  // implementation and never round-trips. Its execute just acknowledges - the
  // executor reads the call's arguments off the stream and renders them.
  const progressConfig = toolConfigs[PROGRESS_TOOL];
  if (!progressConfig) {
    throw new Error(`Tool "${PROGRESS_TOOL}" has no engine-side config in config/tools.`);
  }
  const progress = createTool({
    id: progressConfig.name,
    description: progressConfig.description,
    inputSchema: ProgressReportSchema,
    execute: async () => 'Progress shown to the user.',
  });

  // The skill tool is a client call like the workspace tools, just with its own
  // engine-side schema: it delegates to the client's `skill` handler, which
  // returns the loaded body (or a "no such skill" notice), and Mastra feeds that
  // back to the model. Progressive disclosure - a body enters the model's
  // context, and crosses the wire, only when a skill is actually loaded.
  const skill = engineToolProxy(host, SKILL_TOOL, SkillInputSchema, getSignal);

  // MCP tools have no engine-side `.md` config; their name, description, and
  // input schema all come from the run request (the server published them).
  // Each is a plain proxy onto the host - the host gates the call through the
  // Approver, exactly like a side-effecting built-in tool.
  const dynamic: Record<string, ReturnType<typeof createTool>> = {};
  for (const def of dynamicTools ?? []) {
    dynamic[def.name] = createTool({
      id: def.name,
      description: def.description,
      inputSchema: dynamicInputSchema(def.inputSchema),
      execute: async (args) => host.execute(def.name, args, getSignal?.()),
    });
  }

  return {
    read: proxy('read'),
    search: proxy('search'),
    run: proxy('run'),
    write: proxy('write'),
    edit: proxy('edit'),
    progress,
    skill,
    ...dynamic,
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;

/**
 * The planner's tools: the read-only `read` and `search` proxies (so it can
 * explore the workspace before committing to a plan, exactly the host calls the
 * executor makes - non-side-effecting, so never gated), and, when the client
 * offers it, the engine-built `clarify` tool. The planner never writes, edits,
 * or runs commands: it drafts, the executor carries out. `clarify` is built only
 * when the run's offered tools include it (the client lists it when it can show
 * the question pop-up); otherwise the planner simply cannot ask and drafts from a
 * reasonable assumption instead.
 */
export function buildPlannerTools(
  host: ToolHost,
  getSignal?: () => AbortSignal | undefined
) {
  const tools: Record<string, ReturnType<typeof createTool>> = {
    read: hostProxy(host, 'read', getSignal),
    search: hostProxy(host, 'search', getSignal),
  };
  if (host.tools.includes(CLARIFY_TOOL)) {
    tools.clarify = engineToolProxy(host, CLARIFY_TOOL, ClarifyInputSchema, getSignal);
  }
  return tools;
}

export type PlannerTools = ReturnType<typeof buildPlannerTools>;

/**
 * Render the executor prompt's "Additional tools" section from the run's MCP
 * tools: one line per tool naming it and what it does, flagged as requiring
 * approval (every MCP call is gated). Empty string when there are none, so the
 * section is omitted entirely. Mirrors `renderSkillsSection`.
 */
export function renderDynamicToolsSection(defs: readonly DynamicToolDef[]): string {
  if (defs.length === 0) {
    return '';
  }
  const lines = defs.map(
    (def) => `- "${def.name}": ${def.description} Requires user approval.`
  );
  return (
    '--- Additional tools (from connected MCP servers) ---\n' +
    lines.join('\n') +
    '\n--- End of additional tools ---'
  );
}
