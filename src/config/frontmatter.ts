/**
 * Minimal frontmatter parser for the `.md` config files in config/agents,
 * config/models and config/tools - and now also for the workspace SKILL.md
 * files the client parses (so the client and the engine share one parser rather
 * than drifting). It lives in the shared `config/` layer because both halves
 * need it; it is `vscode`-free, so the engine may import it like
 * `config/runtimeConfig` and `config/limits`.
 *
 * Supports only the YAML subset those files use - scalar `key: value` pairs,
 * block lists of strings, and one-level nested maps of scalars - so the
 * extension bundle does not need a full YAML dependency. Numeric scalars may use
 * `_` as a digit-group separator (`200_000`), which a JS numeric literal allows
 * but `Number()` does not. Callers validate the parsed data with a zod schema,
 * so unknown keys or missing fields fail fast on import.
 */
export type FrontmatterScalar = string | number | boolean;
export type FrontmatterValue =
  | FrontmatterScalar
  | string[]
  | Record<string, FrontmatterScalar>;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedMarkdown {
  /** Key/value pairs from the `---` fenced block, if present. */
  data: Frontmatter;
  /** Everything after the frontmatter block, untrimmed except leading blank lines. */
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * A JS-style numeric literal that uses `_` as a digit-group separator
 * (e.g. `200_000`, `1_047_576`, `1_000.5`). Underscores are allowed only
 * *between* digits - never leading, trailing, doubled, or next to the sign,
 * `.`, or exponent - so a stray underscore (`1_`, `_1`, `foo_bar`) is not
 * mistaken for a number. `Number()` itself rejects separators, so this only
 * runs as a fallback after the plain-number check below failed.
 */
const NUMBER_WITH_SEPARATORS =
  /^[+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?$/;

function parseScalar(text: string): string | number | boolean {
  const t = text.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  // Accept readable numbers like `200_000`: the pattern guarantees a valid
  // numeric shape, so stripping the separators and re-parsing cannot yield NaN.
  if (NUMBER_WITH_SEPARATORS.test(t)) return Number(t.replace(/_/g, ''));
  return t;
}

export function parseFrontmatter(raw: string): ParsedMarkdown {
  // A UTF-8 BOM before the opening fence would make the fence regex miss and
  // the whole file parse as body, surfacing as a confusing zod error.
  const text = raw.replace(/^\uFEFF/, '');
  const match = text.match(FENCE);
  if (!match) {
    return { data: {}, body: text };
  }

  const data: Frontmatter = {};
  // Set while consuming the children of a bare `key:` line. The first child
  // decides the shape: a `- item` makes it a list, a `sub: value` a map.
  let blockKey: string | undefined;

  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && blockKey) {
      const block = data[blockKey];
      if (!Array.isArray(block)) {
        throw new Error(`Cannot mix list items and map entries under "${blockKey}".`);
      }
      block.push(String(parseScalar(item[1])));
      continue;
    }

    const nested = line.match(/^\s+([A-Za-z][\w-]*):\s*(.+)$/);
    if (nested && blockKey) {
      let block = data[blockKey];
      if (Array.isArray(block)) {
        if (block.length > 0) {
          throw new Error(`Cannot mix list items and map entries under "${blockKey}".`);
        }
        // A bare `key:` defaults to an empty list; the first map entry
        // reshapes it.
        block = data[blockKey] = {};
      }
      (block as Record<string, FrontmatterScalar>)[nested[1]] = parseScalar(nested[2]);
      continue;
    }

    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!pair) {
      throw new Error(`Unsupported frontmatter line: "${line}"`);
    }
    const [, key, value] = pair;
    if (value === '' || value === '[]') {
      data[key] = [];
      blockKey = value === '' ? key : undefined;
    } else {
      data[key] = parseScalar(value);
      blockKey = undefined;
    }
  }

  return { data, body: text.slice(match[0].length).replace(/^\s*\n/, '') };
}
