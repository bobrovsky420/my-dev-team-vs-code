import { describe, it, expect, beforeEach } from 'vitest';
import { messages } from '../src/config/messages';
import { defaults, settings } from '../src/config/settings';
import { __reset, __setConfig } from './mocks/vscode';
import {
  capabilityNames,
  loadModels,
  modelRegistry,
  scoreModel,
  selectModel,
} from '../src/engine/config/models';
import { parseFrontmatter } from '../src/engine/config/frontmatter';
import { agents, buildInstructions } from '../src/engine/config/agents';
import { partials, resolveIncludes } from '../src/engine/config/partials';
import { CLARIFY_GUIDANCE } from '../src/engine/core/clarify';
import {
  loadTools,
  toolConfigs,
  toolNames,
  renderToolsSection,
} from '../src/engine/config/tools';
import { clientTools, clientToolNames } from '../src/protocol/toolContract';
import {
  describeEnvironment,
  environment,
  renderEnvironmentSection,
} from '../src/config/environment';

beforeEach(() => {
  __reset();
});

describe('messages templates', () => {
  it('renders the triage pieces (intent, reason, complexity) separately', () => {
    expect(messages.triage.intent('oneshot')).toContain('**Detected intent:** `oneshot`');
    expect(messages.triage.reason('because')).toContain('**Reason:** because');
    expect(messages.triage.complexity('moderate')).toContain('**Complexity:** `moderate`');
  });

  it('renders the step error templates from the protocol detail alone', () => {
    // The Ollama hint is no longer baked in: it arrives as the protocol
    // error's `hint`, supplied by the engine (see localEngine.test.ts).
    expect(messages.triage.error('connection refused')).toBe(
      '**Triage error:** connection refused\n\n'
    );
    expect(messages.plan.error('model missing')).toBe(
      '**Planner error:** model missing\n\n'
    );
    expect(messages.answer.error('model missing')).toBe(
      '**Answerer error:** model missing\n\n'
    );
  });

  it('renders the Ollama hint template from the given endpoint and model', () => {
    const hint = messages.ollamaHint('http://gpu-box:11434', 'qwen3:8b');
    expect(hint).toContain('http://gpu-box:11434');
    expect(hint).toContain('`qwen3:8b`');
  });

  it('provides the plan and answer headers as streamable prefixes', () => {
    expect(messages.plan.header).toBe('**Plan:** ');
    expect(messages.answer.header).toBe('**Answer:**\n\n');
  });

  it('provides an approval title and decline reply for the run tool', () => {
    expect(messages.approval.runCommandTitle).toBeTruthy();
    expect(messages.notApproved.run).toMatch(/not.*approved/i);
  });

  it('still reports a cancelled write or edit, the only ungated side effects', () => {
    // write/edit are not gated, but a mid-run stop still cancels them, so the
    // model can note the skip in its report.
    expect(messages.cancelled.write).toMatch(/not changed/i);
    expect(messages.cancelled.edit).toMatch(/not changed/i);
  });

  it('renders the read range header with a continue hint only mid-file', () => {
    expect(messages.read.range(3, 5, 10)).toBe(
      '(lines 3-5 of 10; continue with startLine 6)'
    );
    expect(messages.read.range(9, 10, 10)).toBe('(lines 9-10 of 10)');
  });

  it('phrases every read failure as a recovery instruction for the model', () => {
    expect(messages.readFailed.pastEnd('a.ts', 7, 3)).toContain('only 3 lines');
    expect(messages.readFailed.pastEnd('a.ts', 7, 3)).toContain('startLine 7');
    expect(messages.readFailed.emptyRange(5, 2)).toMatch(/at or after startLine/);
  });

  it('phrases every edit failure as a recovery instruction for the model', () => {
    expect(messages.editFailed.missingFile('a.ts')).toMatch(/write tool/);
    expect(messages.editFailed.notFound('a.ts')).toMatch(/read the file/i);
    expect(messages.editFailed.multipleMatches(3, 'a.ts')).toContain('3');
    expect(messages.editFailed.multipleMatches(3, 'a.ts')).toMatch(/surrounding/);
    // Identical old/new text must not read as a no-op success (which lets the
    // executor stop) - it nudges recovery: re-read/retry or use the write tool.
    expect(messages.editFailed.identical).toMatch(/identical/);
    expect(messages.editFailed.identical).toMatch(/write tool/);
    expect(messages.editFailed.identical).not.toMatch(/nothing to change/);
  });

  it('renders the in-chat approval question with the detail fenced', () => {
    const block = messages.approval.block('Run command', '$ ls');
    expect(block).toContain('**Run command?**');
    expect(block).toContain('```\n$ ls\n```');
    expect(messages.approval.approve).toBe('Approve');
    expect(messages.approval.decline).toBe('Decline');
  });

  it('grows the approval fence so a backtick-laden command cannot break out', () => {
    // A command containing a triple-backtick run must be wrapped in a longer
    // fence, or it would close the block early and inject markdown.
    const detail = '$ echo ```pwned```';
    const block = messages.approval.block('Run command', detail);
    expect(block).toContain('````\n' + detail + '\n````');
  });

  it('grows the snippet fence past any backtick run inside the snippet', () => {
    // The snippet baseline is four backticks; a snippet that itself contains a
    // four-backtick run needs five.
    const snippet = 'before\n````\nafter';
    expect(messages.execution.snippet(snippet)).toBe(
      '\n\n`````\n' + snippet + '\n`````'
    );
  });

  it('renders the executor error template from the protocol detail alone', () => {
    expect(messages.execution.error('model missing')).toBe(
      '**Executor error:** model missing\n\n'
    );
  });

  it('renders execution transcript lines as appendable fragments', () => {
    // The renderer streams the transcript append-only: each call line must be
    // self-prefixed (it follows arbitrary text) and each result a pure suffix.
    const call = messages.execution.call('Read File', '{"path":"a.ts"}');
    expect(call).toBe('\n\n**Read File** `{"path":"a.ts"}`');
    expect(messages.execution.result('ok', false)).toBe(' → `ok`');
    expect(messages.execution.result('boom', true)).toBe(' → **failed** `boom`');
    expect(messages.execution.emptyResult).toBeTruthy();
    expect(messages.execution.header()).toBe('**Execution:**');
    // The executor's model rides in the header when known, as an italic suffix.
    expect(messages.execution.header('Qwen3 8B')).toBe('**Execution:** _(Qwen3 8B)_');
  });

  it('warns about the not-yet-available remote engine by name', () => {
    expect(messages.engine.remoteUnavailable).toContain('myDevTeam.engine');
    expect(messages.engine.remoteUnavailable).toContain('local');
  });
});

describe('settings', () => {
  it('exposes positive operational limits', () => {
    expect(settings.runCommandTimeoutMs).toBeGreaterThan(0);
    expect(settings.maxAttachmentChars).toBeGreaterThan(0);
  });

  it('keeps content-match cap within the scan limit', () => {
    expect(settings.search.contentMaxMatches).toBeLessThanOrEqual(
      settings.search.contentScanLimit
    );
  });

  it('exposes positive content-search per-file and preview caps', () => {
    expect(settings.search.contentMaxMatchesPerFile).toBeGreaterThan(0);
    expect(settings.search.contentMaxMatchesPerFile).toBeLessThanOrEqual(
      settings.search.contentMaxMatches
    );
    expect(settings.search.contentPreviewMaxChars).toBeGreaterThan(0);
  });

  it('exposes a positive glob result cap', () => {
    expect(settings.search.globMaxResults).toBeGreaterThan(0);
  });

  it('exposes positive conversation-history caps', () => {
    expect(settings.history.maxTurns).toBeGreaterThan(0);
    expect(settings.history.maxTurnChars).toBeGreaterThan(0);
  });

  it('exposes positive executor loop and preview limits', () => {
    expect(settings.executor.maxSteps).toBeGreaterThan(0);
    expect(settings.executor.inputPreviewMaxChars).toBeGreaterThan(0);
    expect(settings.executor.resultPreviewMaxChars).toBeGreaterThan(0);
  });

  it('exposes a non-negative structured-output repair attempt count', () => {
    expect(settings.structuredOutput.repairAttempts).toBeGreaterThanOrEqual(0);
  });

  it('exposes the tool hardening limits', () => {
    expect(settings.read.maxLines).toBeGreaterThan(0);
    expect(settings.read.maxChars).toBeGreaterThan(0);
    expect(settings.runCommandMaxBufferBytes).toBeGreaterThan(0);
    expect(settings.search.maxFileSizeBytes).toBeGreaterThan(0);
    // The exclude glob replaces VS Code's defaults, so it must at least keep
    // dependency and VCS folders out of scans.
    expect(settings.search.excludeGlob).toContain('node_modules');
    expect(settings.search.excludeGlob).toContain('.git');
  });
});

describe('user-tunable settings (VS Code configuration)', () => {
  it('falls back to the defaults when nothing is configured', () => {
    expect(settings.engine).toBe(defaults.engine);
    // Unset reads as undefined (the user chose nothing); the localhost fallback
    // is applied downstream by core/models.ts' ollamaEndpoint(), not here.
    expect(settings.ollamaEndpoint).toBeUndefined();
    expect(settings.runCommandTimeoutMs).toBe(defaults.runCommandTimeoutMs);
    expect(settings.read.maxLines).toBe(defaults.read.maxLines);
    expect(settings.search.globMaxResults).toBe(defaults.search.globMaxResults);
    expect(settings.search.contentScanLimit).toBe(defaults.search.contentScanLimit);
    expect(settings.search.contentMaxMatches).toBe(defaults.search.contentMaxMatches);
    expect(settings.executor.snippetLines).toBe(defaults.chat.toolSnippetLines);
    expect(settings.telemetry.evalLogEnabled).toBe(defaults.telemetry.evalLog);
    expect(settings.disabledProviders).toEqual([]);
    expect(settings.disabledModels).toEqual([]);
  });

  it('reads the disabled-provider/model lists, keeping only non-blank strings', () => {
    __setConfig('myDevTeam.disabledProviders', ['anthropic', '  ', 7, 'groq']);
    __setConfig('myDevTeam.disabledModels', [' qwen3-coder ', '']);
    expect(settings.disabledProviders).toEqual(['anthropic', 'groq']);
    expect(settings.disabledModels).toEqual(['qwen3-coder']);
  });

  it('falls back to an empty disable list when the value is not an array', () => {
    __setConfig('myDevTeam.disabledProviders', 'anthropic');
    expect(settings.disabledProviders).toEqual([]);
  });

  it('parses configured MCP servers, dropping invalid entries', () => {
    __setConfig('myDevTeam.mcp.servers', {
      fs: { command: 'npx', args: ['-y', 'server-fs', '.'], env: { TOKEN: 'x' } },
      bare: { command: 'run-it' },
      noCommand: { args: ['x'] },
      blankCommand: { command: '   ' },
      'bad name': { command: 'x' },
      badArgs: { command: 'y', args: ['ok', 7] },
    });
    const servers = settings.mcp.servers;
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['badArgs', 'bare', 'fs']);
    expect(byName.fs).toEqual({
      name: 'fs',
      command: 'npx',
      args: ['-y', 'server-fs', '.'],
      env: { TOKEN: 'x' },
    });
    expect(byName.bare).toEqual({ name: 'bare', command: 'run-it' });
    // A bad args array is dropped, but the server still loads (command is valid).
    expect(byName.badArgs).toEqual({ name: 'badArgs', command: 'y' });
  });

  it('returns no MCP servers when the value is missing or not an object map', () => {
    expect(settings.mcp.servers).toEqual([]);
    __setConfig('myDevTeam.mcp.servers', ['fs']);
    expect(settings.mcp.servers).toEqual([]);
    __setConfig('myDevTeam.mcp.servers', 'fs');
    expect(settings.mcp.servers).toEqual([]);
  });

  it('treats the change line as on by default: only the literal false disables it', () => {
    expect(settings.changes.showInChatEnabled).toBe(true);
    __setConfig('myDevTeam.changes.showInChat', false);
    expect(settings.changes.showInChatEnabled).toBe(false);
    __setConfig('myDevTeam.changes.showInChat', 'no');
    expect(settings.changes.showInChatEnabled).toBe(true);
    __setConfig('myDevTeam.changes.showInChat', 0);
    expect(settings.changes.showInChatEnabled).toBe(true);
  });

  it('treats the summary as on by default: only the literal false disables it', () => {
    expect(settings.summary.showInChatEnabled).toBe(true);
    __setConfig('myDevTeam.summary.showInChat', false);
    expect(settings.summary.showInChatEnabled).toBe(false);
    __setConfig('myDevTeam.summary.showInChat', 'no');
    expect(settings.summary.showInChatEnabled).toBe(true);
    __setConfig('myDevTeam.summary.showInChat', 0);
    expect(settings.summary.showInChatEnabled).toBe(true);
  });

  it('treats thinking as on by default: only the literal false disables it', () => {
    expect(settings.thinking.showInChatEnabled).toBe(true);
    __setConfig('myDevTeam.thinking.showInChat', false);
    expect(settings.thinking.showInChatEnabled).toBe(false);
    __setConfig('myDevTeam.thinking.showInChat', 'no');
    expect(settings.thinking.showInChatEnabled).toBe(true);
    __setConfig('myDevTeam.thinking.showInChat', 0);
    expect(settings.thinking.showInChatEnabled).toBe(true);
  });

  it('treats the eval log as opt-in: only the literal true enables it', () => {
    expect(settings.telemetry.evalLogEnabled).toBe(false);
    __setConfig('myDevTeam.telemetry.evalLog', true);
    expect(settings.telemetry.evalLogEnabled).toBe(true);
    __setConfig('myDevTeam.telemetry.evalLog', 'yes');
    expect(settings.telemetry.evalLogEnabled).toBe(false);
    __setConfig('myDevTeam.telemetry.evalLog', 1);
    expect(settings.telemetry.evalLogEnabled).toBe(false);
  });

  it('treats write/edit approval as opt-in: only the literal true enables it', () => {
    expect(settings.approval.fileChanges).toBe(defaults.approval.fileChanges);
    expect(settings.approval.fileChanges).toBe(false);
    __setConfig('myDevTeam.approval.fileChanges', true);
    expect(settings.approval.fileChanges).toBe(true);
    __setConfig('myDevTeam.approval.fileChanges', 'yes');
    expect(settings.approval.fileChanges).toBe(false);
    __setConfig('myDevTeam.approval.fileChanges', 1);
    expect(settings.approval.fileChanges).toBe(false);
  });

  it('reads the snippet line count live, accepting 0 to hide snippets', () => {
    __setConfig('myDevTeam.chat.toolSnippetLines', 3);
    expect(settings.executor.snippetLines).toBe(3);
    __setConfig('myDevTeam.chat.toolSnippetLines', 0);
    expect(settings.executor.snippetLines).toBe(0);
    __setConfig('myDevTeam.chat.toolSnippetLines', -1);
    expect(settings.executor.snippetLines).toBe(defaults.chat.toolSnippetLines);
  });

  it('reads the executor check-in intervals live, accepting 0 to disable each', () => {
    expect(settings.executor.checkpointEverySteps).toBe(defaults.executor.checkpointEverySteps);
    expect(settings.executor.checkpointEverySeconds).toBe(defaults.executor.checkpointEverySeconds);
    __setConfig('myDevTeam.executor.checkpointEverySteps', 5);
    expect(settings.executor.checkpointEverySteps).toBe(5);
    __setConfig('myDevTeam.executor.checkpointEverySteps', 0);
    expect(settings.executor.checkpointEverySteps).toBe(0);
    __setConfig('myDevTeam.executor.checkpointEverySeconds', 30);
    expect(settings.executor.checkpointEverySeconds).toBe(30);
    __setConfig('myDevTeam.executor.checkpointEverySeconds', 0);
    expect(settings.executor.checkpointEverySeconds).toBe(0);
    // Negative is invalid and falls back to the default.
    __setConfig('myDevTeam.executor.checkpointEverySteps', -1);
    expect(settings.executor.checkpointEverySteps).toBe(defaults.executor.checkpointEverySteps);
  });

  it('cleans the context-warn thresholds: drops out-of-range, de-dupes, sorts', () => {
    expect(settings.executor.contextWarnThresholds).toEqual(
      defaults.executor.contextWarnThresholds
    );
    __setConfig('myDevTeam.executor.contextWarnThresholds', [95, 80, 80, 0, 150, 90]);
    expect(settings.executor.contextWarnThresholds).toEqual([80, 90, 95]);
    // An empty or all-invalid list falls back to the default.
    __setConfig('myDevTeam.executor.contextWarnThresholds', [0, -5, 200]);
    expect(settings.executor.contextWarnThresholds).toEqual(
      defaults.executor.contextWarnThresholds
    );
  });

  it('reads auto-compact, defaulting on and off only for the literal false', () => {
    expect(settings.history.autoCompact).toBe(defaults.history.autoCompact);
    expect(settings.history.autoCompact).toBe(true);
    __setConfig('myDevTeam.history.autoCompact', false);
    expect(settings.history.autoCompact).toBe(false);
    // Anything but the literal false counts as on.
    __setConfig('myDevTeam.history.autoCompact', 'no');
    expect(settings.history.autoCompact).toBe(true);
  });

  it('cleans the auto-compact threshold to a whole percent in (0,100]', () => {
    expect(settings.history.autoCompactThreshold).toBe(defaults.history.autoCompactThreshold);
    __setConfig('myDevTeam.history.autoCompactThreshold', 88.6);
    expect(settings.history.autoCompactThreshold).toBe(88);
    // Out of range or non-numeric falls back to the default.
    __setConfig('myDevTeam.history.autoCompactThreshold', 0);
    expect(settings.history.autoCompactThreshold).toBe(defaults.history.autoCompactThreshold);
    __setConfig('myDevTeam.history.autoCompactThreshold', 150);
    expect(settings.history.autoCompactThreshold).toBe(defaults.history.autoCompactThreshold);
  });

  it('keeps only positive whole-number per-model context-window overrides', () => {
    expect(settings.modelContextWindows).toEqual({});
    __setConfig('myDevTeam.modelContextWindows', {
      'qwen3-coder': 32768,
      'bad-zero': 0,
      'bad-text': 'nope',
      'rounds-down': 8192.7,
    });
    expect(settings.modelContextWindows).toEqual({
      'qwen3-coder': 32768,
      'rounds-down': 8192,
    });
  });

  it('accepts only the literal "remote" for the engine and falls back otherwise', () => {
    __setConfig('myDevTeam.engine', 'remote');
    expect(settings.engine).toBe('remote');
    __setConfig('myDevTeam.engine', 'cloud');
    expect(settings.engine).toBe('local');
    __setConfig('myDevTeam.engine', 42);
    expect(settings.engine).toBe('local');
  });

  it('reads plan approval, defaulting to auto and accepting only always/never to override', () => {
    expect(settings.planApproval).toBe(defaults.planApproval);
    expect(settings.planApproval).toBe('auto');
    __setConfig('myDevTeam.planApproval', 'always');
    expect(settings.planApproval).toBe('always');
    __setConfig('myDevTeam.planApproval', 'never');
    expect(settings.planApproval).toBe('never');
    // Anything else (a typo, a non-string) falls back to the safe auto default.
    __setConfig('myDevTeam.planApproval', 'sometimes');
    expect(settings.planApproval).toBe('auto');
    __setConfig('myDevTeam.planApproval', 42);
    expect(settings.planApproval).toBe('auto');
  });

  it('reads the plan-preview mode, defaulting to auto and accepting only always/never', () => {
    expect(settings.planApprovalPreview).toBe(defaults.planApprovalPreview);
    expect(settings.planApprovalPreview).toBe('auto');
    __setConfig('myDevTeam.planApproval.preview', 'always');
    expect(settings.planApprovalPreview).toBe('always');
    __setConfig('myDevTeam.planApproval.preview', 'never');
    expect(settings.planApprovalPreview).toBe('never');
    // A typo or non-string falls back to the safe auto default.
    __setConfig('myDevTeam.planApproval.preview', 'maybe');
    expect(settings.planApprovalPreview).toBe('auto');
    __setConfig('myDevTeam.planApproval.preview', 42);
    expect(settings.planApprovalPreview).toBe('auto');
  });

  it('reads user-configured values live', () => {
    __setConfig('myDevTeam.ollama.endpoint', 'http://gpu-box:11434');
    __setConfig('myDevTeam.run.commandTimeoutMs', 5_000);
    __setConfig('myDevTeam.read.maxLines', 50);
    __setConfig('myDevTeam.search.globMaxResults', 10);
    __setConfig('myDevTeam.search.contentScanLimit', 20);
    __setConfig('myDevTeam.search.contentMaxMatches', 5);

    expect(settings.ollamaEndpoint).toBe('http://gpu-box:11434');
    expect(settings.runCommandTimeoutMs).toBe(5_000);
    expect(settings.read.maxLines).toBe(50);
    expect(settings.search.globMaxResults).toBe(10);
    expect(settings.search.contentScanLimit).toBe(20);
    expect(settings.search.contentMaxMatches).toBe(5);
  });

  it('normalises the endpoint: trims whitespace and trailing slashes', () => {
    __setConfig('myDevTeam.ollama.endpoint', '  http://gpu-box:11434/// ');
    expect(settings.ollamaEndpoint).toBe('http://gpu-box:11434');
  });

  it('reads a non-http(s) or non-string endpoint as unset (undefined)', () => {
    __setConfig('myDevTeam.ollama.endpoint', 'gpu-box:11434');
    expect(settings.ollamaEndpoint).toBeUndefined();
    __setConfig('myDevTeam.ollama.endpoint', 42);
    expect(settings.ollamaEndpoint).toBeUndefined();
    __setConfig('myDevTeam.ollama.endpoint', '');
    expect(settings.ollamaEndpoint).toBeUndefined();
  });

  it('rejects non-positive, non-finite, or non-number limits and falls back', () => {
    __setConfig('myDevTeam.run.commandTimeoutMs', 0);
    __setConfig('myDevTeam.search.globMaxResults', -5);
    __setConfig('myDevTeam.search.contentScanLimit', Number.NaN);
    __setConfig('myDevTeam.search.contentMaxMatches', 'lots');

    expect(settings.runCommandTimeoutMs).toBe(defaults.runCommandTimeoutMs);
    expect(settings.search.globMaxResults).toBe(defaults.search.globMaxResults);
    expect(settings.search.contentScanLimit).toBe(defaults.search.contentScanLimit);
    expect(settings.search.contentMaxMatches).toBe(defaults.search.contentMaxMatches);
  });

  it('floors fractional limits to whole numbers', () => {
    __setConfig('myDevTeam.run.commandTimeoutMs', 1500.9);
    expect(settings.runCommandTimeoutMs).toBe(1500);
  });

  it('reads the user requests-per-minute override, undefined when unset', () => {
    // Unset reads as undefined (defer to the backend per-provider floor), not 0.
    expect(settings.provider.requestsPerMinute).toBeUndefined();
    __setConfig('myDevTeam.provider.requestsPerMinute', 30);
    expect(settings.provider.requestsPerMinute).toBe(30);
    // 0 is a valid explicit value (the user turning throttling off).
    __setConfig('myDevTeam.provider.requestsPerMinute', 0);
    expect(settings.provider.requestsPerMinute).toBe(0);
    // A fractional value floors to a whole number.
    __setConfig('myDevTeam.provider.requestsPerMinute', 30.9);
    expect(settings.provider.requestsPerMinute).toBe(30);
    // A negative or non-number value is invalid and reads as unset (undefined).
    __setConfig('myDevTeam.provider.requestsPerMinute', -5);
    expect(settings.provider.requestsPerMinute).toBeUndefined();
    __setConfig('myDevTeam.provider.requestsPerMinute', null);
    expect(settings.provider.requestsPerMinute).toBeUndefined();
  });

  it('reads the configurable write-protected paths, defaulting to .vscode', () => {
    expect(settings.write.protectedPaths).toEqual(defaults.write.protectedPaths);
    expect(settings.write.protectedPaths).toEqual(['.vscode']);
    __setConfig('myDevTeam.write.protectedPaths', ['secrets', 'deploy']);
    expect(settings.write.protectedPaths).toEqual(['secrets', 'deploy']);
    // An empty list is valid: it drops the configurable prefixes (the hardcoded
    // .git stays protected in workspaceTools, not via this setting).
    __setConfig('myDevTeam.write.protectedPaths', []);
    expect(settings.write.protectedPaths).toEqual([]);
  });

  it('rejects an invalid write-protected list and falls back to the default', () => {
    __setConfig('myDevTeam.write.protectedPaths', 'secrets');
    expect(settings.write.protectedPaths).toEqual(defaults.write.protectedPaths);
    __setConfig('myDevTeam.write.protectedPaths', ['ok', '']);
    expect(settings.write.protectedPaths).toEqual(defaults.write.protectedPaths);
    __setConfig('myDevTeam.write.protectedPaths', ['../escape']);
    expect(settings.write.protectedPaths).toEqual(defaults.write.protectedPaths);
    __setConfig('myDevTeam.write.protectedPaths', [42]);
    expect(settings.write.protectedPaths).toEqual(defaults.write.protectedPaths);
  });

  it('reads the run allowlist, empty by default and dropping invalid entries', () => {
    expect(settings.run.allowedCommands).toEqual([]);
    __setConfig('myDevTeam.run.allowedCommands', ['npm test', 'git status']);
    expect(settings.run.allowedCommands).toEqual(['npm test', 'git status']);
    // Non-string / blank entries are dropped, the rest kept; a non-array is empty.
    __setConfig('myDevTeam.run.allowedCommands', ['ok', '', 42]);
    expect(settings.run.allowedCommands).toEqual(['ok']);
    __setConfig('myDevTeam.run.allowedCommands', 'npm test');
    expect(settings.run.allowedCommands).toEqual([]);
  });

  it('unions the run denylist additions with the non-removable floor', () => {
    // The floor is always present, even with nothing configured.
    expect(settings.run.deniedCommands).toEqual(defaults.run.deniedCommandsFloor);
    __setConfig('myDevTeam.run.deniedCommands', ['terraform apply']);
    expect(settings.run.deniedCommands).toContain('terraform apply');
    for (const entry of defaults.run.deniedCommandsFloor) {
      expect(settings.run.deniedCommands).toContain(entry);
    }
    // Clearing the setting cannot shrink the floor.
    __setConfig('myDevTeam.run.deniedCommands', []);
    expect(settings.run.deniedCommands).toEqual(defaults.run.deniedCommandsFloor);
  });
});

describe('model registry and selection', () => {
  it('registers models with provider, model name, and at least one capability', () => {
    expect(modelRegistry().length).toBeGreaterThan(0);
    for (const info of modelRegistry()) {
      expect(info.id).toBeTruthy();
      expect(info.label).toBeTruthy();
      expect(info.provider).toBeTruthy();
      expect(info.model).toBeTruthy();
      expect(Object.keys(info.capabilities).length).toBeGreaterThan(0);
    }
  });

  it('keeps registry ids unique', () => {
    const ids = modelRegistry().map((info) => info.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects two model files sharing one id', () => {
    const file =
      '---\nid: twin\nlabel: Twin\nprovider: ollama\nmodel: twin:1b\ncapabilities:\n  speed: 1\n---\nnote';
    expect(() => loadModels([file, file])).toThrow(/Duplicate model id "twin"/);
  });

  it('rejects a model file naming a provider not in the registry', () => {
    // The frontmatter provider enum is generated from the provider registry, so
    // an unknown provider fails at load with a clear message rather than
    // registering a model the wiring cannot build.
    const file =
      '---\nid: x\nlabel: X\nprovider: mistral\nmodel: x\ncapabilities:\n  speed: 1\n---\nnote';
    expect(() => loadModels([file])).toThrow(/Unknown provider in a model config file/);
  });

  it('keeps every capability score within [0, 1]', () => {
    for (const info of modelRegistry()) {
      for (const score of Object.values(info.capabilities)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('scores a model as the weight-by-score sum, missing capabilities as 0', () => {
    const info = {
      id: 'x',
      provider: 'ollama',
      model: 'x',
      description: '',
      capabilities: { reasoning: 0.5, 'fast-utility': 1 },
    } as const;
    // 0.8 * 0.5 (reasoning) + 0.2 * 1 (fast-utility) + 1 * 0 (code-generation, unscored)
    expect(
      scoreModel(info, { reasoning: 0.8, 'fast-utility': 0.2, 'code-generation': 1 })
    ).toBeCloseTo(0.6);
  });

  it('selects the registered model with the highest weighted score', () => {
    for (const requirements of [
      agents.triage.capabilities,
      agents.planner.capabilities,
      agents.answerer.capabilities,
      agents.executor.capabilities,
    ]) {
      const selected = selectModel(requirements);
      const best = Math.max(
        ...modelRegistry().map((info) => scoreModel(info, requirements))
      );
      expect(scoreModel(selected, requirements)).toBe(best);
    }
  });

  it('routes triage to a faster model than the planner cares about', () => {
    // The point of capability routing: triage (fast-utility-weighted) and
    // planning (reasoning-weighted) should be free to land on different models.
    const triageModel = selectModel(agents.triage.capabilities);
    const plannerModel = selectModel(agents.planner.capabilities);
    expect(triageModel.capabilities['fast-utility'] ?? 0).toBeGreaterThanOrEqual(
      plannerModel.capabilities['fast-utility'] ?? 0
    );
  });

  it('routes the executor to the strongest code-generation model in the registry', () => {
    // The executor weights code-generation hardest, so it must land on the
    // registry's code specialist rather than a generalist.
    const executorModel = selectModel(agents.executor.capabilities);
    const bestCoding = Math.max(
      ...modelRegistry().map((info) => info.capabilities['code-generation'] ?? 0)
    );
    expect(executorModel.capabilities['code-generation']).toBe(bestCoding);
  });

  it('normalises the legacy coding/speed dialect to the unified names', () => {
    // A user's hand-written custom model may predate the unified vocabulary:
    // `coding` expands to both code capabilities, `speed` to fast-utility, and
    // an explicit unified name wins over the alias expansion.
    const file =
      '---\nid: legacy\nlabel: L\nprovider: ollama\nmodel: l:1b\ncapabilities:\n  coding: 0.8\n  speed: 0.6\n  code-analysis: 0.4\n---\nnote';
    const [info] = loadModels([file]);
    expect(info.capabilities).toEqual({
      'code-generation': 0.8,
      'code-analysis': 0.4,
      'fast-utility': 0.6,
    });
  });
});

describe('parseFrontmatter', () => {
  it('parses scalar keys and returns the body', () => {
    const { data, body } = parseFrontmatter(
      '---\nid: planner\nname: Planner\n---\n\nThe prompt.\n'
    );
    expect(data).toEqual({ id: 'planner', name: 'Planner' });
    expect(body).toBe('The prompt.\n');
  });

  it('parses booleans and numbers', () => {
    const { data } = parseFrontmatter(
      '---\nsideEffecting: true\nenabled: false\nlimit: 8\n---\nbody'
    );
    expect(data).toEqual({ sideEffecting: true, enabled: false, limit: 8 });
  });

  it('parses numbers written with _ digit separators', () => {
    const { data } = parseFrontmatter(
      '---\ncontextWindow: 200_000\nbig: 1_047_576\nfrac: 1_000.5\n---\nbody'
    );
    expect(data).toEqual({ contextWindow: 200000, big: 1047576, frac: 1000.5 });
  });

  it('leaves malformed separator forms as strings, not numbers', () => {
    // Underscores must sit between digits; a stray one is not a number.
    const { data } = parseFrontmatter(
      '---\na: 1_\nb: _1\nc: 1__0\nd: v1_2\n---\nbody'
    );
    expect(data).toEqual({ a: '1_', b: '_1', c: '1__0', d: 'v1_2' });
  });

  it('parses block lists', () => {
    const { data } = parseFrontmatter('---\ntools:\n  - read\n  - search\n---\nbody');
    expect(data).toEqual({ tools: ['read', 'search'] });
  });

  it('parses an empty inline list', () => {
    expect(parseFrontmatter('---\ntools: []\n---\nbody').data).toEqual({ tools: [] });
  });

  it('parses a one-level nested map of scalars', () => {
    const { data } = parseFrontmatter(
      '---\ncapabilities:\n  reasoning: 0.8\n  speed: 1\nname: x\n---\nbody'
    );
    expect(data).toEqual({ capabilities: { reasoning: 0.8, speed: 1 }, name: 'x' });
  });

  it('rejects mixing list items and map entries under one key', () => {
    expect(() =>
      parseFrontmatter('---\nthings:\n  - a\n  b: 1\n---\nbody')
    ).toThrow(/Cannot mix/);
    expect(() =>
      parseFrontmatter('---\nthings:\n  b: 1\n  - a\n---\nbody')
    ).toThrow(/Cannot mix/);
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('just text')).toEqual({ data: {}, body: 'just text' });
  });

  it('ignores a UTF-8 BOM before the opening fence', () => {
    const { data, body } = parseFrontmatter('\uFEFF---\nid: x\n---\nbody');
    expect(data).toEqual({ id: 'x' });
    expect(body).toBe('body');
  });

  it('throws on a malformed line', () => {
    expect(() => parseFrontmatter('---\nnot yaml at all\n---\nbody')).toThrow(
      /Unsupported frontmatter/
    );
  });
});

describe('environment', () => {
  it('uses PowerShell on Windows, both as exec shell and in the prompt text', () => {
    const win = describeEnvironment('win32');
    expect(win.os).toBe('Windows');
    expect(win.shell).toBe('PowerShell');
    expect(win.execShell).toBe('powershell.exe');
  });

  it('keeps the platform default shell on macOS and Linux', () => {
    expect(describeEnvironment('darwin')).toEqual({
      os: 'macOS',
      shell: 'POSIX sh',
      execShell: undefined,
    });
    expect(describeEnvironment('linux')).toEqual({
      os: 'Linux',
      shell: 'POSIX sh',
      execShell: undefined,
    });
  });

  it('describes the platform the extension host actually runs on', () => {
    expect(environment).toEqual(describeEnvironment(process.platform));
  });

  it('renders a prompt section naming the OS and the shell', () => {
    const section = renderEnvironmentSection(describeEnvironment('win32'));
    expect(section).toContain('Windows');
    expect(section).toContain('PowerShell syntax');
    // Without an argument it must describe the host environment, so the
    // prompts can never claim a platform other than the one commands run on.
    expect(renderEnvironmentSection()).toContain(environment.os);
  });
});

describe('tool configs', () => {
  it('discovers the five workspace tools plus the engine-only progress, skill, and clarify tools', () => {
    // Order follows the config filenames, so compare as a sorted set.
    expect([...toolNames].sort()).toEqual([
      'clarify',
      'edit',
      'progress',
      'read',
      'run',
      'search',
      'skill',
      'write',
    ]);
    // progress and skill are engine-only and carried by the executor; clarify is
    // engine-built and carried by the planner. Neither agent lists the other's
    // engine-only tools, and plan steps no longer name a tool at all.
    expect(agents.executor.tools).toContain('progress');
    expect(agents.executor.tools).toContain('skill');
    expect(agents.executor.tools).not.toContain('clarify');
    expect(agents.planner.tools).toContain('clarify');
    expect(agents.planner.tools).not.toContain('progress');
    expect(agents.planner.tools).not.toContain('skill');
  });

  it('marks only run as side-effecting; read, search, write, and edit are not', () => {
    // write/edit are not gated - the workspace is git-backed, so their changes
    // are recoverable; only run still asks before acting.
    expect(toolConfigs.read.sideEffecting).toBe(false);
    expect(toolConfigs.search.sideEffecting).toBe(false);
    expect(toolConfigs.write.sideEffecting).toBe(false);
    expect(toolConfigs.edit.sideEffecting).toBe(false);
    expect(toolConfigs.run.sideEffecting).toBe(true);
  });

  it('agrees with the protocol contract on the tool vocabulary', () => {
    // The engine's workspace tool configs (model-facing) and the protocol's
    // client tools (ids, display names, input schemas) describe the same five
    // tools; a tool added on one side only would silently break the other. The
    // engine-only progress, skill, and clarify tools have no client contract.
    const workspaceTools = toolNames.filter(
      (name) => name !== 'progress' && name !== 'skill' && name !== 'clarify'
    );
    expect([...workspaceTools].sort()).toEqual([...clientToolNames].sort());
    expect(clientToolNames).not.toContain('progress');
    expect(clientToolNames).not.toContain('skill');
    expect(clientToolNames).not.toContain('clarify');
    for (const name of clientToolNames) {
      expect(clientTools[name].displayName).toBeTruthy();
    }
  });

  it('tells the model which OS and shell run commands land in', () => {
    // The placeholders must be substituted, not shipped verbatim, and the
    // description must name the same environment the run tool executes in.
    expect(toolConfigs.run.description).not.toContain('{{');
    expect(toolConfigs.run.description).toContain(environment.os);
    expect(toolConfigs.run.description).toContain(`${environment.shell} syntax`);
  });

  it('names a preview argument matching each tool\'s input schema', () => {
    // The transcript shows this argument's value instead of the args JSON
    // (e.g. just the file name for write); the names must match the input
    // schemas in protocol/toolContract.ts or the preview silently falls
    // back to JSON.
    expect(toolConfigs.read.previewArg).toBe('path');
    expect(toolConfigs.write.previewArg).toBe('path');
    expect(toolConfigs.edit.previewArg).toBe('path');
    expect(toolConfigs.search.previewArg).toBe('query');
    expect(toolConfigs.run.previewArg).toBe('command');
  });

  it('names write\'s and edit\'s snippet arguments; the others have none', () => {
    // The transcript shows this argument's first lines as a fenced snippet
    // under the call line; the name must match the input schema in
    // protocol/toolContract.ts or the snippet silently disappears.
    expect(toolConfigs.write.snippetArg).toBe('contents');
    expect(toolConfigs.edit.snippetArg).toBe('newText');
    expect(toolConfigs.read.snippetArg).toBeUndefined();
    expect(toolConfigs.search.snippetArg).toBeUndefined();
    expect(toolConfigs.run.snippetArg).toBeUndefined();
  });

  it('renders a tools section with one line per tool', () => {
    const section = renderToolsSection(['read', 'run']);
    expect(section).toContain('You have exactly 2 tools available:');
    expect(section).toContain('- "read": Read the text of one workspace file');
    expect(section).toContain('Requires user approval.');
  });

  it('does not flag the write tool as needing approval', () => {
    // write is not gated, so its rendered description must not claim approval -
    // that would mislead the model into treating a write as a user decision.
    const section = renderToolsSection(['write']);
    expect(section).toContain('- "write": Create or overwrite a file.');
    expect(section).not.toContain('Requires user approval.');
  });

  it('rejects an unknown tool name', () => {
    expect(() => renderToolsSection(['delete'])).toThrow(/Unknown tool "delete"/);
  });

  it('rejects two tool files sharing one name', () => {
    const file = '---\nname: twin\nsideEffecting: false\n---\ndesc';
    expect(() => loadTools([file, file])).toThrow(/Duplicate tool name "twin"/);
  });
});

describe('agent configs', () => {
  it('loads frontmatter fields and non-empty instructions for each agent', () => {
    expect(agents.triage.id).toBe('triage');
    expect(agents.triage.name).toBe('Triage');
    expect(agents.triage.description).toBeTruthy();
    expect(agents.planner.id).toBe('planner');
    expect(agents.planner.name).toBe('Planner');
    expect(agents.planner.description).toBeTruthy();
    expect(agents.answerer.id).toBe('answerer');
    expect(agents.answerer.name).toBe('Answerer');
    expect(agents.answerer.description).toBeTruthy();
    expect(agents.executor.id).toBe('executor');
    expect(agents.executor.name).toBe('Executor');
    expect(agents.executor.description).toBeTruthy();
    expect(agents.summarizer.id).toBe('summarizer');
    expect(agents.summarizer.name).toBe('Summarizer');
    expect(agents.summarizer.description).toBeTruthy();
    expect(agents.triage.instructions).toContain('triage agent');
    expect(agents.planner.instructions).toContain('planner');
    expect(agents.answerer.instructions).toContain('answerer');
    expect(agents.executor.instructions).toContain('executor');
    expect(agents.summarizer.instructions).toContain('summarizer');
  });

  it('keeps the summarizer toolless, fast, and asking for the three sections', () => {
    expect(agents.summarizer.tools).toEqual([]);
    expect(agents.summarizer.capabilities['fast-utility']).toBeGreaterThan(0);
    const p = agents.summarizer.instructions;
    expect(p).toContain('whatShips');
    expect(p).toContain('howItsBuilt');
    expect(p).toContain('testsAndDocs');
    // It must frame the transcript as untrusted data, like the other agents.
    expect(p).toMatch(/untrusted data/i);
  });

  it('declares only known capabilities with weights in [0, 1] for each agent', () => {
    for (const agent of Object.values(agents)) {
      const entries = Object.entries(agent.capabilities);
      expect(entries.length).toBeGreaterThan(0);
      for (const [capability, weight] of entries) {
        expect(capabilityNames).toContain(capability);
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
  });

  it('weights triage toward fast classification and the planner toward planning', () => {
    expect(agents.triage.capabilities.classification).toBe(1);
    expect(agents.planner.capabilities.planning).toBe(1);
  });

  it('weights the answerer toward reasoning with fast-utility close behind', () => {
    expect(agents.answerer.capabilities.reasoning).toBe(1);
    expect(agents.answerer.capabilities['fast-utility']).toBeGreaterThan(0);
  });

  it('weights the executor toward code generation', () => {
    expect(agents.executor.capabilities['code-generation']).toBe(1);
  });

  it('derives modelSettings from the sampling frontmatter, absent when unset', () => {
    // Triage pins a low temperature for stable routing; agents without
    // sampling keys carry no modelSettings, keeping provider defaults.
    expect(agents.triage.modelSettings).toEqual({ temperature: 0.1 });
    expect(agents.executor.modelSettings).toBeUndefined();
    expect(agents.answerer.modelSettings).toBeUndefined();
  });

  it('keeps the executor contract: all tools, decline handling, a report', () => {
    // The executor carries every tool except the planner-only `clarify`,
    // including the engine-only progress and skill tools.
    expect([...agents.executor.tools].sort()).toEqual(
      [...toolNames].filter((name) => name !== 'clarify').sort()
    );
    const p = agents.executor.instructions;
    expect(p).not.toContain('{{tools}}');
    expect(p).toContain('You have exactly 7 tools available:');
    expect(p).toContain('not approved');
    expect(p).toMatch(/report/i);
    // It is told to print a progress checklist from time to time.
    expect(p).toContain('"progress"');
    expect(p).toMatch(/from time to time/i);
    // It is told it can load a skill on demand.
    expect(p).toContain('"skill"');
    expect(p).toContain('Available skills');
  });

  it('gives the executor coding discipline: verify, deps, secrets, scope', () => {
    const p = agents.executor.instructions;
    // Verify a change and stop looping on a persistent failure.
    expect(p).toMatch(/verify it/i);
    expect(p).toMatch(/loop on the same failure/i);
    // Confirm a dependency exists; never hardcode a secret.
    expect(p).toMatch(/do not assume a library/i);
    expect(p).toMatch(/never hardcode a secret/i);
    // Stay in scope and do not create unneeded files/docs.
    expect(p).toMatch(/stay within the request/i);
    expect(p).toMatch(/documentation file on\s+your own/i);
    // Use the file tools rather than shelling out to read/edit files.
    expect(p).toMatch(/dedicated tools for files, not the run tool/i);
  });

  it('tells the run-capable agents which OS and shell they work on', () => {
    // Both agents that plan or issue run commands carry the environment
    // section; without it a model defaults to Linux commands on Windows.
    for (const agent of [agents.planner, agents.executor]) {
      expect(agent.instructions).not.toContain('{{environment}}');
      expect(agent.instructions).toContain(renderEnvironmentSection());
    }
    // Agents without tools have no placeholder and gain no section.
    expect(agents.triage.instructions).not.toContain('Environment:');
    expect(agents.answerer.instructions).not.toContain('Environment:');
  });

  it('explains the project-instructions section to the working agents', () => {
    // The workflow may prepend a "--- Project instructions ---" section (the
    // workspace's AGENTS.md/CLAUDE.md); the agents that act on the request
    // must know to treat it as standing rules. Triage never receives it.
    for (const agent of [agents.planner, agents.answerer, agents.executor]) {
      expect(agent.instructions).toContain('--- Project instructions ---');
      expect(agent.instructions).toMatch(/AGENTS\.md or CLAUDE\.md/);
    }
    expect(agents.triage.instructions).not.toContain('Project instructions');
  });

  it('tells the working agents to treat attached content as untrusted data', () => {
    // Prompt-injection hardening: file contents, tool results, and attachments
    // can carry instructions; the agents must answer/act on the user's request,
    // not on text embedded in the data.
    for (const agent of [agents.planner, agents.answerer, agents.executor]) {
      expect(agent.instructions).toMatch(/untrusted data/i);
    }
    // The agents that can change files must also know the write/edit tools
    // refuse protected locations.
    for (const agent of [agents.planner, agents.executor]) {
      expect(agent.instructions).toMatch(/\.git\//);
      expect(agent.instructions).toMatch(/protected/i);
    }
  });

  it('keeps the answerer contract: no tools, oneshot framing', () => {
    expect(agents.answerer.tools).toEqual([]);
    const p = agents.answerer.instructions;
    expect(p).toContain('"oneshot"');
    expect(p).not.toContain('tools available');
    // The escape hatch for residual misroutes: the answerer must state it
    // cannot write files and point the user at rephrasing, not silently
    // pretend fenced code in chat fulfilled a file-creation request.
    expect(p).toContain('cannot create or modify files');
    expect(p).toMatch(/rephras/i);
  });

  // The prose lives in standalone .md files, so these lock the structural
  // contract each agent depends on — an accidental edit that drops a routing
  // category or a tool would fail here rather than silently degrade routing.
  it('keeps the triage contract: no tools, both routing categories, JSON output', () => {
    expect(agents.triage.tools).toEqual([]);
    const p = agents.triage.instructions;
    expect(p).toContain('"oneshot"');
    expect(p).toContain('"planning"');
    expect(p).not.toContain('tools available');
    expect(p).toMatch(/JSON object/i);
  });

  it('routes a small, fully-specified change to "direct" and larger ones to "planning"', () => {
    const p = agents.triage.instructions;
    // The three routes are all present and explained.
    expect(p).toContain('"oneshot"');
    expect(p).toContain('"direct"');
    expect(p).toContain('"planning"');
    // The direct/planning boundary: small-and-clear is direct; multi-file,
    // exploration-needing, or design-open work is planning. When unsure, plan.
    expect(p).toMatch(/small and\s+fully-specified|small.*fully-specified/s);
    expect(p).toMatch(/when in doubt/i);
    // A trivial new-script request is still an explicit planning example: it
    // creates a whole file, so it is not a "direct" few-line change.
    expect(p).toContain('create a python script');
  });

  it('keeps the planner contract: its own read/search/clarify tools, the step cap, and JSON output', () => {
    // The planner now carries its own tools - read and search to explore before
    // committing, clarify to ask the user - and never the executor's mutating
    // tools or the engine-only progress/skill tools.
    expect([...agents.planner.tools].sort()).toEqual([
      'clarify',
      'read',
      'search',
    ]);
    expect(agents.planner.tools).not.toContain('write');
    expect(agents.planner.tools).not.toContain('edit');
    expect(agents.planner.tools).not.toContain('run');
    expect(agents.planner.tools).not.toContain('progress');
    const p = agents.planner.instructions;
    expect(p).toContain('never more than 12');
    expect(p).toMatch(/JSON object/i);
  });

  it('keeps the planner describing steps, not authoring code', () => {
    // Code generation belongs to the executor (the routed coding specialist);
    // a plan step that inlines code wastes the routing, bloats the structured
    // output, and crowds the executor's context. The ban is total: the old
    // "short fragment" allowance was stretched into whole programs.
    const p = agents.planner.instructions;
    expect(p).toMatch(/Never write code in\s+the plan/);
    expect(p).toMatch(/executor writes the code/);
    expect(p).toMatch(/no snippets of\s+any length/);
    expect(p).not.toMatch(/fragment of a few lines/);
  });

  it('renders the tools section into the planner prompt at the placeholder', () => {
    const p = agents.planner.instructions;
    expect(p).not.toContain('{{tools}}');
    expect(p).toContain('You have exactly 3 tools available:');
    for (const name of agents.planner.tools) {
      expect(p).toContain(`- "${name}": ${toolConfigs[name].description}`);
    }
    // The engine-only progress tool is never advertised to the planner.
    expect(p).not.toContain(`- "progress":`);
    // The placeholder position is honoured: tools come before the rules.
    expect(p.indexOf('tools available')).toBeLessThan(p.indexOf('Rules:'));
  });
});

describe('shared partials and includes', () => {
  it('registers the untrusted-data guard with its core wording', () => {
    expect(partials['untrusted-data']).toMatch(/untrusted data/i);
    expect(partials['untrusted-data']).toMatch(/act only on the\s+user's actual request/i);
  });

  it('registers every shared partial generated from my-dev-team-config', () => {
    // The six shared prompt blocks (TODO 1.4 in my-dev-team) ride the sync
    // script; a missing one means the generated files were hand-pruned.
    for (const name of [
      'untrusted-data',
      'clarify-guidance',
      'code-style',
      'faithful-reporting',
      'scope-discipline',
      'tdd',
    ]) {
      expect(partials[name], `partial ${name}`).toBeTruthy();
    }
    expect(partials['scope-discipline']).toMatch(/stay within the request/i);
    expect(partials['code-style']).toMatch(/never hardcode a secret/i);
    expect(partials['faithful-reporting']).toMatch(/report outcomes faithfully/i);
  });

  it('derives the clarify guidance from the shared partial, flattened', () => {
    expect(CLARIFY_GUIDANCE).toBe(partials['clarify-guidance'].replace(/\s+/g, ' '));
    expect(CLARIFY_GUIDANCE).not.toContain('\n');
    expect(CLARIFY_GUIDANCE).toMatch(/sensible\s+default/i);
  });

  it('replaces a known include with the partial body', () => {
    const registry = { greeting: 'Hello there.' };
    expect(resolveIncludes('Say: {{ include greeting }}', registry)).toBe(
      'Say: Hello there.'
    );
  });

  it('normalises a path and a .md suffix to the partial name', () => {
    const registry = { greeting: 'Hi.' };
    expect(resolveIncludes('{{ include greeting.md }}', registry)).toBe('Hi.');
    expect(resolveIncludes('{{ include partials/greeting.md }}', registry)).toBe(
      'Hi.'
    );
  });

  it('throws on an unknown include name', () => {
    expect(() => resolveIncludes('{{ include missing }}', {})).toThrow(
      /Unknown include "missing"/
    );
  });

  it('resolves a partial that itself includes another', () => {
    const registry = { outer: 'A {{ include inner }} B', inner: 'X' };
    expect(resolveIncludes('{{ include outer }}', registry)).toBe('A X B');
  });

  it('throws on a cyclic include instead of recursing forever', () => {
    const registry = { a: '{{ include b }}', b: '{{ include a }}' };
    expect(() => resolveIncludes('{{ include a }}', registry)).toThrow(
      /Cyclic include detected/
    );
  });

  it('keeps or drops a conditional include by the flags record', () => {
    // The unified `if [not] <flag>` clause shared with my-dev-team's loader.
    const registry = { extra: 'EXTRA' };
    const kept = (text: string, flags?: Record<string, boolean>) =>
      resolveIncludes(text, registry, flags).includes('EXTRA');
    expect(kept('{{ include extra if verbose }}')).toBe(false);
    expect(kept('{{ include extra if verbose }}', { verbose: true })).toBe(true);
    expect(kept('{{ include extra if not verbose }}')).toBe(true);
    expect(kept('{{ include extra if not verbose }}', { verbose: true })).toBe(false);
  });

  it('strips the {{skills}} placeholder instead of rendering it', () => {
    // Part of the unified prompt-body conventions: this app serves skills
    // inside the composed request, so a shared body's placeholder is removed.
    expect(buildInstructions('Before {{skills}} after.', [])).toBe('Before  after.');
  });

  it('expands every agent include - no raw directive survives, the guard is shared', () => {
    for (const agent of Object.values(agents)) {
      expect(agent.instructions).not.toContain('{{ include');
      // Every agent now carries the same shared injection guard.
      expect(agent.instructions).toMatch(/act only on the\s+user's actual request/i);
    }
  });
});
