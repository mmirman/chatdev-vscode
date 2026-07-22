import * as vscode from "vscode";
import { ChatDevApi } from "./api";
import {
  continueCurrentProjectInEditor,
  currentAgentId,
  ensureRunning,
  handleEditorCallback,
  openAgentPickerInBrowser,
  openAgentWorkspace,
  pickAndOpenAgent,
  resumePendingContinuations,
} from "./commands";
import { ChatDevFileSystem } from "./remote-filesystem";
import { AgentTerminal, ShellTerminal } from "./terminals";
import { ActionsViewProvider, AgentItem, AgentsViewProvider } from "./views";
import { ChatDevLanguageModelProvider } from "./language-model-provider";
import { registerChatDevParticipant } from "./chat-participant";
import { disposeSessionTranscriptSyncs, restoreSessionTranscriptSync, restoreWorkspaceSessionDiscoveries } from "./session-sync";
import { disposeWorkspaceMirrors, restoreWorkspaceMirrors } from "./workspace-mirror";
import { ensureCursorBridgeReady, registerCursorAgentPanel } from "./cursor-agent-panel";
import { configureLocalSessionStorage } from "./local-sessions";

let deletedWorkspaceRecovery: Promise<boolean> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureLocalSessionStorage(context.globalStorageUri.fsPath);
  const api = new ChatDevApi(context);
  const fileSystem = new ChatDevFileSystem(api);
  const languageModels = new ChatDevLanguageModelProvider(api);
  context.subscriptions.push(
    fileSystem,
    vscode.workspace.registerFileSystemProvider("chatdev", fileSystem, { isCaseSensitive: true, isReadonly: false }),
    languageModels,
  );
  if (typeof vscode.lm?.registerLanguageModelChatProvider === "function") {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("chatdev", languageModels));
  }
  if (typeof vscode.chat?.createChatParticipant === "function") {
    context.subscriptions.push(registerChatDevParticipant(context, api));
  }
  await vscode.commands.executeCommand("setContext", "chatdev.signedIn", await api.isSignedIn());

  const agentsView = new AgentsViewProvider(api);
  const actionsView = new ActionsViewProvider(api);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 25);
  status.name = "chat.dev Remote Agents";
  status.text = "$(remote) chat.dev";
  status.tooltip = "Open chat.dev Remote Agents";
  status.command = "workbench.view.extension.chatdev";
  status.show();

  const continueStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 24);
  continueStatus.name = "Continue project on chat.dev";
  continueStatus.text = "$(cloud-upload) Continue";
  continueStatus.tooltip = "Choose settings and continue this project's coding-agent conversation on chat.dev";
  continueStatus.command = "chatdev.moveSession";

  const refreshUi = async () => {
    const signedIn = await api.isSignedIn();
    await vscode.commands.executeCommand("setContext", "chatdev.signedIn", signedIn);
    await vscode.commands.executeCommand("setContext", "chatdev.remoteWorkspace", !!currentAgentId());
    actionsView.refresh();
    agentsView.refresh();
    const hasLocalProject = vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === "file") ?? false;
    if (signedIn && hasLocalProject) continueStatus.show();
    else continueStatus.hide();
  };
  const cursorAgentPanelDisposables = registerCursorAgentPanel(context, api);
  context.subscriptions.push(...cursorAgentPanelDisposables);
  if (!(await ensureCursorBridgeReady(context))) return;

  const continueInEditor = async () => {
    if (!(await ensureCursorBridgeReady(context))) return;
    await continueCurrentProjectInEditor(api);
    await refreshUi();
  };

  context.subscriptions.push(
    status,
    continueStatus,
    vscode.window.registerTreeDataProvider("chatdev.actions", actionsView),
    vscode.window.registerTreeDataProvider("chatdev.agents", agentsView),
    vscode.commands.registerCommand("chatdev.signIn", () => run(async () => {
      await api.signIn();
      if (!(await ensureCursorBridgeReady(context))) return;
      languageModels.refresh();
      if (!(await recoverDeletedRemoteWorkspace(api))) {
        await refreshUi();
        return;
      }
      await resumePendingContinuations(api);
      await restoreWorkspaceMirrors(api);
      await restoreWorkspaceSessionDiscoveries(api);
      await refreshUi();
      const agentId = currentAgentId();
      if (agentId) restoreSessionTranscriptSync(api, agentId);
    }, "Signed in to chat.dev.")),
    vscode.commands.registerCommand("chatdev.signOut", () => run(async () => {
      disposeSessionTranscriptSyncs();
      disposeWorkspaceMirrors();
      await api.signOut();
      languageModels.refresh();
      await refreshUi();
    }, "Signed out of chat.dev.")),
    vscode.window.registerUriHandler({ handleUri: (uri) => { void run(async () => { await handleEditorCallback(api, uri); await refreshUi(); }); } }),
    vscode.commands.registerCommand("chatdev.openAgent", () => run(() => openAgentPickerInBrowser(api))),
    vscode.commands.registerCommand("chatdev.openAgentNative", () => run(() => pickAndOpenAgent(api))),
    vscode.commands.registerCommand("chatdev.openAgentItem", (value: AgentItem | Parameters<typeof openAgentWorkspace>[1]) => run(() => openAgentWorkspace(api, value instanceof AgentItem ? value.agent! : value))),
    vscode.commands.registerCommand("chatdev.openAgentTerminalItem", (value: AgentItem | Parameters<typeof openAgentWorkspace>[1]) => run(() => openAgentTerminal(api, value instanceof AgentItem ? value.agent : value))),
    vscode.commands.registerCommand("chatdev.openShellItem", (item: AgentItem) => run(() => openAgentShell(api, item.agent))),
    vscode.commands.registerCommand("chatdev.refreshAgents", () => agentsView.refresh()),
    vscode.commands.registerCommand("chatdev.moveSession", () => run(continueInEditor)),
    vscode.commands.registerCommand("chatdev.continueNative", () => run(continueInEditor)),
    vscode.commands.registerCommand("chatdev.virtualizeWorkspace", () => run(continueInEditor)),
    vscode.commands.registerCommand("chatdev.openAgentTerminal", () => run(() => openAgentTerminal(api))),
    vscode.commands.registerCommand("chatdev.openShell", () => run(() => openAgentShell(api))),
    vscode.commands.registerCommand("chatdev.openGuide", () => vscode.env.openExternal(vscode.Uri.parse("https://github.com/mmirman/chatdev-vscode#readme"))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void recoverDeletedRemoteWorkspace(api).then(async (available) => {
        if (!available) return;
        await resumePendingContinuations(api);
        await restoreWorkspaceMirrors(api);
        await restoreWorkspaceSessionDiscoveries(api);
        const agentId = currentAgentId();
        if (agentId) restoreSessionTranscriptSync(api, agentId);
        await refreshUi();
      });
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      void recoverDeletedRemoteWorkspace(api).then(async (available) => {
        if (!available) return;
        await resumePendingContinuations(api);
        await restoreWorkspaceMirrors(api);
        await restoreWorkspaceSessionDiscoveries(api);
        await refreshUi();
      });
    }),
  );

  const remoteWorkspaceAvailable = await recoverDeletedRemoteWorkspace(api);
  if (remoteWorkspaceAvailable) {
    await resumePendingContinuations(api);
    await restoreWorkspaceMirrors(api);
    await restoreWorkspaceSessionDiscoveries(api);
  }
  await refreshUi();

  const activeAgentId = remoteWorkspaceAvailable ? currentAgentId() : undefined;
  if (activeAgentId) {
    restoreSessionTranscriptSync(api, activeAgentId);
    await restoreRemoteEditorState(context);
  }
}

function recoverDeletedRemoteWorkspace(api: ChatDevApi): Promise<boolean> {
  const remoteFolder = vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === "chatdev");
  if (remoteFolder && !vscode.window.state.focused) return Promise.resolve(false);
  deletedWorkspaceRecovery ||= performDeletedRemoteWorkspaceRecovery(api)
    .finally(() => { deletedWorkspaceRecovery = undefined; });
  return deletedWorkspaceRecovery;
}

async function performDeletedRemoteWorkspaceRecovery(api: ChatDevApi): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === "chatdev");
  const agentId = currentAgentId();
  if (!folder || !agentId || !(await api.isSignedIn())) return true;
  try {
    const agent = await api.getAgent(agentId);
    if (agent.status !== "deleted") return true;
  } catch (error) {
    if ((error as Error & { status?: number })?.status !== 404) return true;
  }

  if (!vscode.window.state.focused) return false;

  const choice = await vscode.window.showErrorMessage(
    "This chat.dev agent was deleted. This window was showing its remote workspace, so there is no local copy in this window.",
    { modal: true, detail: "The unavailable project will close. You can open another chat.dev agent or choose a local folder instead." },
    "Open another agent",
    "Open local folder",
    "Close project",
  );
  if (choice === "Open another agent") {
    await openAgentPickerInBrowser(api);
    await vscode.commands.executeCommand("workbench.action.closeFolder");
  } else if (choice === "Open local folder") {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Open folder" });
    if (selected?.[0]) await vscode.commands.executeCommand("vscode.openFolder", selected[0], false);
  } else if (choice === "Close project") {
    await vscode.commands.executeCommand("workbench.action.closeFolder");
  }
  return false;
}

async function restoreRemoteEditorState(context: vscode.ExtensionContext): Promise<void> {
  const agentId = currentAgentId();
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === "chatdev");
  if (!agentId || !folder || context.workspaceState.get<boolean>(`chatdev.editorStateRestored:${agentId}`)) return;
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, ".chatdev", "editor-state.json"));
    const state = JSON.parse(Buffer.from(raw).toString("utf8")) as {
      tabs?: Array<{ path?: string; active?: boolean; line?: number; character?: number }>;
    };
    const tabs = (state.tabs || []).filter((tab) => tab.path && !tab.path.split("/").includes(".."));
    for (const tab of [...tabs.filter((item) => !item.active), ...tabs.filter((item) => item.active)]) {
      const uri = vscode.Uri.joinPath(folder.uri, ...tab.path!.split("/"));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: !tab.active });
      if (typeof tab.line === "number") {
        const position = new vscode.Position(Math.max(0, tab.line), Math.max(0, tab.character || 0));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
    await context.workspaceState.update(`chatdev.editorStateRestored:${agentId}`, true);
  } catch {
    // Older agents do not have editor-state metadata.
  }
}

export function deactivate(): void {
  disposeSessionTranscriptSyncs();
  disposeWorkspaceMirrors();
}

async function chooseTerminalAgent(api: ChatDevApi) {
  const current = currentAgentId();
  if (current) return api.getAgent(current);
  const agents = (await api.listAgents()).filter((agent) => agent.status === "running" && agent.agentRuntime !== "tool-agent");
  const picked = await vscode.window.showQuickPick(agents.map((agent) => ({ label: agent.name, description: agent.agentRuntime || "codex-tmux", agent })), {
    title: "Choose a running chat.dev agent",
  });
  return picked?.agent;
}

async function openAgentTerminal(api: ChatDevApi, selected?: Parameters<typeof openAgentWorkspace>[1]): Promise<void> {
  await api.ensureSignedIn();
  let agent = selected || await chooseTerminalAgent(api);
  if (!agent) return;
  if (agent.status !== "running") {
    await ensureRunning(api, agent);
    agent = await api.getAgent(agent.id);
  }
  const threads = await api.listAgentThreads(agent);
  const threadNames = new Map(threads.map((item) => [item.id, item.name]));
  const thread = threads.length <= 1 ? threads[0] : await vscode.window.showQuickPick(
    threads.map((item) => ({
      label: `${item.isDefault ? "$(home)" : item.branchKind === "new" ? "$(comment-discussion)" : "$(git-branch)"} ${item.name}`,
      description: item.isDefault
        ? `Default · ${item.status}`
        : item.branchKind === "new"
          ? `Independent · ${item.status}`
          : `${item.branchKind === "edit" ? "Edited" : "Branched"} from ${threadNames.get(item.parentThreadId || "") || "parent"} · ${item.status}`,
      detail: `${item.runtime}${item.model ? ` · ${item.model}` : ""}`,
      thread: item,
    })),
    { title: `${agent.name} sessions`, placeHolder: "Choose the coding session to open" },
  ).then((item) => item?.thread);
  if (!thread) return;
  if (!thread.isDefault && thread.status !== "running" && thread.status !== "starting") {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Resuming ${thread.name}`,
      cancellable: false,
    }, () => api.startAgentThread(agent.id, thread.id));
  }
  const terminalName = `${agent.name} · ${thread.name}`;
  const existing = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
  if (existing) {
    existing.show();
    return;
  }
  const terminal = vscode.window.createTerminal({ name: terminalName, pty: new AgentTerminal(api, agent.id, thread.id), isTransient: false });
  terminal.show();
}

async function openAgentShell(api: ChatDevApi, selected?: Parameters<typeof openAgentWorkspace>[1]): Promise<void> {
  await api.ensureSignedIn();
  const agent = selected || await chooseTerminalAgent(api);
  if (!agent) return;
  const terminal = vscode.window.createTerminal({ name: `${agent.name} · Shell`, pty: new ShellTerminal(api, agent.id), isTransient: false });
  terminal.show();
}

async function run(action: () => Promise<void>, successMessage?: string): Promise<void> {
  try {
    await action();
    if (successMessage) void vscode.window.showInformationMessage(successMessage);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
