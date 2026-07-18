/**
 * The extension's ToolHost: the one place a tool call from an engine is
 * validated and dispatched onto the workspace implementations - the client half
 * of the engine's tool inversion (the `tool` capability of the run's
 * ClientHost). Whichever engine is selected - in-process today, remote later -
 * the hands stay here: file access, the shell, the approval gate, and the run
 * mirror all live on the user's machine, so an engine can only ever *ask* for a
 * side effect. The tools are private to `@devteam`; they are not exposed as
 * editor-wide Language Model Tools for other chat models to call.
 *
 * Dispatch is derived from the protocol's tool contract rather than written
 * out per tool: `handlers` carries one entry per `clientTools` name, and
 * `execute` looks the call up, parses with the contract's schema, and invokes
 * it. There is no per-tool branch to keep in step with the contract - a tool
 * added to `clientTools` with no handler (or a handler reading the wrong
 * argument) is a compile error, so the name set cannot drift between the
 * contract and the host.
 */
import { z } from 'zod';
import { Approver, ChangeReporter, McpInvoker, RunMirror } from './types';
import { readFile, searchFiles, runCommand, writeFile, editFile } from './workspaceTools';
import { messages } from '../config/messages';
import { uiLimits } from '../config/uiLimits';
import {
  clientTools,
  clientToolNames,
  ClientToolName,
  ToolHost,
} from '../protocol/toolContract';

/** Compact, bounded preview of an MCP call's arguments for the approval prompt. */
function mcpArgsPreview(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = String(args);
  }
  const max = uiLimits.approval.mcpArgsPreviewMaxChars;
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * The client-side seams a handler may reach for beyond its own arguments. The
 * host owns these (an engine never sees them): `run` needs the approval gate
 * and the run mirror, `write`/`edit` report each landed change and (when
 * `myDevTeam.approval.fileChanges` is on) go through the same approval gate, and
 * every implementation observes the run's abort signal so a cancelled request
 * stops it mid-flight. `read` and `search` use none of it.
 */
interface ToolContext {
  readonly approver: Approver;
  readonly mirror?: RunMirror;
  readonly changes?: ChangeReporter;
  readonly signal?: AbortSignal;
}

/**
 * One handler per contract tool, keyed by the tool's name; the argument type
 * of each is inferred from that tool's input schema in `clientTools`, so the
 * dispatch table is type-checked against the contract it implements.
 */
type ToolHandlers = {
  [Name in ClientToolName]: (
    args: z.infer<(typeof clientTools)[Name]['inputSchema']>,
    ctx: ToolContext
  ) => Promise<string>;
};

const handlers: ToolHandlers = {
  read: (args) => readFile(args.path, args.startLine, args.endLine),
  search: async (args) => {
    const results = await searchFiles(args.query, args.mode);
    return results.length ? results.join('\n') : '(no matches)';
  },
  run: (args, ctx) =>
    runCommand(args.command, ctx.approver, ctx.mirror, ctx.signal, args.dangerous),
  write: (args, ctx) =>
    writeFile(args.path, args.contents, ctx.signal, ctx.changes, ctx.approver),
  edit: (args, ctx) =>
    editFile(args.path, args.oldText, args.newText, ctx.signal, ctx.changes, ctx.approver),
};

export class WorkspaceToolHost implements ToolHost {
  /**
   * The built-in tools plus any discovered MCP tools. A getter (not a fixed
   * field) so it reflects the MCP tools the hub has discovered by the time the
   * chat handler reads it - the handler primes discovery (mcp.listToolDefs)
   * before building the run request, so the offered names and the shipped
   * dynamicTools stay the same set.
   */
  get tools(): readonly string[] {
    return this.mcp ? [...clientToolNames, ...this.mcp.names()] : clientToolNames;
  }

  constructor(
    private readonly approver: Approver,
    private readonly mirror?: RunMirror,
    private readonly changes?: ChangeReporter,
    /**
     * The MCP seam. When supplied, a tool name the static handlers do not own
     * but the invoker recognises is dispatched to it - through the Approver
     * first, since an MCP server is third-party code. Absent, only the built-in
     * tools exist.
     */
    private readonly mcp?: McpInvoker
  ) {}

  /**
   * Validate the arguments against the protocol's input schema for the tool,
   * then run the workspace implementation. Inputs are untrusted twice over -
   * they come from a model, possibly relayed by a remote engine - so an
   * unknown tool or malformed arguments throw before anything touches the
   * workspace; the path checks (and, for `run`, the approval gate) inside the
   * implementations then still apply.
   */
  async execute(
    tool: string,
    args: unknown,
    signal?: AbortSignal,
    correlationId?: string
  ): Promise<string> {
    // Forward the run's correlation id to the approval prompt without changing
    // every tool's signature: a thin wrapper tags each confirm with it, so a
    // gated tool calls `confirm(title, detail)` as before and the prompt still
    // renders in the session that owns the run. Without an id (a run wired with
    // no approval session, e.g. the internal compaction pass) the real approver
    // is used unwrapped.
    const approver: Approver =
      correlationId === undefined
        ? this.approver
        : {
            confirm: (title, detail, scope, _correlationId, alwaysAllow) =>
              this.approver.confirm(title, detail, scope, correlationId, alwaysAllow),
          };

    // `hasOwnProperty`, not `in`, so an inherited name ("constructor") cannot
    // resolve to a handler.
    if (Object.prototype.hasOwnProperty.call(handlers, tool)) {
      const name = tool as ClientToolName;
      const parsed = clientTools[name].inputSchema.parse(args);
      const ctx: ToolContext = {
        approver,
        mirror: this.mirror,
        changes: this.changes,
        signal,
      };
      // `parsed` was validated against this tool's own schema and `handlers` is
      // keyed by the same names, so the call is sound; the cast only bridges
      // what TypeScript cannot prove across the two indexed lookups.
      return (handlers[name] as (a: unknown, c: ToolContext) => Promise<string>)(
        parsed,
        ctx
      );
    }

    // A discovered MCP tool: gate every call through the Approver (an MCP server
    // is third-party code), then dispatch to the invoker. The MCP server owns
    // the tool's schema and validates the arguments, so the host forwards them
    // as given rather than re-validating against a contract it does not have.
    if (this.mcp?.has(tool)) {
      // Scope "Allow All" to this exact MCP tool (the namespaced name), so
      // approving every call to one server's tool never allows a sibling tool.
      const approved = await approver.confirm(
        messages.approval.mcpToolTitle,
        messages.approval.mcpToolDetail(tool, mcpArgsPreview(args)),
        tool
      );
      if (!approved) {
        return messages.notApproved.mcp;
      }
      return this.mcp.execute(tool, args, signal);
    }

    throw new Error(`Unknown tool "${tool}".`);
  }
}
