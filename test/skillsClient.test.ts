import { describe, it, expect, beforeEach, vi } from 'vitest';

// Control the home directory the client scans for personal skills, without
// touching the real one. The rest of `os` is left intact.
const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<[], string>(() => '/home/test') }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: homedirMock }, homedir: homedirMock };
});

import { collectSkills } from '../src/client/skills';
import { settings } from '../src/config/settings';
import { __reset, __setConfig, __setFile, __setFileAbs, __state } from './mocks/vscode';

const SKILL = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: a skill\n---\n\n${body}\n`;

beforeEach(() => {
  __reset();
  homedirMock.mockReturnValue('/home/test');
});

describe('collectSkills', () => {
  it('returns nothing when no skill file exists', async () => {
    const { skills, bodies } = await collectSkills();
    expect(skills).toEqual([]);
    expect(bodies.size).toBe(0);
  });

  it('ships a SKILL.md found under a workspace dir as metadata, body served on demand', async () => {
    __setFile('.devteam/skills/demo/SKILL.md', SKILL('demo', 'do the thing'));
    const { skills, bodies } = await collectSkills();
    expect(skills).toEqual([
      { source: '.devteam/skills/demo/SKILL.md', name: 'demo', description: 'a skill' },
    ]);
    // The body never rides in the shipped metadata; it is kept for readSkill.
    expect(bodies.get('demo')).toContain('do the thing');
  });

  it('reads a SKILL.md from the home directory, labelling its source with ~', async () => {
    __setFileAbs('/home/test/.claude/skills/personal/SKILL.md', SKILL('personal', 'home body'));
    const { skills, bodies } = await collectSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe('~/.claude/skills/personal/SKILL.md');
    expect(skills[0].name).toBe('personal');
    expect(bodies.get('personal')).toContain('home body');
  });

  it('keeps the workspace skill over a home skill of the same name (workspace wins)', async () => {
    __setFile('.devteam/skills/demo/SKILL.md', SKILL('demo', 'workspace body'));
    __setFileAbs('/home/test/.devteam/skills/demo/SKILL.md', SKILL('demo', 'home body'));
    const { skills, bodies } = await collectSkills();
    // The client now de-dups by name (first-wins), so only the workspace skill
    // ships and its body is the one served.
    expect(skills.map((s) => s.source)).toEqual(['.devteam/skills/demo/SKILL.md']);
    expect(bodies.get('demo')).toContain('workspace body');
  });

  it('scans every configured directory, in order', async () => {
    __setFileAbs('/home/test/.claude/skills/a/SKILL.md', SKILL('a', 'a'));
    __setFile('.claude/skills/b/SKILL.md', SKILL('b', 'b'));
    __setFile('.devteam/skills/c/SKILL.md', SKILL('c', 'c'));
    const sources = (await collectSkills()).skills.map((s) => s.source);
    // Workspace roots first (.devteam before .claude by the default list order),
    // then home.
    expect(sources).toEqual([
      '.devteam/skills/c/SKILL.md',
      '.claude/skills/b/SKILL.md',
      '~/.claude/skills/a/SKILL.md',
    ]);
  });

  it('ignores a stray file directly under a skills directory', async () => {
    // A loose file (not in a <name>/ subfolder) is not a skill.
    __setFile('.devteam/skills/README.md', 'not a skill');
    expect((await collectSkills()).skills).toEqual([]);
  });

  it('skips a folder without a SKILL.md, a blank one, and one with no name', async () => {
    __setFile('.devteam/skills/empty/other.md', 'no skill file here');
    __setFile('.devteam/skills/blank/SKILL.md', '   \n\t\n');
    // A SKILL.md whose frontmatter lacks a name cannot be loaded, so it is dropped.
    __setFile('.devteam/skills/noname/SKILL.md', '---\ndescription: x\n---\n\nbody');
    expect((await collectSkills()).skills).toEqual([]);
  });

  it('truncates an oversized skill body to the configured cap', async () => {
    __setFile('.devteam/skills/big/SKILL.md', SKILL('big', 'x'.repeat(settings.skills.maxChars + 500)));
    const body = (await collectSkills()).bodies.get('big')!;
    expect(body.endsWith('(truncated)')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(
      settings.skills.maxChars + '\n. . . (truncated)'.length
    );
  });

  it('stops at the configured maximum number of skills', async () => {
    for (let i = 0; i <= settings.skills.maxSkills; i++) {
      __setFile(`.devteam/skills/s${i}/SKILL.md`, SKILL(`s${i}`, 'body'));
    }
    expect((await collectSkills()).skills).toHaveLength(settings.skills.maxSkills);
  });

  it('is disabled by an empty configured directory list', async () => {
    __setFile('.devteam/skills/demo/SKILL.md', SKILL('demo', 'body'));
    __setConfig('myDevTeam.skills.directories', []);
    expect((await collectSkills()).skills).toEqual([]);
  });

  it('still reads home skills when there is no workspace folder', async () => {
    __setFileAbs('/home/test/.devteam/skills/personal/SKILL.md', SKILL('personal', 'body'));
    __state.workspaceFolders = undefined;
    const { skills } = await collectSkills();
    expect(skills.map((s) => s.source)).toEqual(['~/.devteam/skills/personal/SKILL.md']);
  });

  it('returns nothing when the home directory cannot be determined', async () => {
    homedirMock.mockReturnValue('');
    __state.workspaceFolders = undefined;
    expect((await collectSkills()).skills).toEqual([]);
  });
});

describe('settings.skills.directories', () => {
  it('defaults to .devteam/skills then .claude/skills', () => {
    expect(settings.skills.directories).toEqual(['.devteam/skills', '.claude/skills']);
  });

  it('accepts a custom list, trimming whitespace and trailing slashes', () => {
    __setConfig('myDevTeam.skills.directories', [' skills/ ', '.claude/skills']);
    expect(settings.skills.directories).toEqual(['skills', '.claude/skills']);
  });

  it('accepts an empty list (the off switch)', () => {
    __setConfig('myDevTeam.skills.directories', []);
    expect(settings.skills.directories).toEqual([]);
  });

  it('falls back when an entry is absolute or could escape the root', () => {
    for (const bad of [['../secrets'], ['/etc/skills'], ['C:\\skills'], ['skills', 42]]) {
      __setConfig('myDevTeam.skills.directories', bad);
      expect(settings.skills.directories).toEqual(['.devteam/skills', '.claude/skills']);
    }
  });
});
