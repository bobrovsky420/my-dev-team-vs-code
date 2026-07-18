import { describe, it, expect } from 'vitest';

import { resolveSkills, renderSkillsSection } from '../src/engine/config/skills';
import { WorkspaceSkill } from '../src/protocol/types';

const meta = (source: string, name: string, description: string): WorkspaceSkill => ({
  source,
  name,
  description,
});

describe('resolveSkills', () => {
  it('returns an empty catalogue for no skills', () => {
    expect(resolveSkills()).toEqual([]);
    expect(resolveSkills([])).toEqual([]);
  });

  it('builds the catalogue from the request metadata (name + description only)', () => {
    const catalogue = resolveSkills([
      meta('.devteam/skills/a/SKILL.md', 'a', 'does A'),
      meta('.devteam/skills/b/SKILL.md', 'b', 'does B'),
    ]);
    expect(catalogue).toEqual([
      { name: 'a', description: 'does A' },
      { name: 'b', description: 'does B' },
    ]);
  });

  it('keeps the first occurrence when a name appears more than once', () => {
    // The client ships skills highest precedence first (workspace before home),
    // so the first occurrence of a name wins and later duplicates are dropped -
    // matching how the client serves bodies by name.
    const catalogue = resolveSkills([
      meta('.devteam/skills/demo/SKILL.md', 'demo', 'from workspace'),
      meta('~/.devteam/skills/demo/SKILL.md', 'demo', 'from home'),
    ]);
    expect(catalogue.filter((c) => c.name === 'demo')).toHaveLength(1);
    expect(catalogue.find((c) => c.name === 'demo')?.description).toBe('from workspace');
  });
});

describe('renderSkillsSection', () => {
  it('renders one line per skill', () => {
    const section = renderSkillsSection([
      { name: 'one', description: 'first' },
      { name: 'two', description: 'second' },
    ]);
    expect(section).toContain('--- Available skills ---');
    expect(section).toContain('- "one": first');
    expect(section).toContain('- "two": second');
  });

  it('is empty when there are no skills', () => {
    expect(renderSkillsSection([])).toBe('');
  });
});
