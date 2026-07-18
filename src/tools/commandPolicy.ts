/**
 * The `run` tool's command policy: the allowlist that lets routine commands
 * skip the approval prompt, and the denylist that always prompts regardless of
 * the model's `dangerous` flag. Both live on the client side (this is part of
 * the approval gate, which is the user's machine, not the engine), so this
 * module may read settings and call `vscode`.
 *
 * The two lists pull in opposite directions on purpose:
 *
 * - The **allowlist** (`myDevTeam.run.allowedCommands`) is a convenience: a
 *   command the user has declared safe (`git status`, `npm test`, `npm run *`)
 *   runs with no prompt. To keep that fast path from becoming an escape hatch,
 *   a command that chains or redirects (any shell control operator) is never
 *   eligible - only a single, simple command can match.
 *
 * - The **denylist** (a non-removable built-in floor, plus any
 *   `myDevTeam.run.deniedCommands` the user adds) is a safety net: a command
 *   that deletes, rewrites history, or reaches the network always prompts, and
 *   is escalated to the destructive (`run:dangerous`) approval scope, so it is
 *   never silently covered by an ordinary "Allow All" grant nor by the model
 *   leaving its `dangerous` flag off. Because that flag is decided from
 *   possibly-untrusted request and file content, the denylist is what stops an
 *   injected "ordinary-looking" destructive command from riding an existing
 *   grant. The denylist scans every chained segment, so a denied verb cannot
 *   hide behind `&&`, `;`, or a pipe.
 */
import * as vscode from 'vscode';
import { settings } from '../config/settings';

const CONFIG_SECTION = 'myDevTeam';

/**
 * Shell control operators that chain, pipe, redirect, or substitute commands.
 * A command containing any of these is more than one action, so it is never
 * eligible for the allowlist fast path (it might smuggle an unlisted command
 * past a listed prefix), and the denylist splits on them to scan each segment.
 */
const SEGMENT_SEPARATORS = /(\|\||&&|[;|&\n])/;
const SUBSTITUTION = /[`$()<>]/;

/** Collapse runs of whitespace so prefix/glob matching is insensitive to it. */
function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** True when the command chains, pipes, redirects, or substitutes. */
function hasControlOperators(command: string): boolean {
  return SEGMENT_SEPARATORS.test(command) || SUBSTITUTION.test(command);
}

/** Split a command into its chained segments (for denylist scanning). */
function segments(command: string): string[] {
  return command
    .split(SEGMENT_SEPARATORS)
    .map((part) => normalize(part))
    .filter((part) => part.length > 0 && !SEGMENT_SEPARATORS.test(part));
}

/**
 * Whether a normalized command segment matches a single pattern. A pattern is
 * matched as a whitespace-normalized token-boundary prefix (`git status`
 * matches `git status --short` but not `git status-foo`); a `*` in the pattern
 * is a wildcard that stands for any run of characters (`npm run *` matches
 * `npm run build --watch`). Matching is case-insensitive so a PowerShell verb
 * (`Invoke-WebRequest`) is caught however it is cased.
 */
function matchesPattern(segment: string, pattern: string): boolean {
  const normPattern = normalize(pattern).toLowerCase();
  if (!normPattern) {
    return false;
  }
  const target = segment.toLowerCase();
  if (normPattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        normPattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')
    );
    return regex.test(target);
  }
  return target === normPattern || target.startsWith(normPattern + ' ');
}

/** Whether the command (one of its segments) matches any of the patterns. */
function anySegmentMatches(command: string, patterns: readonly string[]): boolean {
  const segs = segments(command);
  return segs.some((seg) => patterns.some((pattern) => matchesPattern(seg, pattern)));
}

/**
 * Whether an ordinary command may skip the approval prompt: it matches the
 * user's allowlist, contains no chaining/redirection, and is not itself
 * denylisted (the denylist always wins). A command with control operators is
 * never eligible even if its leading command is listed.
 */
export function isAllowedCommand(command: string): boolean {
  const normalized = normalize(command);
  if (!normalized || hasControlOperators(normalized)) {
    return false;
  }
  if (isDeniedCommand(normalized)) {
    return false;
  }
  const allowed = settings.run.allowedCommands;
  return allowed.some((pattern) => matchesPattern(normalized, pattern));
}

/**
 * Whether the command must always prompt and be treated as destructive: any of
 * its chained segments matches the denylist (the built-in floor unioned with
 * the user's additions). Overrides the model's `dangerous` flag and any
 * ordinary "Allow All" grant.
 */
export function isDeniedCommand(command: string): boolean {
  return anySegmentMatches(command, settings.run.deniedCommands);
}

/**
 * The command prefix to offer for "Always allow commands like this": the first
 * segment's leading token, extended to two tokens when the second is a
 * subcommand rather than a flag (`git status --short` -> `git status`,
 * `npm test` -> `npm test`, `ls -la` -> `ls`). Returns '' when there is nothing
 * to suggest (an empty or operator-laden command), so the caller offers no
 * button.
 */
export function suggestedAllowPrefix(command: string): string {
  const normalized = normalize(command);
  if (!normalized || hasControlOperators(normalized)) {
    return '';
  }
  const tokens = normalized.split(' ');
  if (tokens.length >= 2 && !tokens[1].startsWith('-')) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0];
}

/**
 * Append a prefix to the user's `myDevTeam.run.allowedCommands` (global scope),
 * unless it is already covered. Awaited by the approver when the user picks
 * "Always allow commands like this", so the next matching command skips the
 * prompt. A no-op for an empty prefix.
 */
export async function addAllowedCommand(prefix: string): Promise<void> {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return;
  }
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = config.get<unknown>('run.allowedCommands');
  const list = Array.isArray(current)
    ? current.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (list.some((entry) => normalize(entry).toLowerCase() === trimmed.toLowerCase())) {
    return;
  }
  await config.update(
    'run.allowedCommands',
    [...list, trimmed],
    vscode.ConfigurationTarget.Global
  );
}
