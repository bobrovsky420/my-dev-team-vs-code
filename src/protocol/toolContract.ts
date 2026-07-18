/**
 * The tool half of the protocol: the names, input schemas, and client-facing
 * identity of the workspace tools the client offers an engine.
 *
 * The split mirrors the trust boundary. The client owns the implementations
 * (src/tools/) plus the display name transcripts render; the engine owns
 * everything model-facing - the descriptions its prompts carry and the
 * preview/snippet rendering hints (src/engine/config/tools/*.md). This module
 * is what both sides must agree on for a call to cross the boundary: which
 * tools exist and what arguments they take.
 *
 * These tools are private to `@devteam`: they are not contributed as editor-wide
 * Language Model Tools (no `package.json` `contributes.languageModelTools`, no
 * `vscode.lm.registerTool`), so no other chat model in the editor can call them.
 * The engine reaches them only through the run's `ClientHost` (`tool` capability).
 * Their describe() strings are the argument documentation the model sees.
 */
import { z } from 'zod';

export const clientTools = {
  read: {
    displayName: 'Read File',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path of the file to read.'),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to read (1-based, inclusive). Defaults to 1.'),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Last line to read (1-based, inclusive). Defaults to the per-call ' +
            'line cap counted from startLine; clamped to it when larger.'
        ),
    }),
  },
  search: {
    displayName: 'Search Files',
    inputSchema: z.object({
      query: z
        .string()
        .describe('Glob pattern (e.g. **/*.ts) or text to search for.'),
      mode: z
        .enum(['glob', 'content'])
        .describe(
          'Whether to match file names by glob or search file contents for text.'
        ),
    }),
  },
  run: {
    displayName: 'Run Command',
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute.'),
      dangerous: z
        .boolean()
        .optional()
        .describe(
          'Set to true when the command is destructive or irreversible - it ' +
            'deletes or overwrites files, rewrites or force-pushes history, ' +
            'resets working state, drops data, or otherwise cannot be easily ' +
            'undone (e.g. rm -rf, git reset --hard, git push --force, dropping ' +
            'a database). The user is warned and approves such a command ' +
            'separately from ordinary ones, so do not set it for reads, builds, ' +
            'tests, or installs.'
        ),
    }),
  },
  write: {
    displayName: 'Write File',
    inputSchema: z.object({
      path: z
        .string()
        .describe('Workspace-relative path of the file to create or update.'),
      contents: z.string().describe('The full new contents of the file.'),
    }),
  },
  edit: {
    displayName: 'Edit File',
    inputSchema: z.object({
      path: z
        .string()
        .describe('Workspace-relative path of the existing file to edit.'),
      oldText: z
        .string()
        .min(1)
        .describe(
          'The exact text to replace, copied verbatim from the file. ' +
            'Must match exactly one place; include surrounding lines to make it unique.'
        ),
      newText: z.string().describe('The text that replaces oldText.'),
    }),
  },
} as const;

export type ClientToolName = keyof typeof clientTools;

/** The tool names a client can offer, in a stable order. */
export const clientToolNames = Object.keys(clientTools) as ClientToolName[];

/**
 * Engine-built model tools that have no static `clientTools` contract (their
 * arguments are described engine-side) but are still *client calls*: the engine
 * offers them to the model, and the client dispatches them by name through the
 * `tool` capability, like a workspace tool, then composes the model-facing
 * result string. `clarify` asks the user a focused question or two mid-draft;
 * `skill` loads a skill's body by name. Shared here because both the engine
 * (which builds the tool under this name) and the client (which dispatches it)
 * must agree on the name, exactly like the `clientTools` names.
 */
export const CLARIFY_TOOL = 'clarify';
export const SKILL_TOOL = 'skill';

/**
 * The client-side tool executor: the tool slice of the engine->client
 * inversion. The implementation lives in the extension (it touches the user's
 * files, shell, and approval UI) and backs the `tool` capability of the run's
 * `ClientHost` (see capabilities.ts) - the LocalEngine calls it directly, a
 * remote/sidecar engine reaches it through an `invoke` of the `tool` capability.
 * Approval is internal to the host - an engine only ever sees the returned text
 * (a declined command returns its "not approved" message, not an error). The
 * engine-side `HostFacade` is a `ToolHost`, so the planner/executor reach their
 * tools through the same one inversion seam.
 */
export interface ToolHost {
  /** Names of the tools this host implements (the run's `offeredTools`). */
  readonly tools: readonly string[];
  /**
   * Execute one tool. `args` is validated against the tool's input schema
   * before anything runs; an unknown tool or invalid arguments throw. The
   * returned string is exactly what the model sees as the tool result.
   * `correlationId`, when given, identifies the run the call belongs to so an
   * approval prompt can be attributed to the session that owns it (see
   * `Approver.confirm`); the client binds it per run, the engine never sees it.
   */
  execute(
    tool: string,
    args: unknown,
    signal?: AbortSignal,
    correlationId?: string
  ): Promise<string>;
}
