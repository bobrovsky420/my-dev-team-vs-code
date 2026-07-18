/**
 * Tool configuration registry: the engine-side (model-facing) half of each
 * tool. Each tool the agents can plan with is described by a `.md` file in
 * ./tools, discovered by the glob import at build time: frontmatter carries
 * the structured fields (name, whether it is side-effecting, the transcript
 * preview hints), and the markdown body is the model-facing description.
 * `{{os}}`/`{{shell}}` placeholders in a description are filled from
 * config/environment.ts, so a tool can state which OS and shell it runs in.
 *
 * The client-side half - input schemas and display names - lives in the
 * protocol's tool contract (src/protocol/toolContract.ts) next to the
 * implementations it describes; this registry holds only what the engine's
 * prompts and transcripts need.
 *
 * Agents list the tools they may use in their own frontmatter (see agents.ts);
 * `renderToolsSection` turns that list into the "available tools" prompt
 * section, so prompts never hardcode tool descriptions.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { environment } from '../../config/environment';
import toolFiles from 'glob:./tools/*.md';

const ToolFrontmatterSchema = z.object({
  /** Short name agents and plan steps refer to the tool by. */
  name: z.string(),
  /** Side-effecting tools are gated by the client's Approver before they act. */
  sideEffecting: z.boolean(),
  /**
   * Input argument whose value summarises a call in the execution transcript
   * (e.g. "path" for write, so the user sees the file name rather than the
   * raw args JSON with the file contents). Optional: without it the
   * transcript falls back to a compact JSON preview of all arguments.
   */
  previewArg: z.string().optional(),
  /**
   * Input argument whose leading lines are shown as a fenced snippet beneath
   * the call line in the execution transcript (e.g. "contents" for write, so
   * the user sees the start of the file being written). The line count is
   * user-tunable (`myDevTeam.chat.toolSnippetLines`). Optional: without it
   * the call shows only the one-line preview.
   */
  snippetArg: z.string().optional(),
});

export interface ToolConfig extends z.infer<typeof ToolFrontmatterSchema> {
  /** Model-facing description (the markdown body of the config file). */
  description: string;
}

function loadTool(raw: string): ToolConfig {
  const { data, body } = parseFrontmatter(raw);
  // Descriptions may name the runtime environment via placeholders (the run
  // tool tells the model which OS and shell its command lands in).
  const description = body
    .trim()
    .replaceAll('{{os}}', environment.os)
    .replaceAll('{{shell}}', environment.shell);
  return { ...ToolFrontmatterSchema.parse(data), description };
}

/**
 * Parse a set of tool config files, rejecting duplicate names: `toolConfigs`
 * is keyed by name, so a duplicate would silently overwrite its predecessor.
 */
export function loadTools(files: readonly string[]): ToolConfig[] {
  const tools = files.map(loadTool);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}" in config/tools.`);
    }
    seen.add(tool.name);
  }
  return tools;
}

const all = loadTools(toolFiles);

export const toolConfigs: Record<string, ToolConfig> = Object.fromEntries(
  all.map((tool) => [tool.name, tool])
);

/** Tool names in config-filename order; the source of truth for tool enums. */
export const toolNames = all.map((tool) => tool.name);

/**
 * Render the "available tools" section of an agent's system prompt from the
 * agent's configured tool list.
 */
export function renderToolsSection(names: readonly string[]): string {
  const lines = names.map((name) => {
    const tool = toolConfigs[name];
    if (!tool) {
      throw new Error(`Unknown tool "${name}" in agent configuration.`);
    }
    const approval = tool.sideEffecting ? ' Requires user approval.' : '';
    return `- "${tool.name}": ${tool.description}${approval}`;
  });
  return `You have exactly ${names.length} tools available:\n${lines.join('\n')}`;
}
