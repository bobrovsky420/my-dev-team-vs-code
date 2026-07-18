import { describe, it, expect, beforeEach } from 'vitest';
import { McpHub, McpConnection, McpConnector } from '../src/client/mcp';
import { McpServerConfig } from '../src/config/settings';
import { __reset, __setConfig, __setTrusted } from './mocks/vscode';

/**
 * A fake MCP connection: serves a fixed tool list, records each call, and tracks
 * whether it was closed. No process is ever spawned.
 */
function fakeConnection(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  callResult: (tool: string, args: unknown) => string = () => 'ok'
): McpConnection & {
  calls: Array<{ tool: string; args: unknown }>;
  closed: boolean;
} {
  const state = { calls: [] as Array<{ tool: string; args: unknown }>, closed: false };
  return {
    ...state,
    async listTools() {
      return tools;
    },
    async callTool(tool, args) {
      this.calls.push({ tool, args });
      return callResult(tool, args);
    },
    async close() {
      this.closed = true;
    },
  };
}

/** A connector backed by a name -> connection map, recording which it opened. */
function fakeConnector(
  byName: Record<string, McpConnection>
): McpConnector & { opened: string[] } {
  const opened: string[] = [];
  const connector = (async (config: McpServerConfig) => {
    opened.push(config.name);
    const connection = byName[config.name];
    if (!connection) {
      throw new Error(`no fake for "${config.name}"`);
    }
    return connection;
  }) as McpConnector & { opened: string[] };
  connector.opened = opened;
  return connector;
}

/** Configure the servers the settings getter reads. */
function setServers(map: Record<string, { command: string; args?: string[] }>): void {
  __setConfig('myDevTeam.mcp.servers', map);
}

beforeEach(() => {
  __reset();
});

describe('McpHub', () => {
  it('discovers and namespaces each server tool as mcp__<server>__<tool>', async () => {
    setServers({ fs: { command: 'fs-cmd' } });
    const connector = fakeConnector({
      fs: fakeConnection([
        { name: 'read', description: 'read a file', inputSchema: { type: 'object' } },
        { name: 'write' },
      ]),
    });
    const hub = new McpHub(connector);

    const defs = await hub.listToolDefs();
    expect(defs.map((d) => d.name)).toEqual(['mcp__fs__read', 'mcp__fs__write']);
    expect(defs[0].description).toBe('read a file');
    // A tool with no description gets a generated one naming the server.
    expect(defs[1].description).toContain('fs');
    expect(hub.names()).toEqual(['mcp__fs__read', 'mcp__fs__write']);
    expect(hub.has('mcp__fs__read')).toBe(true);
    expect(hub.has('mcp__other')).toBe(false);
  });

  it('connects to nothing and offers no tools in an untrusted workspace', async () => {
    __setTrusted(false);
    setServers({ fs: { command: 'fs-cmd' } });
    const connector = fakeConnector({ fs: fakeConnection([{ name: 'read' }]) });
    const hub = new McpHub(connector);

    expect(await hub.listToolDefs()).toEqual([]);
    expect(hub.names()).toEqual([]);
    expect(connector.opened).toEqual([]);
  });

  it('discovers tools when trust is granted after an untrusted call (B-3)', async () => {
    // First call happens before trust is granted: it must not memoise the empty
    // result, or granting trust mid-session would never surface the tools.
    __setTrusted(false);
    setServers({ fs: { command: 'fs-cmd' } });
    const connector = fakeConnector({ fs: fakeConnection([{ name: 'read' }]) });
    const hub = new McpHub(connector);

    expect(await hub.listToolDefs()).toEqual([]);
    expect(connector.opened).toEqual([]);

    // The user grants workspace trust; the next call discovers for real.
    __setTrusted(true);
    const defs = await hub.listToolDefs();
    expect(defs.map((d) => d.name)).toEqual(['mcp__fs__read']);
    expect(connector.opened).toEqual(['fs']);
  });

  it('offers nothing when no servers are configured', async () => {
    const connector = fakeConnector({});
    const hub = new McpHub(connector);
    expect(await hub.listToolDefs()).toEqual([]);
    expect(connector.opened).toEqual([]);
  });

  it('routes execute to the matching server and bare tool name', async () => {
    setServers({ fs: { command: 'fs-cmd' } });
    const fs = fakeConnection([{ name: 'read' }], (tool, args) => `read ${JSON.stringify(args)}`);
    const hub = new McpHub(fakeConnector({ fs }));
    await hub.listToolDefs();

    const result = await hub.execute('mcp__fs__read', { path: 'a.txt' });
    expect(result).toBe('read {"path":"a.txt"}');
    expect(fs.calls).toEqual([{ tool: 'read', args: { path: 'a.txt' } }]);
  });

  it('caps an oversized MCP result', async () => {
    setServers({ fs: { command: 'fs-cmd' } });
    const big = 'x'.repeat(60_000);
    const hub = new McpHub(
      fakeConnector({ fs: fakeConnection([{ name: 'read' }], () => big) })
    );
    await hub.listToolDefs();
    const result = await hub.execute('mcp__fs__read', {});
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain('(truncated)');
  });

  it('skips a server that fails to connect but keeps the others', async () => {
    setServers({ broken: { command: 'nope' }, fs: { command: 'fs-cmd' } });
    const connector = (async (config: McpServerConfig) => {
      if (config.name === 'broken') {
        throw new Error('spawn failed');
      }
      return fakeConnection([{ name: 'read' }]);
    }) as McpConnector;
    const hub = new McpHub(connector);

    const defs = await hub.listToolDefs();
    expect(defs.map((d) => d.name)).toEqual(['mcp__fs__read']);
  });

  it('memoises discovery so servers connect once', async () => {
    setServers({ fs: { command: 'fs-cmd' } });
    const connector = fakeConnector({ fs: fakeConnection([{ name: 'read' }]) });
    const hub = new McpHub(connector);

    await hub.listToolDefs();
    await hub.listToolDefs();
    expect(connector.opened).toEqual(['fs']);
  });

  it('closes every connection on dispose', async () => {
    setServers({ fs: { command: 'fs-cmd' } });
    const fs = fakeConnection([{ name: 'read' }]);
    const hub = new McpHub(fakeConnector({ fs }));
    await hub.listToolDefs();

    await hub.dispose();
    expect(fs.closed).toBe(true);
    expect(hub.names()).toEqual([]);
  });

  it('throws when executing an unknown MCP tool', async () => {
    const hub = new McpHub(fakeConnector({}));
    await expect(hub.execute('mcp__fs__read', {})).rejects.toThrow(/Unknown MCP tool/);
  });
});
