/**
 * Shared prompt partials: reusable prose blocks that more than one agent
 * embeds, kept in one place so a cross-cutting rule (e.g. the untrusted-data /
 * prompt-injection guard) is tuned once instead of drifting across the agent
 * `.md` files. Each partial is a `.md` file in ./partials whose frontmatter
 * carries a `name`; the markdown body is the block. Files are discovered by
 * the glob import at build time (like ./tools), so adding a partial needs no
 * code change and the bundle still ships with no runtime file I/O.
 *
 * An agent body embeds a partial with an `{{ include <name> }}` directive,
 * resolved at load time (see agents.ts) the same way `{{tools}}` and
 * `{{environment}}` are. The name argument is normalised - a leading path and a
 * trailing `.md` are stripped - so `{{ include untrusted-data }}`,
 * `{{ include untrusted-data.md }}`, and `{{ include partials/untrusted-data.md }}`
 * all resolve to the same partial. A partial may itself contain includes;
 * resolution recurses, fails loudly on an unknown name, and rejects cycles.
 */
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import partialFiles from 'glob:./partials/*.md';

const PartialFrontmatterSchema = z.object({
  /** Name an `{{ include <name> }}` directive refers to the partial by. */
  name: z.string(),
});

/** Reduce an include argument to its partial name: drop any path and `.md`. */
function normalizeName(arg: string): string {
  return arg.replace(/\.md$/i, '').split('/').pop() ?? arg;
}

/**
 * Parse the partial files into a name -> body registry, rejecting duplicate
 * names (a duplicate would silently overwrite its predecessor).
 */
function loadPartials(files: readonly string[]): Record<string, string> {
  const registry: Record<string, string> = {};
  for (const raw of files) {
    const { data, body } = parseFrontmatter(raw);
    const { name } = PartialFrontmatterSchema.parse(data);
    if (registry[name] !== undefined) {
      throw new Error(`Duplicate partial name "${name}" in config/partials.`);
    }
    registry[name] = body.trim();
  }
  return registry;
}

export const partials: Record<string, string> = loadPartials(partialFiles);

const INCLUDE = /\{\{\s*include\s+([\w./-]+?)(?:\s+if\s+(not\s+)?([\w.-]+))?\s*\}\}/g;

/** Flags a conditional include may test; the unified syntax's `if` clause. */
export type IncludeFlags = Readonly<Record<string, boolean>>;

function expand(
  text: string,
  registry: Record<string, string>,
  flags: IncludeFlags,
  stack: readonly string[]
): string {
  return text.replace(
    INCLUDE,
    (_match, arg: string, negate: string | undefined, condition: string | undefined) => {
      // The unified conditional clause (shared with my-dev-team's loader):
      // `if <flag>` keeps the block only when the flag is truthy, `if not
      // <flag>` only when it is falsy; an unknown flag counts as false.
      if (condition !== undefined && Boolean(flags[condition]) === Boolean(negate)) {
        return '';
      }
      const name = normalizeName(arg);
      const body = registry[name];
      if (body === undefined) {
        throw new Error(
          `Unknown include "${arg}" - no partial named "${name}" in config/partials.`
        );
      }
      if (stack.includes(name)) {
        throw new Error(
          `Cyclic include detected: ${[...stack, name].join(' -> ')}.`
        );
      }
      // A partial may itself include others; recurse, tracking the path so a
      // cycle throws instead of recursing forever.
      return expand(body, registry, flags, [...stack, name]);
    }
  );
}

/**
 * Replace every `{{ include <name> [if [not] <flag>] }}` directive in `text`
 * with the named partial's body, recursively. A conditional include is kept or
 * dropped by the `flags` record (no flags = every plain `if` drops, every
 * `if not` keeps). Throws on an unknown name or an include cycle.
 */
export function resolveIncludes(
  text: string,
  registry: Record<string, string> = partials,
  flags: IncludeFlags = {}
): string {
  return expand(text, registry, flags, []);
}
