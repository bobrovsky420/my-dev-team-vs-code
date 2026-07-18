import { describe, it, expect } from 'vitest';
import { steeringFor, withSteering } from '../src/engine/config/steering';
import { modelById, type ModelInfo } from '../src/engine/config/models';

/** A registered model by id, failing loudly if the fixture id ever disappears. */
function model(id: string): ModelInfo {
  const info = modelById(id);
  if (!info) {
    throw new Error(`Test fixture model "${id}" is no longer registered.`);
  }
  return info;
}

describe('steeringFor', () => {
  it('returns no steering for a frontier model that clears every threshold', () => {
    expect(steeringFor(model('anthropic-opus'))).toBe('');
    expect(steeringFor(model('anthropic-sonnet'))).toBe('');
    expect(steeringFor(model('openai-gpt41'))).toBe('');
  });

  it('steers only output format for DeepSeek (strong reasoning/coding, weaker format)', () => {
    const steering = steeringFor(model('deepseek-v4-flash'));
    expect(steering).toContain('Model-specific guidance');
    expect(steering).toContain('specific format');
    // It reasons and codes at frontier level, so those rules must not fire.
    expect(steering).not.toContain('one step at a time');
    expect(steering).not.toContain('invent file paths');
  });

  it('steers a small local model on every weak capability', () => {
    const steering = steeringFor(model('gemma3-4b'));
    expect(steering).toContain('specific format');
    expect(steering).toContain('one step at a time');
    expect(steering).toContain('invent file paths');
  });

  it('counts a missing capability score as below threshold (full help)', () => {
    const unscored = { ...model('anthropic-opus'), capabilities: {} } as ModelInfo;
    const steering = steeringFor(unscored);
    expect(steering).toContain('specific format');
    expect(steering).toContain('one step at a time');
    expect(steering).toContain('invent file paths');
  });
});

describe('withSteering', () => {
  it('leaves the base prompt untouched when the model needs no steering', () => {
    const base = 'You are the executor.';
    expect(withSteering(base, model('anthropic-opus'))).toBe(base);
  });

  it('appends the steering section after the base prompt when a rule fires', () => {
    const base = 'You are the executor.';
    const out = withSteering(base, model('gemma3-4b'));
    expect(out.startsWith(`${base}\n\n`)).toBe(true);
    expect(out).toContain('## Model-specific guidance');
  });
});
