import { describe, it, expect } from 'vitest';

import {
  buildAgentTools,
  buildPlannerTools,
  renderDynamicToolsSection,
} from '../src/engine/core/agentTools';
import { toolConfigs } from '../src/engine/config/tools';
import { ToolHost } from '../src/protocol/toolContract';
import { ClarifyQuestion, DynamicToolDef } from '../src/protocol/types';

/** ToolHost test double recording calls and returning a fixed result. */
function makeHost(
  result = 'ok',
  tools: readonly string[] = ['read', 'search', 'run', 'write', 'edit']
): ToolHost & {
  calls: Array<{ tool: string; args: unknown; signal?: AbortSignal }>;
} {
  const calls: Array<{ tool: string; args: unknown; signal?: AbortSignal }> = [];
  return {
    calls,
    tools,
    execute: async (tool, args, signal) => {
      calls.push({ tool, args, signal });
      return result;
    },
  };
}

/** Run a Mastra tool's execute with the minimal context the wrapper needs. */
function invoke(tool: { execute?: Function }, input: unknown): Promise<unknown> {
  return tool.execute!(input, {});
}

describe('buildAgentTools', () => {
  it('exposes the five workspace tools plus the engine-only progress and skill tools', () => {
    const tools = buildAgentTools(makeHost());
    expect(Object.keys(tools).sort()).toEqual([
      'edit',
      'progress',
      'read',
      'run',
      'search',
      'skill',
      'write',
    ]);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.id).toBe(toolConfigs[name].name);
      expect(tool.description).toBe(toolConfigs[name].description);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('builds progress as a local tool that acknowledges without a host call', async () => {
    const host = makeHost();
    const tools = buildAgentTools(host);
    const result = await invoke(tools.progress, {
      items: [{ step: 1, status: 'done' }],
    });
    expect(result).toBe('Progress shown to the user.');
    // The progress tool never delegates to the ToolHost.
    expect(host.calls).toHaveLength(0);
  });

  it('delegates the skill tool to the host by name (the client composes the result)', async () => {
    // The skill tool is now a client call through the `tool` capability, just
    // with its own engine-side schema: it forwards { name } to the host, which
    // returns the body (or a "no such skill" notice the client composes).
    const host = makeHost('the demo skill instructions');
    const tools = buildAgentTools(host);

    await expect(invoke(tools.skill, { name: 'demo' })).resolves.toBe(
      'the demo skill instructions'
    );
    expect(host.calls).toContainEqual(
      expect.objectContaining({ tool: 'skill', args: { name: 'demo' } })
    );
  });

  it('delegates each call to the ToolHost with the tool name and args', async () => {
    const host = makeHost('the result');
    const tools = buildAgentTools(host);

    await expect(invoke(tools.read, { path: 'src/a.ts' })).resolves.toBe('the result');
    await expect(
      invoke(tools.search, { query: '**/*.ts', mode: 'glob' })
    ).resolves.toBe('the result');
    await expect(invoke(tools.run, { command: 'echo hi' })).resolves.toBe('the result');
    await expect(
      invoke(tools.write, { path: 'a.ts', contents: 'x' })
    ).resolves.toBe('the result');
    await expect(
      invoke(tools.edit, { path: 'a.ts', oldText: 'x', newText: 'y' })
    ).resolves.toBe('the result');

    expect(host.calls.map((c) => c.tool)).toEqual([
      'read',
      'search',
      'run',
      'write',
      'edit',
    ]);
    expect(host.calls[0].args).toMatchObject({ path: 'src/a.ts' });
    expect(host.calls[2].args).toMatchObject({ command: 'echo hi' });
  });

  it('passes the current signal through to the host on every call', async () => {
    const controller = new AbortController();
    const host = makeHost();
    const tools = buildAgentTools(host, () => controller.signal);

    await invoke(tools.run, { command: 'echo hi' });
    await invoke(tools.write, { path: 'a.ts', contents: 'x' });

    expect(host.calls.every((c) => c.signal === controller.signal)).toBe(true);
  });

  it('reads the signal getter per call, not at build time', async () => {
    let signal: AbortSignal | undefined;
    const host = makeHost();
    const tools = buildAgentTools(host, () => signal);

    await invoke(tools.run, { command: 'one' });
    const controller = new AbortController();
    signal = controller.signal;
    await invoke(tools.run, { command: 'two' });

    expect(host.calls[0].signal).toBeUndefined();
    expect(host.calls[1].signal).toBe(controller.signal);
  });

  it('builds a proxy for each dynamic (MCP) tool that delegates to the host', async () => {
    const host = makeHost('mcp result');
    const defs: DynamicToolDef[] = [
      {
        name: 'mcp__fs__read',
        description: 'Read a file via MCP.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    const tools = buildAgentTools(host, undefined, defs);

    expect(Object.keys(tools)).toContain('mcp__fs__read');
    const tool = tools['mcp__fs__read' as keyof typeof tools];
    expect(tool.id).toBe('mcp__fs__read');
    expect(tool.description).toBe('Read a file via MCP.');

    await expect(invoke(tool, { path: 'a.txt' })).resolves.toBe('mcp result');
    expect(host.calls[0]).toMatchObject({
      tool: 'mcp__fs__read',
      args: { path: 'a.txt' },
    });
  });

  it('falls back to a permissive schema when an MCP input schema does not convert', () => {
    const defs: DynamicToolDef[] = [
      { name: 'mcp__x__y', description: 'd', inputSchema: 'not a schema' },
    ];
    const tools = buildAgentTools(makeHost(), undefined, defs);
    // It still builds (no throw) and the tool is present.
    expect(tools['mcp__x__y' as keyof typeof tools].inputSchema).toBeDefined();
  });

  it('renders the additional-tools section only when there are dynamic tools', () => {
    expect(renderDynamicToolsSection([])).toBe('');
    const section = renderDynamicToolsSection([
      { name: 'mcp__fs__read', description: 'Read a file.', inputSchema: {} },
    ]);
    expect(section).toContain('Additional tools');
    expect(section).toContain('"mcp__fs__read": Read a file.');
    expect(section).toContain('Requires user approval.');
  });

  it('validates tool input against the schema instead of calling through', async () => {
    const host = makeHost();
    const tools = buildAgentTools(host);
    // Mastra's createTool wraps execute with input validation: a call with a
    // missing required field resolves to a ValidationError, and the host
    // never sees the call.
    const result = (await invoke(tools.read, {})) as { error?: boolean };
    expect(result).toMatchObject({ error: true });
    expect(host.calls).toHaveLength(0);
  });
});

describe('buildPlannerTools', () => {
  const question: ClarifyQuestion = {
    question: 'Which feature do you mean?',
    options: ['the API', 'the CLI'],
    allowOther: true,
  };

  it('exposes read and search, and clarify only when the run offers it', () => {
    // `clarify` is built when the run's offered tools include it (the client
    // lists it when it can show the question pop-up), not from an injected seam.
    expect(Object.keys(buildPlannerTools(makeHost())).sort()).toEqual(['read', 'search']);
    const withClarify = makeHost('ok', ['read', 'search', 'clarify']);
    expect(Object.keys(buildPlannerTools(withClarify)).sort()).toEqual([
      'clarify',
      'read',
      'search',
    ]);
  });

  it('delegates read and search to the host but never write/edit/run', async () => {
    const host = makeHost('contents');
    const tools = buildPlannerTools(host);
    await expect(invoke(tools.read, { path: 'a.ts' })).resolves.toBe('contents');
    await expect(invoke(tools.search, { query: '**/*.ts', mode: 'glob' })).resolves.toBe('contents');
    expect(host.calls.map((c) => c.tool)).toEqual(['read', 'search']);
    expect(tools).not.toHaveProperty('write');
    expect(tools).not.toHaveProperty('edit');
    expect(tools).not.toHaveProperty('run');
  });

  it('delegates the clarify tool to the host by name (the client composes the result)', async () => {
    // `clarify` forwards { questions } to the host through the `tool` capability;
    // the client puts them to the user and composes the answer string.
    const host = makeHost('the user answered', ['read', 'search', 'clarify']);
    const tools = buildPlannerTools(host);
    const result = (await invoke(tools.clarify, { questions: [question] })) as string;

    expect(result).toBe('the user answered');
    expect(host.calls).toContainEqual(
      expect.objectContaining({ tool: 'clarify', args: { questions: [question] } })
    );
  });
});
