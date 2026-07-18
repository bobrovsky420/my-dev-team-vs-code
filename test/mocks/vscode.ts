/**
 * In-memory fake of the slice of the VS Code extension API that the source
 * touches. Vitest aliases the real `vscode` module to this file (see
 * vitest.config.ts) so the extension's logic can run in plain Node.
 *
 * State lives in `__state`; call `__reset()` in a beforeEach to get a clean
 * workspace between tests. The classes are real so the production code's
 * `instanceof` checks behave correctly.
 */
import { vi } from 'vitest';

// --- Value types (real classes so `instanceof` works in the source) ---

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
    public readonly path: string
  ) {}

  static file(p: string): Uri {
    return new Uri('file', p, p);
  }

  /**
   * Mirrors the real `Uri.from(components)`: build a Uri from a scheme and path
   * (a virtual filesystem in tests, e.g. the read-only plan preview's scheme).
   */
  static from(components: { scheme: string; path?: string }): Uri {
    const p = components.path ?? '';
    return new Uri(components.scheme, p, p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/+$/, ''), ...segments].join('/');
    return new Uri(base.scheme, joined, joined);
  }

  toString(): string {
    return this.path;
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export class Location {
  constructor(public readonly uri: Uri, public readonly range: Range) {}
}

/** Mirrors vscode.CodeActionKind: only the QuickFix value the source uses. */
export class CodeActionKind {
  private constructor(public readonly value: string) {}
  static readonly QuickFix = new CodeActionKind('quickfix');
}

/** Mirrors vscode.CodeAction: title + kind, with command/diagnostics set later. */
export class CodeAction {
  command: { command: string; title: string; arguments?: unknown[] } | undefined;
  diagnostics: unknown[] | undefined;
  isPreferred: boolean | undefined;
  constructor(public readonly title: string, public readonly kind?: CodeActionKind) {}
}

/** Mirrors vscode.CodeLens: a range plus the command it invokes. */
export class CodeLens {
  constructor(
    public readonly range: Range,
    public readonly command?: { command: string; title: string; arguments?: unknown[] }
  ) {}
}

/** Mirrors vscode.DiagnosticSeverity (Error is 0, as in the real API). */
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(public readonly content: unknown[]) {}
}

export class ChatRequestTurn {
  constructor(
    public readonly prompt: string,
    public readonly command?: string,
    public readonly participant: string = 'myDevTeam.agent'
  ) {}
}

export class ChatResponseMarkdownPart {
  // Mirrors the real shape: `.value` is a MarkdownString with its own `.value`.
  public readonly value: { value: string };
  constructor(text: string) {
    this.value = { value: text };
  }
}

export class ChatResponseTurn {
  // Mirrors the real shape: `result` is the ChatResult the handler returned
  // for this turn, whose metadata pairs feedback (and the /compact history
  // rule) with the run that produced it.
  constructor(
    public readonly response: unknown[],
    public readonly participant: string = 'myDevTeam.agent',
    public readonly result: { metadata?: unknown } = {}
  ) {}
}

export enum ChatResultFeedbackKind {
  Unhelpful = 0,
  Helpful = 1,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

/** Mirrors vscode.FileType: a bitmask, with SymbolicLink OR'd onto the base type. */
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

/**
 * Minimal vscode.MarkdownString: accumulates appended markdown into `value`,
 * and carries the `isTrusted`/`supportThemeIcons` flags a rich status-bar
 * hover sets so `command:` links and `$(icon)` codicons render.
 */
export class MarkdownString {
  value: string;
  isTrusted: boolean | { enabledCommands: string[] } = false;
  supportThemeIcons: boolean;

  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** Fake of a terminal created via window.createTerminal. */
export interface FakeTerminal {
  name: string;
  /** The options the terminal was created with (pty access for tests). */
  creationOptions: { name: string; pty?: any };
  dispose: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
}

// --- Mutable test state ---

interface MockState {
  files: Map<string, string>;
  /** Paths (by `uri.path`) that fs.stat should report as symbolic links. */
  symlinks: Set<string>;
  workspaceFolders: Array<{ uri: Uri; name: string }> | undefined;
  /** Whether the workspace is trusted (Restricted Mode is the `false` case). */
  trusted: boolean;
  findFilesResult: Uri[];
  warningResponse: string | undefined;
  registeredTools: Map<string, unknown>;
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  /** User settings by `<section>.<key>` (e.g. "myDevTeam.ollama.endpoint"). */
  configuration: Map<string, unknown>;
  /** Listeners registered via workspace.onDidChangeConfiguration. */
  configChangeListeners: Array<(e: unknown) => void>;
  /** Terminals created via window.createTerminal, in creation order. */
  terminals: FakeTerminal[];
  terminalCloseListeners: Array<(t: FakeTerminal) => void>;
  /** Status-bar items created via window.createStatusBarItem. */
  statusBarItems: FakeStatusBarItem[];
  /** What window.showQuickPick returns next (an index into items, or undefined). */
  quickPickResponse: number | undefined;
  /** What window.showInputBox returns next. */
  inputBoxResponse: string | undefined;
  /** SecretStorage values by key. */
  secrets: Map<string, string>;
  /** Diagnostics by `uri.path`, returned from languages.getDiagnostics. */
  diagnostics: Map<string, unknown[]>;
  /** The fake active text editor, read by window.activeTextEditor. */
  activeTextEditor: unknown;
  /** Virtual-document content providers by scheme (registerTextDocumentContentProvider). */
  contentProviders: Map<string, FakeContentProvider>;
  /** Open editor tabs (window.tabGroups), e.g. previews opened by markdown commands. */
  tabs: FakeTab[];
}

/** A registered TextDocumentContentProvider, enough to serve content in tests. */
export interface FakeContentProvider {
  provideTextDocumentContent(uri: Uri): string | undefined;
  onDidChange?: (listener: (uri: Uri) => void) => { dispose: () => void };
}

/** A fake editor tab; only the label the close heuristic matches on is modelled. */
export interface FakeTab {
  label: string;
}

export const __state: MockState = {
  files: new Map(),
  symlinks: new Set(),
  workspaceFolders: [{ uri: Uri.file('/ws'), name: 'ws' }],
  trusted: true,
  findFilesResult: [],
  warningResponse: undefined,
  registeredTools: new Map(),
  registeredCommands: new Map(),
  configuration: new Map(),
  configChangeListeners: [],
  terminals: [],
  terminalCloseListeners: [],
  statusBarItems: [],
  quickPickResponse: undefined,
  inputBoxResponse: undefined,
  secrets: new Map(),
  diagnostics: new Map(),
  activeTextEditor: undefined,
  contentProviders: new Map(),
  tabs: [],
};

export function __reset(): void {
  __state.files = new Map();
  __state.symlinks = new Set();
  __state.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws' }];
  __state.trusted = true;
  __state.findFilesResult = [];
  __state.warningResponse = undefined;
  __state.registeredTools = new Map();
  __state.registeredCommands = new Map();
  __state.configuration = new Map();
  __state.configChangeListeners = [];
  __state.terminals = [];
  __state.terminalCloseListeners = [];
  __state.statusBarItems = [];
  __state.quickPickResponse = undefined;
  __state.inputBoxResponse = undefined;
  __state.secrets = new Map();
  __state.diagnostics = new Map();
  __state.activeTextEditor = undefined;
  __state.contentProviders = new Map();
  __state.tabs = [];
}

/** The content provider registered for a scheme (registerTextDocumentContentProvider). */
export function __getContentProvider(scheme: string): FakeContentProvider | undefined {
  return __state.contentProviders.get(scheme);
}

/** The labels of the currently-open editor tabs (previews opened in tests). */
export function __openTabLabels(): string[] {
  return __state.tabs.map((t) => t.label);
}

/** Seed the diagnostics languages.getDiagnostics returns for a uri. */
export function __setDiagnostics(uri: Uri, diagnostics: unknown[]): void {
  __state.diagnostics.set(uri.path, diagnostics);
}

/** Set the fake active text editor window.activeTextEditor returns. */
export function __setActiveEditor(editor: unknown): void {
  __state.activeTextEditor = editor;
}

/** Choose which quick-pick item index showQuickPick returns next. */
export function __setQuickPickResponse(index: number | undefined): void {
  __state.quickPickResponse = index;
}

/** Set what showInputBox returns next. */
export function __setInputBoxResponse(value: string | undefined): void {
  __state.inputBoxResponse = value;
}

/** A fake SecretStorage backed by __state.secrets, for context.secrets in tests. */
export const secrets = {
  get: vi.fn(async (key: string): Promise<string | undefined> => __state.secrets.get(key)),
  store: vi.fn(async (key: string, value: string): Promise<void> => {
    __state.secrets.set(key, value);
  }),
  delete: vi.fn(async (key: string): Promise<void> => {
    __state.secrets.delete(key);
  }),
};

export interface FakeStatusBarItem {
  text: string;
  tooltip: string | MarkdownString | undefined;
  command: string | undefined;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** Simulate the user closing a terminal tab. */
export function __closeTerminal(terminal: FakeTerminal): void {
  for (const listener of [...__state.terminalCloseListeners]) {
    listener(terminal);
  }
}

/** Seed a user setting, e.g. __setConfig('myDevTeam.ollama.endpoint', url). */
export function __setConfig(fullKey: string, value: unknown): void {
  __state.configuration.set(fullKey, value);
}

/** Toggle workspace trust (the `false` case is Restricted Mode). */
export function __setTrusted(trusted: boolean): void {
  __state.trusted = trusted;
}

/**
 * Replace the open workspace folders. Each spec is a folder name and root
 * path; an optional scheme other than "file" stands in for a virtual
 * workspace folder.
 */
export function __setWorkspaceFolders(
  specs: Array<{ name: string; path: string; scheme?: string }>
): void {
  __state.workspaceFolders = specs.map((s) => ({
    name: s.name,
    uri: s.scheme ? Uri.from({ scheme: s.scheme, path: s.path }) : Uri.file(s.path),
  }));
}

/** Seed a file under a named workspace folder (multi-root tests). */
export function __setFileIn(folderName: string, relPath: string, contents: string): Uri {
  const folder = __state.workspaceFolders?.find((f) => f.name === folderName);
  if (!folder) {
    throw new Error(`No workspace folder named "${folderName}" in the mock state.`);
  }
  const uri = Uri.joinPath(folder.uri, relPath);
  __state.files.set(uri.path, contents);
  return uri;
}

/** Seed a file into the fake fs under the workspace root. */
export function __setFile(relPath: string, contents: string): Uri {
  const uri = Uri.joinPath(__state.workspaceFolders![0].uri, relPath);
  __state.files.set(uri.path, contents);
  return uri;
}

/**
 * Seed a file at an absolute path (outside any workspace root), e.g. under a
 * mocked home directory. The path is interpreted as a `file:` Uri.
 */
export function __setFileAbs(absPath: string, contents: string): Uri {
  const uri = Uri.file(absPath);
  __state.files.set(uri.path, contents);
  return uri;
}

/**
 * Seed a path that fs.stat reports as a symbolic link (it still has readable
 * bytes, standing in for a link whose target is outside the workspace).
 */
export function __setSymlink(relPath: string, contents = ''): Uri {
  const uri = __setFile(relPath, contents);
  __state.symlinks.add(uri.path);
  return uri;
}

/**
 * Seed a directory path that fs.stat reports as a symbolic link, standing in
 * for a symlinked directory whose target is outside the workspace. Files
 * "inside" it are seeded separately with __setFile.
 */
export function __setSymlinkDir(relPath: string): Uri {
  const uri = Uri.joinPath(__state.workspaceFolders![0].uri, relPath);
  __state.symlinks.add(uri.path);
  return uri;
}

// --- API surface ---

export const workspace = {
  get workspaceFolders() {
    return __state.workspaceFolders;
  },

  get isTrusted() {
    return __state.trusted;
  },

  fs: {
    readFile: vi.fn(async (uri: Uri): Promise<Uint8Array> => {
      if (!__state.files.has(uri.path)) {
        throw new Error(`ENOENT: ${uri.path}`);
      }
      return new TextEncoder().encode(__state.files.get(uri.path)!);
    }),

    writeFile: vi.fn(async (uri: Uri, bytes: Uint8Array): Promise<void> => {
      __state.files.set(uri.path, new TextDecoder().decode(bytes));
    }),

    createDirectory: vi.fn(async (_uri: Uri): Promise<void> => {
      // Directories are implicit in the flat file map.
    }),

    readDirectory: vi.fn(async (uri: Uri): Promise<[string, number][]> => {
      // Derive the immediate children of `uri` from the flat file map: a path
      // with no further separator is a File, one with more is a Directory.
      const prefix = uri.path.replace(/\/+$/, '') + '/';
      const children = new Map<string, number>();
      for (const filePath of __state.files.keys()) {
        if (!filePath.startsWith(prefix)) {
          continue;
        }
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash === -1 ? rest : rest.slice(0, slash);
        const type = slash === -1 ? FileType.File : FileType.Directory;
        // A directory wins over a file entry of the same name (a path both has
        // children and, hypothetically, exists as a file).
        if (!children.has(name) || type === FileType.Directory) {
          children.set(name, type);
        }
      }
      if (children.size === 0) {
        // Mirror the real API: reading a directory that does not exist throws.
        throw new Error(`ENOENT: ${uri.path}`);
      }
      return [...children.entries()];
    }),

    stat: vi.fn(async (uri: Uri): Promise<{ type: number; size: number }> => {
      if (!__state.files.has(uri.path)) {
        // A symlink seeded without bytes stands in for a symlinked directory.
        if (__state.symlinks.has(uri.path)) {
          return { type: FileType.Directory | FileType.SymbolicLink, size: 0 };
        }
        throw new Error(`ENOENT: ${uri.path}`);
      }
      const size = new TextEncoder().encode(__state.files.get(uri.path)!).length;
      const type = __state.symlinks.has(uri.path)
        ? FileType.File | FileType.SymbolicLink
        : FileType.File;
      return { type, size };
    }),
  },

  findFiles: vi.fn(
    async (_glob: string, _exclude?: string, _max?: number): Promise<Uri[]> =>
      __state.findFilesResult
  ),

  asRelativePath: vi.fn((uri: Uri): string => {
    // Mirror VS Code: in a multi-root workspace the path is prefixed with the
    // folder's name; in a single-folder workspace it is not.
    const folders = __state.workspaceFolders ?? [];
    const multi = folders.length > 1;
    for (const folder of folders) {
      const base = folder.uri.path;
      if (uri.path === base) {
        return multi ? folder.name : '';
      }
      if (uri.path.startsWith(base + '/')) {
        const rel = uri.path.slice(base.length + 1);
        return multi ? `${folder.name}/${rel}` : rel;
      }
    }
    return uri.path;
  }),

  getConfiguration: vi.fn((section?: string) => ({
    get: <T>(key: string, fallback?: T): T | undefined => {
      const fullKey = section ? `${section}.${key}` : key;
      return __state.configuration.has(fullKey)
        ? (__state.configuration.get(fullKey) as T)
        : fallback;
    },
    update: async (key: string, value: unknown): Promise<void> => {
      __state.configuration.set(section ? `${section}.${key}` : key, value);
    },
  })),

  onDidChangeConfiguration: vi.fn((listener: (e: unknown) => void) => {
    __state.configChangeListeners.push(listener);
    return {
      dispose: () => {
        __state.configChangeListeners = __state.configChangeListeners.filter(
          (l) => l !== listener
        );
      },
    };
  }),

  openTextDocument: vi.fn(async (uri: Uri) => ({
    getText: (range?: Range): string => {
      const full = __state.files.get(uri.path) ?? '';
      if (!range) {
        return full;
      }
      const lines = full.split('\n');
      return lines
        .slice(range.start.line, range.end.line + 1)
        .join('\n');
    },
  })),

  registerTextDocumentContentProvider: vi.fn(
    (scheme: string, provider: FakeContentProvider) => {
      __state.contentProviders.set(scheme, provider);
      return {
        dispose: () => {
          if (__state.contentProviders.get(scheme) === provider) {
            __state.contentProviders.delete(scheme);
          }
        },
      };
    }
  ),
};

export const window = {
  get activeTextEditor() {
    return __state.activeTextEditor;
  },

  showWarningMessage: vi.fn(
    async (..._args: unknown[]): Promise<string | undefined> =>
      __state.warningResponse
  ),

  createTerminal: vi.fn((options: { name: string; pty?: unknown }): FakeTerminal => {
    const terminal: FakeTerminal = {
      name: options.name,
      creationOptions: options as FakeTerminal['creationOptions'],
      dispose: vi.fn(),
      show: vi.fn(),
    };
    __state.terminals.push(terminal);
    return terminal;
  }),

  onDidCloseTerminal: vi.fn((listener: (t: FakeTerminal) => void) => {
    __state.terminalCloseListeners.push(listener);
    return {
      dispose: () => {
        __state.terminalCloseListeners = __state.terminalCloseListeners.filter(
          (l) => l !== listener
        );
      },
    };
  }),

  showInformationMessage: vi.fn(async (..._args: unknown[]): Promise<undefined> => undefined),

  createOutputChannel: vi.fn((name: string) => ({
    name,
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    replace: vi.fn(),
    dispose: vi.fn(),
  })),

  createStatusBarItem: vi.fn((..._args: unknown[]): FakeStatusBarItem => {
    const item: FakeStatusBarItem = {
      text: '',
      tooltip: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
    __state.statusBarItems.push(item);
    return item;
  }),

  // Returns the item at __state.quickPickResponse (set via __setQuickPickResponse).
  showQuickPick: vi.fn(async (items: unknown): Promise<unknown> => {
    const resolved = await items;
    const list = resolved as unknown[];
    const index = __state.quickPickResponse;
    return index === undefined ? undefined : list[index];
  }),

  showInputBox: vi.fn(
    async (..._args: unknown[]): Promise<string | undefined> => __state.inputBoxResponse
  ),

  // Runs the task immediately with an inert progress reporter and a token that
  // never cancels; cancellation paths are exercised by settling the awaited
  // work itself (e.g. an engine run rejecting RunCancelledError).
  withProgress: vi.fn(
    async (
      _options: unknown,
      task: (
        progress: { report: (value: unknown) => void },
        token: {
          isCancellationRequested: boolean;
          onCancellationRequested: (listener: () => void) => { dispose: () => void };
        }
      ) => Promise<unknown>
    ): Promise<unknown> =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
        }
      )
  ),

  // One tab group holding every open tab; `close` removes the given tab(s).
  tabGroups: {
    get all() {
      return [{ tabs: __state.tabs }];
    },
    close: vi.fn(async (tab: FakeTab | FakeTab[]): Promise<boolean> => {
      const targets = Array.isArray(tab) ? tab : [tab];
      __state.tabs = __state.tabs.filter((t) => !targets.includes(t));
      return true;
    }),
  },
};

/**
 * Mirrors vscode.env. `appRoot` is undefined by default so the bundled-ripgrep
 * lookup finds nothing and content search falls back to the JavaScript scan;
 * the ripgrep path itself is tested by injecting its dependencies.
 */
export const env = {
  appRoot: undefined as string | undefined,
};

export const commands = {
  registerCommand: vi.fn((id: string, fn: (...args: unknown[]) => unknown) => {
    __state.registeredCommands.set(id, fn);
    return { dispose: vi.fn() };
  }),

  executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
    // Built-in markdown preview commands have no registered handler; simulate
    // them by opening a tab VS Code labels "Preview <fileName>", so the plan
    // preview's open/close round-trip is observable in tests.
    if (id === 'markdown.showPreview' || id === 'markdown.showPreviewToSide') {
      const uri = args[0] as Uri | undefined;
      const name = uri ? uri.path.split('/').pop() ?? uri.path : '';
      __state.tabs.push({ label: `Preview ${name}` });
      return undefined;
    }
    const fn = __state.registeredCommands.get(id);
    if (!fn) {
      throw new Error(`command '${id}' not found`);
    }
    return fn(...args);
  }),
};

export const lm = {
  registerTool: vi.fn((name: string, impl: unknown) => {
    __state.registeredTools.set(name, impl);
    return { dispose: vi.fn() };
  }),
};

export const languages = {
  registerCodeActionsProvider: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
  registerCodeLensProvider: vi.fn((..._args: unknown[]) => ({ dispose: vi.fn() })),
  getDiagnostics: vi.fn((uri: Uri): unknown[] => __state.diagnostics.get(uri.path) ?? []),
};

export const chat = {
  createChatParticipant: vi.fn((_id: string, _handler: unknown) => ({
    followupProvider: undefined as unknown,
    onDidReceiveFeedback: vi.fn(),
    dispose: vi.fn(),
  })),
};
