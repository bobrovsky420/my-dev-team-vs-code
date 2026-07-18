/**
 * The frontmatter parser used to live here, but the client now needs it too (to
 * read SKILL.md metadata without shipping the whole body - see
 * src/client/skills.ts), so the implementation moved to the shared `config/`
 * layer. This re-export keeps the engine's config loaders importing `./frontmatter`
 * unchanged while there is a single parser behind both halves.
 */
export {
  parseFrontmatter,
  type Frontmatter,
  type FrontmatterScalar,
  type FrontmatterValue,
  type ParsedMarkdown,
} from '../../config/frontmatter';
