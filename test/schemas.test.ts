import { describe, it, expect } from 'vitest';
import { TriageSchema } from '../src/engine/core/triage';
import { PlanSchema, PlanStepSchema } from '../src/engine/core/planner';

describe('TriageSchema', () => {
  it('accepts a well-formed oneshot result', () => {
    expect(
      TriageSchema.parse({ intent: 'oneshot', complexity: 'simple', reason: 'simple' })
    ).toEqual({ intent: 'oneshot', complexity: 'simple', reason: 'simple' });
  });

  it('accepts the planning intent', () => {
    expect(
      TriageSchema.safeParse({ intent: 'planning', complexity: 'complex', reason: 'x' })
        .success
    ).toBe(true);
  });

  it('rejects an unknown intent value', () => {
    expect(
      TriageSchema.safeParse({ intent: 'chitchat', complexity: 'simple', reason: 'x' })
        .success
    ).toBe(false);
  });

  it('rejects an unknown complexity value', () => {
    expect(
      TriageSchema.safeParse({ intent: 'oneshot', complexity: 'trivial', reason: 'x' })
        .success
    ).toBe(false);
  });

  it('rejects a missing reason', () => {
    expect(
      TriageSchema.safeParse({ intent: 'oneshot', complexity: 'simple' }).success
    ).toBe(false);
  });

  it('requires a complexity', () => {
    expect(TriageSchema.safeParse({ intent: 'oneshot', reason: 'x' }).success).toBe(
      false
    );
  });

  it('describes the three-way intent boundary (oneshot / direct / planning)', () => {
    // The description is part of what the model sees in structured-output mode,
    // so it must reinforce the triage prompt's three routes: text in the chat
    // (oneshot), a small fully-specified change (direct), or a larger/uncertain
    // change to decompose first (planning).
    const description = TriageSchema.shape.intent.description ?? '';
    expect(description).toContain('"oneshot"');
    expect(description).toContain('"direct"');
    expect(description).toContain('"planning"');
    // The direct/planning boundary is small-and-specified vs larger-or-uncertain.
    expect(description).toContain('small');
    expect(description).toContain('decompose');
  });
});

describe('PlanStepSchema', () => {
  it('accepts a step with a title and detail', () => {
    // Plan steps no longer carry a tool label: which tool a step needs is the
    // executor's decision at run time.
    expect(PlanStepSchema.safeParse({ title: 't', detail: 'd' }).success).toBe(true);
  });

  it('requires both a title and a detail', () => {
    expect(PlanStepSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(PlanStepSchema.safeParse({ detail: 'd' }).success).toBe(false);
  });

  it('describes detail as plain prose, never code', () => {
    // The description is part of what the model sees in structured-output
    // mode, so it must reinforce the planner prompt's no-code rule.
    const description = PlanStepSchema.shape.detail.description ?? '';
    expect(description).toContain('Never any code');
    expect(description).toContain('executor writes the code');
  });
});

describe('PlanSchema', () => {
  const step = { title: 't', detail: 'd' };

  it('accepts a minimal one-step plan', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [step], complexity: 'simple' }).success
    ).toBe(true);
  });

  it('rejects a plan with no steps', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [], complexity: 'simple' }).success
    ).toBe(false);
  });

  it('rejects a plan with more than twelve steps', () => {
    const steps = Array.from({ length: 13 }, () => step);
    expect(
      PlanSchema.safeParse({ summary: 's', steps, complexity: 'simple' }).success
    ).toBe(false);
  });

  it('accepts exactly twelve steps', () => {
    const steps = Array.from({ length: 12 }, () => step);
    expect(
      PlanSchema.safeParse({ summary: 's', steps, complexity: 'complex' }).success
    ).toBe(true);
  });

  it('accepts a plan carrying design decisions', () => {
    const decisions = [
      { decision: 'Add a new module', rationale: 'keeps the core editor-free' },
    ];
    expect(
      PlanSchema.safeParse({
        summary: 's',
        steps: [step],
        decisions,
        complexity: 'complex',
      }).success
    ).toBe(true);
  });

  it('omits decisions by default (the field is optional)', () => {
    const parsed = PlanSchema.parse({ summary: 's', steps: [step], complexity: 'simple' });
    expect(parsed.decisions).toBeUndefined();
  });

  it('rejects more than three design decisions', () => {
    const decisions = Array.from({ length: 4 }, () => ({
      decision: 'd',
      rationale: 'r',
    }));
    expect(
      PlanSchema.safeParse({
        summary: 's',
        steps: [step],
        decisions,
        complexity: 'complex',
      }).success
    ).toBe(false);
  });

  it('requires a complexity (the planner judges it)', () => {
    expect(PlanSchema.safeParse({ summary: 's', steps: [step] }).success).toBe(false);
  });

  it('rejects an unknown complexity value', () => {
    expect(
      PlanSchema.safeParse({ summary: 's', steps: [step], complexity: 'trivial' }).success
    ).toBe(false);
  });
});
