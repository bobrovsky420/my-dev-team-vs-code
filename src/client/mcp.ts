/**
 * The client's connection to user-configured MCP (Model Context Protocol)
 * servers. Like skills and instructions, this is client work by design: the
 * engine is stateless and has no filesystem or process access, so the client
 * launches the servers, discovers their tools, and ships the tool definitions
 * on the run request; the engine offers them to the executor and reaches a
 * call back through the client's ToolHost (see tools/toolHost.ts), so an MCP
 * tool runs exactly where every other tool runs - on the user's machine, behind
 * the user's Approver.
 *
 * Servers are launched over stdio and connected once for the hub's lifetime
 * (each is a child process; reconnecting per turn would spawn and kill it
 * repeatedly), so new or changed servers take effect on a window reload. A
 * server that fails to connect or list its tools is skipped, never thrown - a
 * broken server must not break the turn. The whole hub is inert (connects to
 * nothing, offers no tools) in an untrusted workspace, since the server command
 * comes from untrusted workspace configuration.
 *
 * The SDK client/transport are created through an injected connector so tests
 * never spawn a real process; the production default lazily imports the MCP SDK
 * only when it actually connects.
 */
import * as vscode from 'vscode';
import { DynamicToolDef } from '../protocol/types';
import { McpInvoker } from '../tools/types';
import { McpServerConfig, settings } from '../config/settings';
import { truncateForDisplay } from '../config/messages';

/** Prefix every MCP tool name carries, so it cannot collide with a built-in tool. */
export const MCP_TOOL_PREFIX = 'mcp__';

/** One tool as an MCP server lists it (before namespacing). */
export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A live connection to one MCP server, behind the bits the hub needs. */
export interface McpConnection {
  listTools(): Promise<RawMcpTool[]>;
  callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/**
 * Opens a connection to one configured server. Injected so tests drive the hub
 * with a fake; the production default is `connectStdioServer`.
 */
export type McpConnector = (config: McpServerConfig) => Promise<McpConnection>;

/** Reject a promise that does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Flatten an MCP `callTool` result's content blocks to the text the model sees.
 * Text blocks pass through; a non-text block (image, resource…) is noted by its
 * type so the model knows something was returned it cannot read inline. An
 * error result is prefixed so the model can react to it.
 */
function flattenContent(result: {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}): string {
  const parts = (result.content ?? []).map((block) =>
    block.type === 'text' && typeof block.text === 'string'
      ? block.text
      : `[${block.type ?? 'content'} omitted]`
  );
  const text = parts.join('\n').trim();
  return result.isError ? `Error: ${text || 'the MCP tool reported an error.'}` : text;
}

/**
 * The production connector: lazily import the MCP SDK (so neither the test
 * suite nor a run with no servers ever loads it) and open a stdio connection.
 */
export const connectStdioServer: McpConnector = async (config) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // Merge over the SDK's safe default environment rather than replacing it, so
    // the server still sees PATH etc. but the user's env entries win.
    env: config.env,
  });
  const client = new Client(
    { name: 'my-dev-team', version: '0.44.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return {
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    async callTool(tool, args, signal) {
      const res = await client.callTool(
        { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal, timeout: settings.mcp.callTimeoutMs }
      );
      return flattenContent(res as Parameters<typeof flattenContent>[0]);
    },
    async close() {
      await client.close();
    },
  };
};

export class McpHub implements McpInvoker {
  /** Live server connections, keyed by server name. */
  private readonly connections = new Map<string, McpConnection>();
  /** Namespaced tool name -> the server and bare tool name to dispatch to. */
  private readonly routes = new Map<string, { server: string; tool: string }>();
  /** The discovered tool definitions, in discovery order. */
  private toolDefs: DynamicToolDef[] = [];
  /** Memoised discovery: connecting per turn would re-spawn the servers. */
  private discovery?: Promise<DynamicToolDef[]>;

  constructor(private readonly connector: McpConnector = connectStdioServer) {}

  names(): readonly string[] {
    return this.toolDefs.map((def) => def.name);
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  async listToolDefs(): Promise<DynamicToolDef[]> {
    // Do not memoise the empty result from an untrusted workspace: discovery is
    // gated on trust, so caching `[]` here would mean granting trust mid-session
    // never surfaces the MCP tools (they would appear only after a window
    // reload). Short-circuit without setting `this.discovery`, so the first call
    // *after* trust is granted runs - and memoises - a real discovery. See
    // FIX.md, finding B-3.
    if (!vscode.workspace.isTrusted) {
      return [];
    }
    if (!this.discovery) {
      this.discovery = this.discover();
    }
    return this.discovery;
  }

  private async discover(): Promise<DynamicToolDef[]> {
    // Untrusted input: the server command comes from workspace configuration, so
    // launch nothing until the workspace is trusted. `listToolDefs` already gates
    // on trust (and avoids memoising the empty result); this stays as a defensive
    // guard for the private path.
    if (!vscode.workspace.isTrusted) {
      return [];
    }
    const servers = settings.mcp.servers;
    const defs: DynamicToolDef[] = [];
    for (const server of servers) {
      if (defs.length >= settings.mcp.maxTools) {
        break;
      }
      let connection: McpConnection;
      try {
        connection = await withTimeout(
          this.connector(server),
          settings.mcp.connectTimeoutMs,
          `MCP server "${server.name}"`
        );
      } catch (err) {
        console.warn(`[My Dev Team] MCP server "${server.name}" failed to connect:`, err);
        continue;
      }
      this.connections.set(server.name, connection);
      let tools: RawMcpTool[];
      try {
        tools = await connection.listTools();
      } catch (err) {
        console.warn(`[My Dev Team] MCP server "${server.name}" failed to list tools:`, err);
        continue;
      }
      for (const tool of tools) {
        if (defs.length >= settings.mcp.maxTools) {
          break;
        }
        const name = `${MCP_TOOL_PREFIX}${server.name}__${tool.name}`;
        if (this.routes.has(name)) {
          continue; // A duplicate (same server+tool name); keep the first.
        }
        this.routes.set(name, { server: server.name, tool: tool.name });
        defs.push({
          name,
          description:
            tool.description?.trim() ||
            `Tool "${tool.name}" from the "${server.name}" MCP server.`,
          inputSchema: tool.inputSchema ?? { type: 'object' },
        });
      }
    }
    this.toolDefs = defs;
    return defs;
  }

  async execute(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const route = this.routes.get(name);
    if (!route) {
      throw new Error(`Unknown MCP tool "${name}".`);
    }
    const connection = this.connections.get(route.server);
    if (!connection) {
      throw new Error(`MCP server "${route.server}" is not connected.`);
    }
    const text = await connection.callTool(route.tool, args, signal);
    return truncateForDisplay(text, settings.mcp.resultMaxChars);
  }

  /** Close every server connection. Safe to call more than once. */
  async dispose(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.routes.clear();
    this.toolDefs = [];
    this.discovery = undefined;
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }
}
