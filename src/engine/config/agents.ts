/**
 * Agent configuration registry. Each agent is described by a `.md` file in
 * ./agents: frontmatter carries the structured fields (id, name, description,
 * model role, tool list) and the markdown body is the system prompt. esbuild's
 * text loader inlines each file as a string at build time (see package.json
 * `package` script and config/markdown.d.ts), so this is all resolved on
 * import with no runtime file I/O.
 *
 * Agents do not name a concrete model. Their frontmatter declares weighted
 * capability requirements (see ./models), and the router picks the best
 * registered model for that profile at wiring time (core/models.ts).
 *
 * The body never hardcodes tool descriptions: a `{{tools}}` placeholder (or,
 * absent one, the end of the prompt) is filled with a section rendered from
 * the frontmatter `tools` list and the configs in ./tools. An optional
 * `{{environment}}` placeholder is filled with the runtime OS/shell facts
 * from ./environment, so prompts never hardcode a platform. An
 * `{{ include <name> }}` directive is replaced with a shared partial from
 * ./partials (see partials.ts), so a cross-cutting rule lives in one file.
 * Agent classes in src/core import from here, never from the `.md` files
 * directly.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { CapabilityScoresSchema } from './models';
import { toolNames, renderToolsSection } from './tools';
import { resolveIncludes } from './partials';
import { renderEnvironmentSection } from '../../config/environment';
import triage from './agents/triage.md';
import responder from './agents/responder.md';
import planner from './agents/planner.md';
import answerer from './agents/answerer.md';
import executor from './agents/executor.md';
import summarizer from './agents/summarizer.md';
import compacter from './agents/compacter.md';

const TOOLS_PLACEHOLDER = '{{tools}}';
const ENVIRONMENT_PLACEHOLDER = '{{environment}}';
// Part of the unified prompt-body conventions (my-dev-team TODO 1.3): a body
// may carry a {{skills}} placeholder for the loader that renders a skills
// catalog. This app serves skills inside the composed request instead, so the
// placeholder is stripped rather than rendered - the body stays portable.
const SKILLS_PLACEHOLDER = '{{skills}}';

const AgentFrontmatterSchema = z.object({
  /** Stable agent id, used as the Mastra Agent id. */
  id: z.string(),
  /** Human-readable agent name. */
  name: z.string(),
  /** One-line summary of what the agent does. */
  description: z.string(),
  /**
   * How much each capability matters to this agent (0–1 weights). The router
   * matches these against the scores in the model registry (see models.ts)
   * and wires the best-fitting model — agents never name a concrete model.
   */
  capabilities: CapabilityScoresSchema,
  /** Names of the tools (see ./tools) this agent may plan with. */
  tools: z.array(z.enum(toolNames as [string, ...string[]])).default([]),
  /**
   * Optional sampling parameters, snake_cased to match the unified agent
   * config format shared with the my-dev-team pipeline (TODO 1.3/3.8 there).
   * Unset means the provider's default - most agents want that; a classifier
   * (triage) wants a low temperature for stable routing.
   */
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
});

/** AI SDK call settings derived from an agent's sampling frontmatter. */
export interface AgentModelSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
}

export interface AgentConfig extends z.infer<typeof AgentFrontmatterSchema> {
  /** Full system prompt: the markdown body with the tools section rendered in. */
  instructions: string;
  /**
   * The sampling frontmatter as AI SDK `modelSettings`, ready to pass to
   * `agent.generate`/`agent.stream`; undefined when the config sets none, so
   * callers can spread nothing and keep provider defaults.
   */
  modelSettings?: AgentModelSettings;
}

/** Exported for tests; production code reads the built `agents` registry. */
export function buildInstructions(body: string, tools: readonly string[]): string {
  // Expand shared partials first, so an included block can itself carry the
  // {{environment}} / {{tools}} placeholders resolved below.
  const withIncludes = resolveIncludes(body);
  const withEnvironment = withIncludes
    .replace(ENVIRONMENT_PLACEHOLDER, renderEnvironmentSection())
    .replace(SKILLS_PLACEHOLDER, '');
  const section = tools.length > 0 ? renderToolsSection(tools) : '';
  return withEnvironment.includes(TOOLS_PLACEHOLDER)
    ? withEnvironment.replace(TOOLS_PLACEHOLDER, section)
    : [withEnvironment, section].filter(Boolean).join('\n\n');
}

function modelSettingsOf(
  meta: z.infer<typeof AgentFrontmatterSchema>
): AgentModelSettings | undefined {
  const settings: AgentModelSettings = {
    ...(meta.temperature !== undefined ? { temperature: meta.temperature } : {}),
    ...(meta.top_p !== undefined ? { topP: meta.top_p } : {}),
    ...(meta.top_k !== undefined ? { topK: meta.top_k } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function loadAgent(raw: string): AgentConfig {
  const { data, body } = parseFrontmatter(raw);
  const meta = AgentFrontmatterSchema.parse(data);
  return {
    ...meta,
    instructions: buildInstructions(body.trim(), meta.tools),
    modelSettings: modelSettingsOf(meta),
  };
}

export const agents = {
  triage: loadAgent(triage),
  responder: loadAgent(responder),
  planner: loadAgent(planner),
  answerer: loadAgent(answerer),
  executor: loadAgent(executor),
  summarizer: loadAgent(summarizer),
  compacter: loadAgent(compacter),
} as const;

export type AgentName = keyof typeof agents;
