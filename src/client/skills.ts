/**
 * Discovers the skills available to a run. Like the standing instruction file
 * (instructions.ts), this is client work by design: the engine is stateless and
 * has no filesystem access, so the client finds the SKILL.md files and reads
 * them. It then ships only the **metadata** (name + description + source) on the
 * request and keeps each skill's body to serve on demand: when the model loads a
 * skill, the engine's `skill` tool calls back to the client (over the `tool`
 * capability) and the handler returns the body from the map this builds. So an
 * unused skill's body never crosses to the engine, and the engine bundles no
 * skills of its own. Reading fresh every request means an edit to a skill takes
 * effect on the next message.
 *
 * A skill lives at `<dir>/<name>/SKILL.md`, where `<dir>` is one of the
 * configured skills directories (`myDevTeam.skills.directories`, e.g.
 * `.devteam/skills` or `.claude/skills`). Those directories are looked for in
 * two places: every workspace root (a skill committed to the project) and the
 * user's home directory (a personal skill shared across projects). Workspace
 * skills take precedence over home skills of the same name, so they are
 * collected first and the first occurrence of each name wins - both in the
 * shipped metadata and in the body map.
 */
import * as os from 'os';
import * as vscode from 'vscode';
import { WorkspaceSkill } from '../protocol/types';
import { settings } from '../config/settings';
import { truncateForDisplay } from '../config/messages';
import { parseFrontmatter } from '../config/frontmatter';

const SKILL_FILE = 'SKILL.md';

/**
 * What a run's skill discovery yields: the metadata to ship on the request, and
 * the bodies (keyed by skill name) the handler serves on demand when the model's
 * `skill` tool asks (through the `tool` capability). The two are kept in sync -
 * one entry per winning name - so a `skill` call for any shipped skill resolves
 * to its body.
 */
export interface CollectedSkills {
  skills: WorkspaceSkill[];
  bodies: Map<string, string>;
}

/**
 * Pull a skill's name, description, and body out of its SKILL.md text using the
 * shared frontmatter parser (the same one the engine's config loaders use, so
 * the client and engine never disagree on what a skill is called). Returns
 * undefined when the frontmatter is malformed or lacks a usable name, so a bad
 * skill file is skipped rather than failing the turn.
 */
function parseSkill(
  text: string
): { name: string; description: string; body: string } | undefined {
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch {
    return undefined;
  }
  const name = parsed.data.name;
  if (typeof name !== 'string' || !name.trim()) {
    return undefined;
  }
  const description = parsed.data.description;
  return {
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    body: parsed.body,
  };
}

/** The user's home directory, or undefined when it cannot be determined. */
function homeDirectory(): string | undefined {
  try {
    const dir = os.homedir();
    return dir && dir.trim() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A readable source label for a discovered skill file: workspace-relative for a
 * skill in the workspace, `~/...` for one under the home directory.
 */
function sourceLabel(file: vscode.Uri, home: string | undefined): string {
  if (home) {
    const homePath = vscode.Uri.file(home).path;
    if (file.path === homePath || file.path.startsWith(homePath + '/')) {
      return '~' + file.path.slice(homePath.length);
    }
  }
  return vscode.workspace.asRelativePath(file);
}

/**
 * Find the skills available to this run: for each base location (workspace roots
 * first, then the home directory) and each configured directory, the SKILL.md
 * files one level below it, parsed for their metadata and body. Returns the
 * metadata to ship (name + description + source) and a name->body map to serve
 * on demand, **highest precedence first** (workspace before home), keeping the
 * first occurrence of each name so a name clash resolves in the project's
 * favour. Each body is capped to `settings.skills.maxChars`, up to
 * `settings.skills.maxSkills` skills in total. Never throws and returns empty
 * when there is nowhere to look or the feature is disabled (an empty directory
 * list): a missing skill must never fail or delay the turn.
 */
export async function collectSkills(): Promise<CollectedSkills> {
  const empty: CollectedSkills = { skills: [], bodies: new Map() };
  const dirs = settings.skills.directories;
  if (dirs.length === 0) {
    return empty;
  }

  // Base locations, highest precedence first: each workspace root, then the
  // user's home directory. The configured directories are tried under each, in
  // their listed order.
  const home = homeDirectory();
  const bases: vscode.Uri[] = [
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
  ];
  if (home) {
    bases.push(vscode.Uri.file(home));
  }
  if (bases.length === 0) {
    return empty;
  }

  const max = settings.skills.maxChars;
  const skills: WorkspaceSkill[] = [];
  const bodies = new Map<string, string>();
  // De-duplicate twice: by SKILL.md path (the same file reached under two bases)
  // and by skill name (a project skill shadows a personal one of the same name),
  // keeping the first occurrence of each since bases are highest-precedence first.
  const seenPaths = new Set<string>();

  for (const base of bases) {
    for (const dir of dirs) {
      if (skills.length >= settings.skills.maxSkills) {
        return { skills, bodies };
      }
      const root = vscode.Uri.joinPath(base, ...dir.split('/'));
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(root);
      } catch {
        continue; // The directory does not exist here: nothing to read.
      }
      for (const [entry, type] of entries) {
        if (skills.length >= settings.skills.maxSkills) {
          return { skills, bodies };
        }
        // Skills live in `<dir>/<name>/SKILL.md`; ignore stray files.
        if ((type & vscode.FileType.Directory) === 0) {
          continue;
        }
        const file = vscode.Uri.joinPath(root, entry, SKILL_FILE);
        if (seenPaths.has(file.path)) {
          continue;
        }
        let text: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(file);
          text = Buffer.from(bytes).toString('utf8');
        } catch {
          continue; // No SKILL.md in this folder.
        }
        if (!text.trim()) {
          continue;
        }
        seenPaths.add(file.path);
        const skill = parseSkill(text);
        // A malformed SKILL.md, or one whose name a higher-precedence skill
        // already claimed, is skipped (so the shipped metadata and the body map
        // stay one entry per winning name).
        if (!skill || bodies.has(skill.name)) {
          continue;
        }
        skills.push({
          source: sourceLabel(file, home),
          name: skill.name,
          description: skill.description,
        });
        bodies.set(skill.name, truncateForDisplay(skill.body, max));
      }
    }
  }
  return { skills, bodies };
}
