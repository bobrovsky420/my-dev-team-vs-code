/**
 * Skill catalogue handling. A skill is a named, described block of instructions
 * the executor loads on demand: when a task matches a skill's description, the
 * model calls its `skill` tool (see ../core/agentTools.ts), which fetches the
 * full body from the client through the `tool` capability, then follows it
 * (progressive disclosure - only the name + description ride in the prompt until
 * a skill is used, and only a used skill's body crosses the wire at all).
 *
 * The engine bundles **no** skills of its own: every skill comes from the
 * client, which discovers the workspace's SKILL.md files (src/client/skills.ts),
 * parses their frontmatter, and ships the metadata (name + description + source)
 * on the run request. The engine just de-duplicates that metadata into the
 * catalogue the executor's prompt lists; the bodies are never the engine's to
 * hold.
 */
import { WorkspaceSkill } from '../../protocol/types';

/** One skill as the executor's prompt lists it: name + description only. */
export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * De-duplicate the run's skill metadata into the executor's catalogue. The
 * client orders the skills highest precedence first (a workspace skill before a
 * personal one of the same name), so the **first** occurrence of each name wins
 * and later duplicates are dropped - matching how the client serves bodies by
 * name. Returns name + description only; the body is fetched on demand.
 */
export function resolveSkills(skills?: readonly WorkspaceSkill[]): SkillSummary[] {
  const seen = new Set<string>();
  const catalogue: SkillSummary[] = [];
  for (const skill of skills ?? []) {
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    catalogue.push({ name: skill.name, description: skill.description });
  }
  return catalogue;
}

/**
 * Render the executor prompt's "Available skills" section from a catalogue: one
 * line per skill naming it and when it applies. Empty string when there are no
 * skills, so the section is omitted entirely.
 */
export function renderSkillsSection(catalogue: readonly SkillSummary[]): string {
  if (catalogue.length === 0) {
    return '';
  }
  const lines = catalogue.map((skill) => `- "${skill.name}": ${skill.description}`);
  return `--- Available skills ---\n${lines.join('\n')}\n--- End of available skills ---`;
}
