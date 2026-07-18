import * as vscode from 'vscode';
import { WorkspaceToolHost } from './tools/toolHost';
import { McpHub } from './client/mcp';
import { createEngineProvider } from './client/engineFactory';
import { EvalLog } from './client/evalLog';
import { ChangeTracker } from './client/changeTracker';
import {
  PARTICIPANT_ID,
  COMPACT_NOW_COMMAND_ID,
  ChatApprover,
  ChatPlanReviewer,
  ChatContinuePrompt,
  ChatClarifyPrompt,
  createHandler,
  TurnMetadata,
} from './ui/chatParticipant';
import { PlanPreview } from './ui/planPreview';
import { TerminalRunMirror } from './ui/runTerminal';
import { checkEngineAtStartup } from './ui/startupCheck';
import {
  pickModel,
  runSetApiKeyCommand,
  SELECT_MODEL_COMMAND_ID,
  SET_API_KEY_COMMAND_ID,
} from './ui/modelCommands';
import { pickVerbosity, SELECT_VERBOSITY_COMMAND_ID } from './ui/verbosityCommands';
import { pickTriageMode, SELECT_TRIAGE_MODE_COMMAND_ID } from './ui/triageModeCommands';
import { StatusBar, STATUS_MENU_COMMAND_ID } from './ui/statusBar';
import { runShowUsageCommand, SHOW_USAGE_COMMAND_ID } from './ui/usageView';
import { registerEditorEntryPoints } from './ui/editorEntryPoints';
import { registerQuickQuestion } from './ui/quickQuestion';
import { setRuntimeConfig } from './config/runtimeConfig';
import { liveRuntimeConfig } from './config/settings';
import { setSecretSource } from './config/credentials';
import { setDebugSink } from './config/debugLog';
import { loadStoredApiKeys, secretStorageSource } from './client/secrets';
import { DebugChannel, DEBUG_CHANNEL_NAME } from './client/debugLog';

export function activate(context: vscode.ExtensionContext) {
  // --- Engine runtime config ---
  // The engine reads the user's settings through the injected runtime-config
  // seam (config/runtimeConfig.ts), never `vscode` directly, so it can run in a
  // separate process (the sidecar). In the host we inject a live view backed by
  // `settings`, so a settings change still takes effect on the next request.
  setRuntimeConfig(liveRuntimeConfig());

  // Cloud keys: the in-process local engine may use the editor's SecretStorage
  // (the "Set API Key" command), so inject that source and load any stored keys.
  // The sidecar child never loads this module, so it keeps the env-only default.
  setSecretSource(secretStorageSource);
  void loadStoredApiKeys(context.secrets);

  // --- Debug logging seam: the "My Dev Team (Debug)" output channel ---
  // When `myDevTeam.debug` is on, every run is traced here: the client logs the
  // client<->backend protocol (via the engine tracer below), and the engine logs
  // each provider-API call. The in-process local engine writes through this
  // injected sink directly; the sidecar forwards its entries over the wire (the
  // engine provider wires that side). A no-op when the setting is off.
  const debugOutput = vscode.window.createOutputChannel(DEBUG_CHANNEL_NAME);
  context.subscriptions.push(debugOutput);
  const debugChannel = new DebugChannel(debugOutput);
  setDebugSink(debugChannel.asSink());

  // --- Approval seam: Phase 1 uses the chat-based approver ---
  // Created before the tool host because the side-effecting `run` tool is
  // gated by it. Registering wires up the command its in-chat
  // Approve/Decline buttons invoke.
  const approver = new ChatApprover();
  approver.register(context);

  // --- Plan-preview seam: a big paused plan opens beside the chat ---
  // Serves the plan markdown as a read-only virtual document; the reviewer
  // opens/closes it per review. Registered before the reviewer it backs.
  const planPreview = new PlanPreview();
  planPreview.register(context);

  // --- Plan-approval seam: the gate shown before a plan executes ---
  // Like the approver, registered up front so its in-chat Approve/Cancel/Revise
  // links work; the engine calls it via the run client's reviewPlan when the
  // myDevTeam.planApproval setting asks to pause. The preview seam lets a big
  // plan also open in the editor per myDevTeam.planApproval.preview.
  const planReviewer = new ChatPlanReviewer(planPreview);
  planReviewer.register(context);

  // --- Executor check-in seam: the "still working, keep going?" prompt ---
  // Registered up front like the plan reviewer so its in-chat Keep going / Stop
  // links work; the engine calls it via the run client's confirmContinue when a
  // long task crosses the myDevTeam.executor.checkpoint* thresholds.
  const continuePrompt = new ChatContinuePrompt();
  continuePrompt.register(context);

  // --- Planner clarification: the "a quick question before I plan?" prompt ---
  // The planner's `clarify` tool dispatches to this through the run host's `tool`
  // capability; the answer is collected in a pop-up and the client composes it
  // into the tool result that rides back into the planner loop. No command
  // registration - the pop-up is modal.
  const clarifyPrompt = new ChatClarifyPrompt();

  // --- Run-transparency seam: mirror executed commands into a terminal ---
  // Every approved `run` command's live output lands in a read-only
  // "Dev Team" terminal tab the user can open; never revealed automatically.
  const runMirror = new TerminalRunMirror();
  context.subscriptions.push(runMirror);

  // --- Change-tracking seam: sum each turn's writes into a Changes line ---
  // The write/edit tools report every file they land here; the chat handler
  // opens a per-turn session and renders the rolled-up "N files changed" line.
  const changeTracker = new ChangeTracker();

  // --- MCP seam: tools from user-configured MCP servers ---
  // Launches the servers configured in myDevTeam.mcp.servers (over stdio,
  // nothing in an untrusted workspace), discovers their tools, and runs a call
  // back through the ToolHost behind the same Approver as the run tool. Disposed
  // on deactivate so the server processes are closed.
  const mcp = new McpHub();
  context.subscriptions.push({ dispose: () => void mcp.dispose() });

  // --- The client's hands: the workspace ToolHost ---
  // The one place tool calls are validated and dispatched - the client half of
  // the engine's tool inversion (the `tool` capability of the run's ClientHost).
  // Whichever engine runs, the implementations, the approval gate, the mirror,
  // and the change tracker stay here on the user's machine. The MCP hub is
  // handed in so a discovered MCP tool dispatches like any other. The tools are
  // deliberately not registered as editor-wide Language Model Tools: they are
  // private to `@devteam`, not exposed for other chat models in the editor to call.
  const toolHost = new WorkspaceToolHost(approver, runMirror, changeTracker, mcp);

  // --- The engine, behind the protocol ---
  // The provider reads `myDevTeam.engine` live per request: the in-process
  // LocalEngine today, a RemoteEngine speaking the same protocol in Phase B.
  // Fire-and-forget health check: the selected engine reports what is wrong
  // (unreachable Ollama, missing models) instead of letting the first chat
  // request be the thing that fails. Never blocks activation.
  const sidecarScriptPath = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'sidecar.js'
  ).fsPath;
  const engineProvider = createEngineProvider(sidecarScriptPath, debugChannel);
  const getEngine = engineProvider.getEngine;
  context.subscriptions.push({ dispose: () => engineProvider.dispose() });
  void checkEngineAtStartup(getEngine());

  // --- The unified status-bar button ---
  // One "My Dev Team" button whose menu changes the model and opens the usage
  // report; it also holds the live state those rows show (the current model
  // label and the running session token total). Created here so model
  // selection can refresh its label and the chat handler can feed it usage.
  const statusBar = new StatusBar(getEngine(), STATUS_MENU_COMMAND_ID);
  context.subscriptions.push(statusBar);
  void statusBar.refresh();
  context.subscriptions.push(
    vscode.commands.registerCommand(STATUS_MENU_COMMAND_ID, () => statusBar.openMenu())
  );

  // --- Model selection ---
  // Wire the model picker and the "Set API Key" command (the latter stores a
  // cloud key in SecretStorage for the local engine). The chosen model travels
  // on every run request via the myDevTeam.model setting; the engine routes by
  // capability when it is "auto". The status button's menu shows the active
  // model and refreshes after a pick.
  context.subscriptions.push(
    vscode.commands.registerCommand(SELECT_MODEL_COMMAND_ID, async () => {
      await pickModel(getEngine());
      void statusBar.refresh();
    }),
    vscode.commands.registerCommand(SET_API_KEY_COMMAND_ID, () =>
      runSetApiKeyCommand(context.secrets)
    ),
    // Output verbosity: a pure rendering setting the chat renderer reads live,
    // so the picker is just a setting write (no status-bar refresh needed - the
    // menu reads the mode fresh when it opens).
    vscode.commands.registerCommand(SELECT_VERBOSITY_COMMAND_ID, () => pickVerbosity()),
    // Routing mode: the engine reads myDevTeam.triage.mode live, so the picker is
    // just a setting write (the menu reads the mode fresh when it opens).
    vscode.commands.registerCommand(SELECT_TRIAGE_MODE_COMMAND_ID, () => pickTriageMode()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('myDevTeam.model')) {
        void statusBar.refresh();
      }
      // The hover shows a "Debug mode: on" line while myDevTeam.debug is on;
      // redraw it the moment the setting flips so the line is never stale.
      if (e.affectsConfiguration('myDevTeam.debug')) {
        statusBar.redrawTooltip();
      }
    })
  );

  // --- Telemetry/eval seam: the local, opt-in eval log ---
  // Run records (route, per-step usage, outcome) and 👍/👎 feedback land in
  // one JSONL file under the extension's global storage when
  // myDevTeam.telemetry.evalLog is on. It stores no prompt or reply text.
  const evalLog = new EvalLog(context.globalStorageUri);

  // --- Token-usage surfaces ---
  // The status button accumulates each run's tokens live (independent of the
  // opt-in log) and shows the session total in its menu, and the "Show Token
  // Usage" command rolls the stored log up into a report. The handler feeds the
  // button every finished run's usage.
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_USAGE_COMMAND_ID, () =>
      runShowUsageCommand(evalLog)
    )
  );

  // --- Quick questions ---
  // The hotkey path for a side question while a chat turn is busy: an input
  // box, a run on the pinned /ask route (no history, no tools), and the answer
  // in a read-only preview beside the editor. Shares the chat handler's engine
  // provider, eval log, and session token counter, so a quick question is
  // billed and logged like any run.
  registerQuickQuestion(context, getEngine, evalLog, (usage) => statusBar.add(usage));

  // --- Editor entry points ---
  // Meet the user in the editor, not only the chat panel: a "Fix with Dev
  // Team" quick fix on a diagnostic, an "Explain with Dev Team" selection
  // action, and a write/repair-tests CodeLens on test files. Each is a thin
  // shim that opens the chat with a pinned slash command, so the routing,
  // references, and approvals all flow through the same pipeline.
  registerEditorEntryPoints(context);

  // The "Compact now" action a context warning offers (below the auto-compact
  // threshold): opens the chat with `@devteam /compact`, reusing the manual
  // compact path. Registered programmatically (invoked from a trusted chat link,
  // not the command palette), like the approval/review link commands.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMPACT_NOW_COMMAND_ID, () =>
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '@devteam /compact',
      })
    )
  );

  // --- UI layer: the chat participant ---
  const handler = createHandler(
    getEngine,
    toolHost,
    evalLog,
    (usage) => statusBar.add(usage),
    changeTracker,
    planReviewer,
    // The handler owns the approval session: it opens one keyed by the run id
    // and binds the run's tool calls to it, so an approval renders in the turn
    // that owns it. The plan-review session has no such per-call seam, so the
    // wrapper still manages it the most-recent way below.
    approver,
    // The same MCP hub the ToolHost uses: the handler discovers its tools and
    // ships them on the run request, so the offered names and shipped
    // definitions are one set.
    mcp,
    // The check-in seam: the handler offers confirmContinue so a long run can
    // pause and ask whether to keep going.
    continuePrompt,
    // The clarify prompt: the handler offers the `clarify` tool (and dispatches
    // its calls here) so the planner can ask a focused question while drafting.
    clarifyPrompt
  );
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, ctx, stream, token) => {
      // Each request opens its own plan-review session: when it ends (or is
      // cancelled, where a pending prompt could otherwise block the run
      // forever), disposing settles only this request's review - a concurrent
      // turn's pending review and stream are untouched. (The approval session
      // is opened inside the handler, keyed by the run id.)
      const reviewSession = planReviewer.openSession(stream);
      const checkpointSession = continuePrompt.openSession(stream);
      const clarifySession = clarifyPrompt.openSession(stream);
      const cancellation = token.onCancellationRequested(() => {
        reviewSession.dispose();
        checkpointSession.dispose();
        clarifySession.dispose();
      });
      try {
        return await handler(request, ctx, stream, token);
      } finally {
        cancellation.dispose();
        reviewSession.dispose(); // idempotent: a cancelled request already closed it
        checkpointSession.dispose();
        clarifySession.dispose();
      }
    }
  );

  // Clarify follow-ups: when a turn ended by asking (intent "clarify"), offer
  // each suggested answer as a clickable chip. Clicking one submits it as the
  // next turn to this participant, so the engine sees the question and the answer
  // in the conversation history and carries the work forward - the same path a
  // typed reply takes (the chips are a shortcut, not the only way to answer).
  participant.followupProvider = {
    provideFollowups(result) {
      const questions = (result.metadata as Partial<TurnMetadata> | undefined)?.questions;
      if (!questions || questions.length === 0) {
        return [];
      }
      const followups: vscode.ChatFollowup[] = [];
      const labelMany = questions.length > 1;
      for (const q of questions) {
        for (const option of q.options) {
          followups.push({
            prompt: option,
            // With several questions a bare option is ambiguous, so prefix the
            // chip with a short slice of its question; a single question needs no
            // prefix.
            label: labelMany ? `${q.question.slice(0, 24)}: ${option}` : option,
          });
        }
      }
      return followups;
    },
  };

  // Built-in feedback: 👍/👎 from the native chat panel arrive here. The
  // handler put the run id and route into the judged turn's result metadata,
  // so the click can be paired with the run record it grades.
  participant.onDidReceiveFeedback((fb) => {
    const kind =
      fb.kind === vscode.ChatResultFeedbackKind.Helpful ? 'helpful' : 'unhelpful';
    console.log(`[My Dev Team] feedback: ${kind}`);
    const metadata = (fb.result?.metadata ?? {}) as Partial<TurnMetadata>;
    void evalLog.recordFeedback({
      kind,
      runId: metadata.runId,
      intent: metadata.intent,
      command: metadata.command,
    });
  });

  context.subscriptions.push(participant);
}

export function deactivate() {}
