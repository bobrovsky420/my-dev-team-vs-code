// The client-side UI seams of the tool layer. These stay in the extension
// forever - they gate and surface side effects on the user's machine - and
// they never cross the engine protocol: an engine only ever sees a tool's
// returned text, never how the approval or the mirroring happened. Nothing
// here imports `vscode` UI surfaces; the goal is that the tools do not care
// whether the front-end is a Chat Participant or a Webview.

import { DynamicToolDef } from '../protocol/types';

/**
 * The "Allow All" scopes the `run` tool gates with: one for ordinary commands,
 * one for the commands the model flags as destructive (see the run tool's
 * `dangerous` input). They are deliberately distinct so an allowance granted for
 * ordinary commands never silently approves a destructive one - that asks again
 * on its own scope. The relationship is one-directional, though: allowing all
 * *destructive* commands also allows ordinary ones (the Approver treats the
 * dangerous allowance as subsuming the ordinary one), since a user who waved
 * through the riskier command would not want the safer one to keep asking.
 */
export const RUN_SCOPE = 'run';
export const RUN_DANGEROUS_SCOPE = 'run:dangerous';

/**
 * The MCP seam: the client's connection to user-configured MCP servers, behind
 * an interface so the tool host (and tests) depend on a shape, not on the
 * concrete McpHub (client/mcp.ts) or the MCP SDK. The host routes any tool
 * whose name `has()` recognises through the Approver and then `execute()`;
 * `listToolDefs()` is what the chat handler ships on the run request (it also
 * primes the discovery the host's `tools` list reads), and `names()` is the
 * tools already discovered. All of it is empty in an untrusted workspace or
 * when no servers are configured.
 */
export interface McpInvoker {
  /** Names of the discovered MCP tools (namespaced "mcp__<server>__<tool>"). */
  names(): readonly string[];
  /** Whether `name` is a discovered MCP tool this invoker can execute. */
  has(name: string): boolean;
  /** Discover (connecting if needed) the MCP tools and their definitions. */
  listToolDefs(): Promise<DynamicToolDef[]>;
  /** Execute an MCP tool by its namespaced name; returns the text the model sees. */
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<string>;
}

/**
 * An optional "Always allow commands like this" choice on an approval prompt.
 * When the `run` tool offers one (only for an ordinary, non-destructive
 * command), the approver renders a third button alongside Approve / Allow All;
 * picking it approves this call and `apply`s the rule - appending the command's
 * leading prefix to the user's `myDevTeam.run.allowedCommands`, so later
 * matching commands skip the prompt across conversations and sessions. Unlike
 * "Allow All" (an in-memory, per-conversation grant), this persists. A
 * client-side seam, so a callback is fine here - it never crosses the protocol.
 */
export interface AlwaysAllowOption {
  /** The button label, e.g. "Always allow `git status`". */
  label: string;
  /** Persist the rule; awaited (best-effort) when the user picks the choice. */
  apply(): Promise<void>;
}

/**
 * The approval seam. Phase 1 implements this with chat confirmation buttons.
 * Phase 2 (Webview) implements the SAME interface with a rich diff/confirm
 * dialog. The agent core only ever calls `confirm()` and never knows which.
 */
export interface Approver {
  /**
   * Ask the user to approve a side-effecting action.
   * @param title   Short label, e.g. "Run command".
   * @param detail  The specific thing about to happen (command text, diff…).
   * @param scope   A stable key naming the *kind* of action, used by the "Allow
   *   All" choice to remember a per-conversation allowance: the tool name for
   *   the built-in tools (`run`, `write`, `edit`) and the namespaced tool name
   *   for an MCP call. Allowances are kept separate per scope, so "Allow All"
   *   for `write` never also allows `edit`, and approving one MCP tool never
   *   allows a sibling. The allowance lasts only for the current chat
   *   conversation - a new chat (or /clear) starts asking again.
   * @param correlationId  Optional id of the run the call belongs to, so a
   *   front-end with concurrent sessions (the ChatApprover) can render the
   *   prompt in the session that owns the call rather than the most recent one.
   *   Omitted only on a defensive no-owning-run path (a confirm with no session).
   * @param alwaysAllow  Optional persistent "always allow commands like this"
   *   choice (only the `run` tool, only for an ordinary command). When present,
   *   the approver offers it as a third button; picking it approves the call and
   *   `apply`s the rule.
   * @returns true if the user approved.
   */
  confirm(
    title: string,
    detail: string,
    scope: string,
    correlationId?: string,
    alwaysAllow?: AlwaysAllowOption
  ): Promise<boolean>;
}

/**
 * The change-tracking seam, shaped like the RunMirror: the `write` and `edit`
 * tools report each file they actually land (with its before/after text) to it,
 * and a UI implementation decides what to do with that (Phase 1 sums it into a
 * per-turn "N files changed, +X -Y" line under the reply; see
 * client/changeTracker.ts). The tool layer never computes the diff or knows
 * which front-end is listening. `report` is a fire-and-forget notification and
 * must not throw - a broken tracker must never fail the write it only observes.
 * It is called only after the write has succeeded, so a refused, declined, or
 * cancelled write contributes nothing.
 */
export interface ChangeReporter {
  /**
   * A file was written to disk.
   * @param path    The tool-relative path that was written.
   * @param before  The file's contents before the write ('' for a new file).
   * @param after   The file's contents after the write.
   */
  report(path: string, before: string, after: string): void;
}

/**
 * The run-transparency seam, shaped like the Approver: the `run` tool reports
 * each executed command's lifecycle to it, and a UI implementation decides how
 * to surface that (Phase 1 mirrors it into a "Dev Team" terminal the user can
 * open; see ui/runTerminal.ts). The tool layer never knows which. All methods
 * are fire-and-forget notifications and must not throw - a broken mirror must
 * never fail the command it is only observing.
 */
export interface RunMirror {
  /** A command was approved and is starting. */
  begin(command: string): void;
  /** A chunk of the live stdout/stderr of the running command. */
  output(chunk: string): void;
  /** The command finished; `note` is a one-line outcome (ok, failed, timeout). */
  end(note: string): void;
}
