import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  PlanDecisionSchema,
  PlanSchema,
  ReplySchema,
  RunRequestSchema,
  Reply,
} from '../src/protocol/types';
import { ReplyFolder, RunEvent } from '../src/protocol/events';
import { clientTools, clientToolNames } from '../src/protocol/toolContract';

describe('protocol schemas', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });

  it('accepts a minimal run request and rejects a malformed one', () => {
    expect(() =>
      RunRequestSchema.parse({
        protocolVersion: 1,
        prompt: 'hi',
        offeredTools: ['read'],
      })
    ).not.toThrow();
    // The slash command travels by name, and stays optional.
    expect(() =>
      RunRequestSchema.parse({
        protocolVersion: 1,
        prompt: 'hi',
        command: 'fix',
        offeredTools: ['read'],
      })
    ).not.toThrow();
    // Project instructions ride along as an optional labelled text.
    expect(() =>
      RunRequestSchema.parse({
        protocolVersion: 1,
        prompt: 'hi',
        instructions: { source: 'AGENTS.md', text: 'Always run the tests.' },
        offeredTools: ['read'],
      })
    ).not.toThrow();
    // Instructions without their source file are malformed.
    expect(() =>
      RunRequestSchema.parse({
        protocolVersion: 1,
        prompt: 'hi',
        instructions: { text: 'rules' },
        offeredTools: ['read'],
      })
    ).toThrow();
    // Missing offeredTools.
    expect(() =>
      RunRequestSchema.parse({ protocolVersion: 1, prompt: 'hi' })
    ).toThrow();
    // Non-integer version.
    expect(() =>
      RunRequestSchema.parse({ protocolVersion: 1.5, prompt: 'hi', offeredTools: [] })
    ).toThrow();
  });

  it('accepts every reply shape the engine can produce', () => {
    const oneshot: Reply = { intent: 'oneshot', reason: 'r', answer: 'a' };
    const planning: Reply = {
      intent: 'planning',
      reason: 'r',
      plan: { summary: 's', steps: [{ title: 't', detail: 'd' }] },
      execution: {
        events: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool', tool: 'read', input: 'a.ts', result: 'ok', failed: false },
        ],
      },
    };
    const planningWithSummary: Reply = {
      ...planning,
      summary: { whatShips: 'a', howItsBuilt: 'b', testsAndDocs: 'c' },
    };
    const clarify: Reply = {
      intent: 'clarify',
      reason: 'ambiguous',
      questions: [
        { question: 'Which one?', options: ['A', 'B'], allowOther: true },
      ],
    };
    expect(ReplySchema.parse(oneshot)).toEqual(oneshot);
    expect(ReplySchema.parse(planning)).toEqual(planning);
    expect(ReplySchema.parse(planningWithSummary)).toEqual(planningWithSummary);
    expect(ReplySchema.parse(clarify)).toEqual(clarify);
    // A summary missing a section is malformed.
    expect(() =>
      ReplySchema.parse({ ...planning, summary: { whatShips: 'a' } })
    ).toThrow();
    expect(() => ReplySchema.parse({ intent: 'maybe', reason: 'r' })).toThrow();
  });

  it('carries the planner complexity on the plan as an optional field', () => {
    // Additive: a plan without it still validates (an older engine, or a model
    // that omitted it), and a known complexity is accepted.
    expect(PlanSchema.parse({ summary: 's', steps: [{ title: 't', detail: 'd' }] })).toEqual({
      summary: 's',
      steps: [{ title: 't', detail: 'd' }],
    });
    expect(
      PlanSchema.parse({
        summary: 's',
        steps: [{ title: 't', detail: 'd' }],
        complexity: 'complex',
      }).complexity
    ).toBe('complex');
    expect(() =>
      PlanSchema.parse({ summary: 's', steps: [{ title: 't', detail: 'd' }], complexity: 'huge' })
    ).toThrow();
  });

  it('accepts the three plan-review decisions and rejects anything else', () => {
    expect(PlanDecisionSchema.parse({ kind: 'approve' })).toEqual({ kind: 'approve' });
    expect(PlanDecisionSchema.parse({ kind: 'cancel' })).toEqual({ kind: 'cancel' });
    expect(
      PlanDecisionSchema.parse({ kind: 'revise', comment: 'fewer files' })
    ).toEqual({ kind: 'revise', comment: 'fewer files' });
    // A revise without a comment, or an unknown kind, is malformed.
    expect(() => PlanDecisionSchema.parse({ kind: 'revise' })).toThrow();
    expect(() => PlanDecisionSchema.parse({ kind: 'maybe' })).toThrow();
  });

  it('validates tool inputs per the contract schemas', () => {
    expect(() => clientTools.read.inputSchema.parse({ path: 'a.ts' })).not.toThrow();
    expect(() => clientTools.read.inputSchema.parse({})).toThrow();
    // The read range is optional, 1-based, and integer.
    expect(() =>
      clientTools.read.inputSchema.parse({ path: 'a.ts', startLine: 3, endLine: 9 })
    ).not.toThrow();
    expect(() =>
      clientTools.read.inputSchema.parse({ path: 'a.ts', startLine: 0 })
    ).toThrow();
    expect(() =>
      clientTools.read.inputSchema.parse({ path: 'a.ts', endLine: 1.5 })
    ).toThrow();
    expect(() =>
      clientTools.search.inputSchema.parse({ query: 'x', mode: 'glob' })
    ).not.toThrow();
    expect(() =>
      clientTools.search.inputSchema.parse({ query: 'x', mode: 'everywhere' })
    ).toThrow();
  });

  it('exposes the five tools in a stable order', () => {
    expect(clientToolNames).toEqual(['read', 'search', 'run', 'write', 'edit']);
  });

  it('requires a non-empty oldText for the edit tool', () => {
    // An empty oldText matches everywhere; the schema rejects it before the
    // implementation has to.
    expect(() =>
      clientTools.edit.inputSchema.parse({ path: 'a.ts', oldText: 'x', newText: 'y' })
    ).not.toThrow();
    expect(() =>
      clientTools.edit.inputSchema.parse({ path: 'a.ts', oldText: '', newText: 'y' })
    ).toThrow();
  });
});

describe('ReplyFolder', () => {
  it('folds a oneshot event stream back into grow-only snapshots', () => {
    const folder = new ReplyFolder();

    expect(
      folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'simple' })
    ).toEqual({ intent: 'oneshot', reason: 'simple' });
    expect(folder.apply({ type: 'answer-delta', text: 'It' })).toEqual({
      intent: 'oneshot',
      reason: 'simple',
      answer: 'It',
    });
    expect(folder.apply({ type: 'answer-delta', text: ' is 4.' })).toEqual({
      intent: 'oneshot',
      reason: 'simple',
      answer: 'It is 4.',
    });
  });

  it('folds plan snapshots and indexed execution events', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'planning', reason: 'steps' });
    folder.apply({ type: 'plan-snapshot', plan: { summary: 'Add' } });
    const afterPlan = folder.apply({
      type: 'plan-snapshot',
      plan: { summary: 'Add a feature', steps: [{ title: 'Find' }] },
    });
    expect(afterPlan?.plan).toEqual({
      summary: 'Add a feature',
      steps: [{ title: 'Find' }],
    });

    folder.apply({
      type: 'execution-event',
      index: 0,
      event: { kind: 'tool', tool: 'search', input: '*' },
    });
    // The same index again replaces the event (the call gained its result).
    folder.apply({
      type: 'execution-event',
      index: 0,
      event: { kind: 'tool', tool: 'search', input: '*', result: 'a.ts' },
    });
    const finalProgress = folder.apply({
      type: 'execution-event',
      index: 1,
      event: { kind: 'text', text: 'Done.' },
    });

    expect(finalProgress?.execution).toEqual({
      events: [
        { kind: 'tool', tool: 'search', input: '*', result: 'a.ts' },
        { kind: 'text', text: 'Done.' },
      ],
    });
  });

  it('folds summary snapshots onto the progress after execution', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'planning', reason: 'steps' });
    folder.apply({
      type: 'execution-event',
      index: 0,
      event: { kind: 'tool', tool: 'write', input: 'a.ts', result: 'Wrote a.ts.' },
    });
    folder.apply({ type: 'summary-snapshot', summary: { whatShips: 'A' } });
    const final = folder.apply({
      type: 'summary-snapshot',
      summary: { whatShips: 'A feature', howItsBuilt: 'B', testsAndDocs: 'C' },
    });
    expect(final?.summary).toEqual({ whatShips: 'A feature', howItsBuilt: 'B', testsAndDocs: 'C' });
  });

  it('folds the model-selected event onto the snapshot selection', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'r' });
    const selection = {
      mode: 'auto' as const,
      models: [{ step: 'answer', id: 'qwen3-8b', label: 'Qwen3 8B (Ollama)' }],
    };
    expect(folder.apply({ type: 'model-selected', selection })).toEqual({
      intent: 'oneshot',
      reason: 'r',
      selection,
    });
  });

  it('ignores events arriving before the triage decision', () => {
    const folder = new ReplyFolder();
    expect(folder.apply({ type: 'answer-delta', text: 'stray' })).toBeUndefined();
    expect(
      folder.apply({ type: 'plan-snapshot', plan: { summary: 's' } })
    ).toBeUndefined();
  });

  it('reports no visual change for side-channel events (usage, thinking)', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'r' });
    expect(
      folder.apply({ type: 'usage', step: 'triage', inputTokens: 1 })
    ).toBeUndefined();
    expect(folder.apply({ type: 'thinking', text: 'pondering' })).toBeUndefined();
    expect(
      folder.apply({ type: 'error', message: 'boom' } as RunEvent)
    ).toBeUndefined();
  });

  it('replaces the folded state with the validated reply on done', () => {
    const folder = new ReplyFolder();
    folder.apply({ type: 'triaged', intent: 'oneshot', reason: 'r' });
    folder.apply({ type: 'answer-delta', text: 'partial' });
    const reply: Reply = { intent: 'oneshot', reason: 'r', answer: 'complete' };
    expect(folder.apply({ type: 'done', reply })).toEqual(reply);
  });

  it('folds a clarify reply, carrying its questions through on done', () => {
    const folder = new ReplyFolder();
    // The clarify route streams only the triage decision; the questions arrive
    // whole in the final reply.
    expect(folder.apply({ type: 'triaged', intent: 'clarify', reason: 'ambiguous' })).toEqual({
      intent: 'clarify',
      reason: 'ambiguous',
    });
    const reply: Reply = {
      intent: 'clarify',
      reason: 'ambiguous',
      questions: [{ question: 'Which one?', options: ['A', 'B'], allowOther: false }],
    };
    expect(folder.apply({ type: 'done', reply })).toEqual(reply);
  });
});
