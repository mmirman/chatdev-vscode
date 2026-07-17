import * as path from "path";
import * as vscode from "vscode";
import { type Agent, type AgentThread, ChatDevApi, type EditorConversation, type EditorHandoff, type EditorMachineTier } from "./api";
import { findLocalAgentSessions, readSession, readSessionMessages, type LocalAgentSession } from "./local-sessions";
import { findLocalProviderCredentials, type LocalProviderCredentials } from "./local-credentials";
import { startSessionTranscriptSync, startWorkspaceSessionDiscovery } from "./session-sync";
import { createWorkspaceArchive, isPortableWorkspaceSymlink } from "./workspace-archive";
import { showContinueProjectPanel, type ContinuePanelIntent, type ContinuePanelMachineTier, type ContinuePanelSettings } from "./continue-panel";
import { continuationFailureMessage, isAgentNotFoundError, replacementAgentName } from "./continuation-state";
import { currentMirroredAgentId, startWorkspaceMirror } from "./workspace-mirror";

const activeBrowserTransfers = new Set<string>();
const PENDING_CONTINUATIONS_KEY = "chatdev.pendingContinuations";

type PendingContinuation = {
  serverUrl: string;
  workspacePath: string;
  agentId: string;
  settings: ContinuePanelSettings;
};

export async function continueCurrentProjectInEditor(api: ChatDevApi): Promise<void> {
  await api.ensureSignedIn();
  const folder = await chooseLocalProject();
  if (!folder) return;
  if (!(await vscode.workspace.saveAll(false))) throw new Error("Save the open project files before continuing on chat.dev.");
  const sessions = await discoverLocalSessions(folder.uri);
  if (!sessions.length) throw new Error("No resumable Codex, Claude Code, or Cursor conversation was found for this project.");

  const credentialsByProvider = await findCredentialsForSessions(sessions);
  const conversations = await Promise.all(sessions.map(async (session) => {
    const credentials = credentialsByProvider.get(session.provider)!;
    return {
      id: session.sessionId,
      title: session.title,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      mtime: session.mtime,
      credentialSources: credentials.sources,
      remoteLabel: remoteDestinationLabel(session, credentials),
    };
  }));

  const machineTiers = await loadMachineTiers(api);

  const pending = await loadPendingContinuation(api, folder.uri.fsPath, sessions);
  let createdAgent = pending?.agent;
  let agentPageOpened = false;
  const readyAgent = await showContinueProjectPanel({
    projectName: folder.name,
    conversations,
    machineTiers,
    ...(pending ? { initialSettings: pending.settings } : {}),
    ...(pending ? { existingAgentName: pending.agent.name } : {}),
  }, async (settings, report, _dismiss, intent: ContinuePanelIntent) => {
    let selectedSettings = settings;
    if (intent === "replace") {
      const previousAgent = createdAgent;
      if (previousAgent) await clearPendingContinuation(api, folder.uri.fsPath, previousAgent.id);
      createdAgent = undefined;
      agentPageOpened = false;
      selectedSettings = { ...settings, name: await nextAvailableAgentName(api, settings.name) };
      await report(`Creating ${selectedSettings.name} and moving this project connection`);
    } else if (createdAgent) {
      try {
        createdAgent = await api.getAgent(createdAgent.id);
      } catch (error) {
        if (!isAgentNotFoundError(error)) throw error;
        await clearPendingContinuation(api, folder.uri.fsPath, createdAgent.id);
        createdAgent = undefined;
        await report("The previous agent no longer exists. Creating a new agent");
      }
    }
    validateContinueSettings(selectedSettings, sessions, machineTiers);
    createdAgent = await prepareRemoteContinuation(api, folder, sessions, credentialsByProvider, selectedSettings, report, createdAgent, async (agent) => {
      createdAgent = agent;
      await rememberPendingContinuation(api, folder.uri.fsPath, agent.id, selectedSettings);
      if (!agentPageOpened) {
        await openAgentPage(api, agent);
        agentPageOpened = true;
      }
    });
    await clearPendingContinuation(api, folder.uri.fsPath, createdAgent.id);
    return createdAgent;
  });
  if (!readyAgent) return;
  await clearPendingContinuation(api, folder.uri.fsPath, readyAgent.id);
  await startWorkspaceMirror(api, readyAgent.id, folder.uri);
  await startWorkspaceSessionDiscovery(api, readyAgent.id, folder.uri);
  void vscode.window.showInformationMessage(`${readyAgent.name} is ready. All ${sessions.length} session${sessions.length === 1 ? "" : "s"} and this project now mirror chat.dev.`);
}

export async function continueCurrentProjectInBrowser(api: ChatDevApi): Promise<void> {
  await api.ensureSignedIn();
  const folder = await chooseLocalProject();
  if (!folder) return;
  if (!(await vscode.workspace.saveAll(false))) throw new Error("Save the open project files before continuing on chat.dev.");
  const sessions = await discoverLocalSessions(folder.uri);
  if (!sessions.length) throw new Error("No resumable Codex, Claude Code, or Cursor conversation was found for this project.");

  const credentialsByProvider = await findCredentialsForSessions(sessions);
  const conversations: EditorConversation[] = [];
  for (const session of sessions) {
    const credentials = credentialsByProvider.get(session.provider)!;
    conversations.push({
      id: session.sessionId,
      title: session.title,
      provider: session.provider,
      runtime: remoteRuntimeForSession(session, credentials),
      ...(session.model ? { model: session.model } : {}),
      mtime: session.mtime,
      ...(credentials.sources.length ? { credentialSources: credentials.sources } : {}),
    });
  }

  const handoff = await api.createEditorHandoff({
    kind: "continue",
    callbackUri: editorCallbackUri("continue"),
    projectName: folder.name,
    projectPath: folder.uri.fsPath,
    conversations,
  });
  const opened = await vscode.env.openExternal(vscode.Uri.parse(handoff.browserUrl));
  if (!opened) throw new Error("Could not open chat.dev in your browser.");

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Finish creating the agent in chat.dev",
    cancellable: false,
  }, async (progress) => {
    while (Date.now() < Date.parse(handoff.expiresAt)) {
      const state = await api.getEditorHandoff(handoff.token);
      if (state.status === "complete") return;
      if (state.status === "failed") throw new Error(continuationFailureMessage(state.error || "The project connection stopped."));
      if (state.agentId && (state.mainSessionId || state.conversationId) && ["selected", "retry_requested"].includes(state.status)) {
        await transferBrowserHandoff(api, handoff.token, state, folder.uri, sessions, progress);
        return;
      }
      progress.report({ message: "Choose settings and click Create agent in your browser" });
      await delay(2_000);
    }
    throw new Error("The browser continuation expired. Start it again from the chat.dev toolbar.");
  });
}

export async function continueCursorSessionInBrowser(
  api: ChatDevApi,
  cursorSessionId: string,
): Promise<{ agentId: string; threadId: string }> {
  await api.ensureSignedIn();
  const folder = await chooseLocalProject();
  if (!folder) throw new Error("Open the project for this Cursor conversation first.");
  if (!(await vscode.workspace.saveAll(false))) throw new Error("Save the open project files before creating the chat.dev agent.");

  const discovered = await discoverLocalSessions(folder.uri);
  const target = discovered.find((session) => session.provider === "cursor" && session.sessionId === cursorSessionId) || {
    provider: "cursor" as const,
    runtime: "cursor-agent-tmux" as const,
    sessionId: cursorSessionId,
    cwd: folder.uri.fsPath,
    title: `Cursor ${cursorSessionId.slice(0, 8)}`,
    mtime: Date.now(),
    size: 0,
  };
  const sessions = [target, ...discovered.filter((session) => session.sessionId !== cursorSessionId)];
  const credentialsByProvider = await findCredentialsForSessions(sessions);
  const conversations: EditorConversation[] = sessions.map((session) => {
    const credentials = credentialsByProvider.get(session.provider)!;
    return {
      id: session.sessionId,
      title: session.title,
      provider: session.provider,
      runtime: remoteRuntimeForSession(session, credentials),
      ...(session.model ? { model: session.model } : {}),
      mtime: session.mtime,
      ...(credentials.sources.length ? { credentialSources: credentials.sources } : {}),
    };
  });
  const handoff = await api.createEditorHandoff({
    kind: "continue",
    callbackUri: editorCallbackUri("continue"),
    projectName: folder.name,
    projectPath: folder.uri.fsPath,
    conversations,
  });
  const opened = await vscode.env.openExternal(vscode.Uri.parse(handoff.browserUrl));
  if (!opened) await vscode.env.clipboard.writeText(handoff.browserUrl);
  void vscode.window.showInformationMessage(
    "Finish creating this Cursor agent on chat.dev.",
    "Open page",
    "Copy link",
  ).then(async (choice) => {
    if (choice === "Open page") await vscode.env.openExternal(vscode.Uri.parse(handoff.browserUrl));
    if (choice === "Copy link") await vscode.env.clipboard.writeText(handoff.browserUrl);
  });

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Waiting for chat.dev agent settings",
    cancellable: false,
  }, async (progress) => {
    while (Date.now() < Date.parse(handoff.expiresAt)) {
      const state = await api.getEditorHandoff(handoff.token);
      if (state.status === "complete" && state.agentId) {
        const agent = await api.getAgent(state.agentId);
        const remote = (await api.listAgentThreads(agent)).find((thread) => (
          thread.sourceProvider === "cursor" && thread.sourceSessionId === cursorSessionId
        ));
        if (remote) return { agentId: agent.id, threadId: remote.id };
        throw new Error("The completed project connection did not include this Cursor conversation.");
      }
      if (state.status === "failed") throw new Error(continuationFailureMessage(state.error || "The project connection stopped."));
      if (state.agentId && (state.mainSessionId || state.conversationId) && ["selected", "retry_requested"].includes(state.status)) {
        const result = await transferBrowserHandoff(api, handoff.token, state, folder.uri, sessions, progress);
        const remote = result.remoteSessions.find(({ local }) => local.provider === "cursor" && local.sessionId === cursorSessionId);
        if (!remote) throw new Error("The new Cursor conversation was not attached to the chat.dev agent.");
        return { agentId: result.agent.id, threadId: remote.remote.id };
      }
      progress.report({ message: "Choose settings and click Create agent in your browser" });
      await delay(1_000);
    }
    throw new Error("The browser continuation expired. Create the Cursor agent again.");
  });
}

export async function openAgentPickerInBrowser(api: ChatDevApi): Promise<void> {
  await api.ensureSignedIn();
  const handoff = await api.createEditorHandoff({
    kind: "open",
    callbackUri: editorCallbackUri("open"),
  });
  const opened = await vscode.env.openExternal(vscode.Uri.parse(handoff.browserUrl));
  if (!opened) throw new Error("Could not open your chat.dev agents in the browser.");
}

export async function handleEditorCallback(api: ChatDevApi, uri: vscode.Uri): Promise<void> {
  const token = new URLSearchParams(uri.query).get("handoff");
  if (!token) throw new Error("The chat.dev editor link is incomplete.");
  const handoff = await api.getEditorHandoff(token);
  if (uri.path === "/open") {
    if (!handoff.agentId) throw new Error("Choose an agent in the browser first.");
    await openAgentWorkspace(api, await api.getAgent(handoff.agentId));
    return;
  }
  if (uri.path === "/retry") {
    await resumeBrowserHandoff(api, token, handoff);
    return;
  }
  throw new Error("This chat.dev editor link is not supported.");
}

export async function resumeBrowserHandoff(api: ChatDevApi, token: string, existing?: EditorHandoff): Promise<void> {
  if (activeBrowserTransfers.has(token)) return;
  const handoff = existing || await api.getEditorHandoff(token);
  if (!handoff.agentId || !(handoff.mainSessionId || handoff.conversationId) || !handoff.projectPath) {
    throw new Error("The project connection is not ready yet.");
  }
  const folder = vscode.Uri.file(handoff.projectPath);
  const sessions = await discoverLocalSessions(folder);
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Reconnecting ${handoff.projectName || "project"} to chat.dev`,
    cancellable: false,
  }, (progress) => transferBrowserHandoff(api, token, handoff, folder, sessions, progress));
}

async function transferBrowserHandoff(
  api: ChatDevApi,
  token: string,
  handoff: EditorHandoff,
  folder: vscode.Uri,
  sessions: LocalAgentSession[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<{ agent: Agent; remoteSessions: RemoteSession[] }> {
  if (activeBrowserTransfers.has(token)) throw new Error("This project connection is already being prepared in the editor.");
  activeBrowserTransfers.add(token);
  try {
    sessions = mergeCurrentSessions(sessions, await discoverLocalSessions(folder));
    const mainSessionId = handoff.mainSessionId || handoff.conversationId!;
    const mainSession = sessions.find((item) => item.sessionId === mainSessionId);
    if (!mainSession) throw new Error("The selected Main session is no longer available in this editor.");
    let agent = await api.getAgent(handoff.agentId!);
    const credentialsByProvider = await findCredentialsForSessions(sessions);

    await reportBrowserProgress(api, token, progress, "Preparing local provider logins");
    await installCredentials(api, agent, credentialsByProvider, handoff.credentialScope);
    const remoteSessions = await createRemoteSessions(
      api,
      agent,
      sessions,
      mainSession,
      credentialsByProvider,
      handoff.credentialScope,
      agent.model || undefined,
      agent.agentRuntime || undefined,
    );

    await importSessionHistories(api, agent, remoteSessions, (message) => reportBrowserProgress(api, token, progress, message));

    await reportBrowserProgress(api, token, progress, "Starting the chat.dev agent");
    await ensureRunning(api, agent);
    agent = await api.getAgent(agent.id);

    await attachCodingSessions(api, agent, remoteSessions, (message) => reportBrowserProgress(api, token, progress, message));
    await startWorkspaceMirror(api, agent.id, folder);
    await startWorkspaceSessionDiscovery(api, agent.id, folder);

    const entries = await collectEntries(folder, excludedDirectoryNames());
    const editorState = captureEditorState(folder);
    await api.updateEditorHandoff(token, { status: "uploading", progressMessage: `Packaging ${entries.length} project items` });
    progress.report({ message: `Packaging ${entries.length} project items` });
    await uploadWorkspace(api, agent.id, folder, entries, excludedDirectoryNames(), progress, async (message) => {
      await api.updateEditorHandoff(token, { status: "uploading", progressMessage: message });
    });
    await api.writeWorkspaceFile(agent.id, ".chatdev/editor-state.json", Buffer.from(JSON.stringify(editorState, null, 2)));

    await api.updateEditorHandoff(token, { status: "complete", progressMessage: `Project and ${sessions.length} sessions ready`, error: null });
    void vscode.window.showInformationMessage(`${handoff.projectName || "Project"} and ${sessions.length} session${sessions.length === 1 ? "" : "s"} now mirror ${agent.name} on chat.dev.`, "Open agent").then((choice) => {
      if (choice === "Open agent") void openAgentPage(api, agent);
    });
    return { agent, remoteSessions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api.updateEditorHandoff(token, { status: "failed", progressMessage: "Connection stopped", error: message }).catch(() => undefined);
    throw new Error(continuationFailureMessage(error));
  } finally {
    activeBrowserTransfers.delete(token);
  }
}

function mergeCurrentSessions(snapshot: LocalAgentSession[], current: LocalAgentSession[]): LocalAgentSession[] {
  const key = (session: LocalAgentSession) => `${session.provider}:${session.sessionId}`;
  const currentByKey = new Map(current.map((session) => [key(session), session]));
  const merged = snapshot.map((session) => currentByKey.get(key(session)) || session);
  const included = new Set(merged.map(key));
  for (const session of current) {
    if (!included.has(key(session))) merged.push(session);
  }
  return merged.sort((left, right) => right.mtime - left.mtime);
}

function editorCallbackUri(path: "continue" | "open"): string {
  return vscode.Uri.from({
    scheme: vscode.env.uriScheme,
    authority: "chatdev.chatdev-remote",
    path: `/${path}`,
  }).toString(true);
}

async function chooseLocalProject(): Promise<vscode.WorkspaceFolder | undefined> {
  const localFolders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "file");
  if (!localFolders.length) throw new Error("Open the project you want to continue on chat.dev first.");
  if (localFolders.length === 1) return localFolders[0];
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the project to continue on chat.dev" });
  return picked?.uri.scheme === "file" ? picked : undefined;
}

async function discoverLocalSessions(workspace: vscode.Uri): Promise<LocalAgentSession[]> {
  return (await findLocalAgentSessions(workspace)).sort((left, right) => right.mtime - left.mtime);
}

export async function pickAndOpenAgent(api: ChatDevApi): Promise<void> {
  await api.ensureSignedIn();
  const agents = (await api.listAgents()).filter((agent) => agent.status !== "deleted" && agent.agentRuntime !== "tool-agent");
  const picked = await vscode.window.showQuickPick(agents.map((agent) => ({
    label: agent.name,
    description: `${agent.status} · ${agent.machineSize || "standard"} · ${agent.agentRuntime || "codex-tmux"}`,
    agent,
  })), { title: "Open a chat.dev agent", placeHolder: "Choose an agent workspace" });
  if (!picked) return;
  await openAgentWorkspace(api, picked.agent);
}

export async function openAgentWorkspace(api: ChatDevApi, agent: Agent): Promise<void> {
  await api.ensureSignedIn();
  await ensureRunning(api, agent);
  if (currentAgentId() === agent.id) {
    const command = /cursor/i.test(vscode.env.appName)
      ? "chatdev.openCursorAgentItem"
      : "chatdev.openAgentTerminalItem";
    await vscode.commands.executeCommand(command, agent);
    return;
  }
  await openRemoteFolder(agent);
}

export async function moveCurrentAgentSession(api: ChatDevApi): Promise<void> {
  await continueCurrentProjectInEditor(api);
}

export function currentAgentId(): string | undefined {
  const uri = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === "chatdev")?.uri;
  if (!uri) return currentMirroredAgentId();
  return new URLSearchParams(uri.query).get("agentId") || uri.authority.split("+")[0] || undefined;
}

function validateContinueSettings(settings: ContinuePanelSettings, sessions: LocalAgentSession[], machineTiers: ContinuePanelMachineTier[]): void {
  if (!sessions.some((session) => session.sessionId === settings.mainSessionId)) {
    throw new Error("Choose a Main session from this project.");
  }
  if (!settings.name || settings.name.length > 100 || !/^[a-zA-Z0-9_.\/-]+$/.test(settings.name)) {
    throw new Error("Agent names can use letters, numbers, underscores, dashes, dots, and slashes.");
  }
  if (!["standard", "pro", "max", "gpu"].includes(settings.machineSize)) {
    throw new Error("Choose a valid machine type.");
  }
  const selectedTier = machineTiers.find((tier) => tier.id === settings.machineSize);
  if (!selectedTier) throw new Error("The selected machine is no longer available.");
  if (settings.volumeGb !== undefined && (!Number.isInteger(settings.volumeGb) || settings.volumeGb < selectedTier.volumeGb || settings.volumeGb > 100)) {
    throw new Error(`Workspace disk size for ${selectedTier.label} must be between ${selectedTier.volumeGb} and 100 GB.`);
  }
  if (!["global", "agent", "none"].includes(settings.credentialScope)) {
    throw new Error("Choose where the local provider login should be available.");
  }
  if (settings.model && settings.model.length > 200) throw new Error("The model name is too long.");
  if (settings.maxBudgetUsd !== undefined && (!Number.isFinite(settings.maxBudgetUsd) || settings.maxBudgetUsd < 0 || settings.maxBudgetUsd > 1000)) {
    throw new Error("Budget limit must be between 0 and 1000 USD.");
  }
  if (settings.systemPrompt && settings.systemPrompt.length > 10_000) throw new Error("Starting instructions are too long.");
}

async function prepareRemoteContinuation(
  api: ChatDevApi,
  folder: vscode.WorkspaceFolder,
  sessions: LocalAgentSession[],
  credentialsByProvider: Map<LocalAgentSession["provider"], LocalProviderCredentials>,
  settings: ContinuePanelSettings,
  report: (message: string) => void | Promise<void>,
  existingAgent?: Agent,
  agentReady?: (agent: Agent) => void | Promise<void>,
): Promise<Agent> {
  const mainSession = sessions.find((session) => session.sessionId === settings.mainSessionId)!;
  const credentialScope = hasAnyCredentials(credentialsByProvider) ? settings.credentialScope : "none";
  const desiredRuntime = remoteRuntimeForSession(
    mainSession,
    credentialScope === "none" ? undefined : credentialsByProvider.get(mainSession.provider),
  );
  const desiredModel = settings.model || mainSession.model;
  const desiredAgent = {
    name: settings.name,
    agentRuntime: desiredRuntime,
    machineSize: settings.machineSize,
    ...(settings.volumeGb ? { volumeGb: settings.volumeGb } : {}),
    ...(desiredModel ? { model: desiredModel } : {}),
    ...(settings.maxBudgetUsd !== undefined ? { maxBudgetUsd: settings.maxBudgetUsd } : {}),
    ...(settings.systemPrompt ? { systemPrompt: settings.systemPrompt } : {}),
  };

  let agent = existingAgent;
  if (agent) {
    try {
      agent = await api.getAgent(agent.id);
      if (agent.status === "deleted") agent = undefined;
    } catch (error) {
      if (!isAgentNotFoundError(error)) throw error;
      agent = undefined;
    }
  }
  if (!agent) {
    await report("Creating the chat.dev agent");
    agent = await api.createAgent({
      ...desiredAgent,
      autoStart: false,
    });
  } else {
    await report(`Updating ${agent.name} with these settings`);
    const machineChanged = agent.machineSize !== settings.machineSize
      || (agent.volumeGb != null && settings.volumeGb != null && agent.volumeGb !== settings.volumeGb);
    const updated = await api.updateAgent(agent.id, {
      ...desiredAgent,
      maxBudgetUsd: settings.maxBudgetUsd ?? null,
      systemPrompt: settings.systemPrompt || null,
    });
    if ((updated.needsRestart || machineChanged) && ["running", "starting"].includes(agent.status)) {
      await report("Restarting the incomplete agent with the new settings");
      await api.stopAgent(agent.id);
    }
    agent = await api.getAgent(agent.id);
  }
  await agentReady?.(agent);

  await report("Preparing provider logins before startup");
  await installCredentials(api, agent, credentialsByProvider, credentialScope);
  const remoteSessions = await createRemoteSessions(api, agent, sessions, mainSession, credentialsByProvider, credentialScope, settings.model);
  await importSessionHistories(api, agent, remoteSessions, report);
  await report("Starting the agent");
  await ensureRunning(api, agent);
  agent = await api.getAgent(agent.id);

  await attachCodingSessions(api, agent, remoteSessions, report);
  await startWorkspaceMirror(api, agent.id, folder.uri);
  await startWorkspaceSessionDiscovery(api, agent.id, folder.uri);

  const excludes = excludedDirectoryNames();
  const entries = await collectEntries(folder.uri, excludes);
  const progress: vscode.Progress<{ message?: string; increment?: number }> = {
    report: (value) => { if (value.message) report(value.message); },
  };
  await report(`Packaging ${entries.length} project items`);
  await uploadWorkspace(api, agent.id, folder.uri, entries, excludes, progress, report);
  await api.writeWorkspaceFile(agent.id, ".chatdev/editor-state.json", Buffer.from(JSON.stringify(captureEditorState(folder.uri), null, 2)));
  return agent;
}

type RemoteSession = { local: LocalAgentSession; remote: AgentThread };

async function findCredentialsForSessions(
  sessions: LocalAgentSession[],
): Promise<Map<LocalAgentSession["provider"], LocalProviderCredentials>> {
  const providers = [...new Set(sessions.map((session) => session.provider))];
  return new Map(await Promise.all(providers.map(async (provider) => [provider, await findLocalProviderCredentials(provider)] as const)));
}

function hasAnyCredentials(credentialsByProvider: Map<LocalAgentSession["provider"], LocalProviderCredentials>): boolean {
  return [...credentialsByProvider.values()].some((credentials) => Object.keys(credentials.values).length > 0);
}

async function saveGlobalCredentials(
  api: ChatDevApi,
  credentialsByProvider: Map<LocalAgentSession["provider"], LocalProviderCredentials>,
): Promise<void> {
  for (const credentials of credentialsByProvider.values()) {
    if (Object.keys(credentials.values).length) {
      await api.saveGlobalProviderCredentials(credentials.provider, credentials.values);
    }
  }
}

async function installCredentials(
  api: ChatDevApi,
  agent: Agent,
  credentialsByProvider: Map<LocalAgentSession["provider"], LocalProviderCredentials>,
  scope: "global" | "agent" | "none",
): Promise<void> {
  if (scope === "none") return;
  if (scope === "global") await saveGlobalCredentials(api, credentialsByProvider);
  for (const credentials of credentialsByProvider.values()) {
    if (!Object.keys(credentials.values).length) continue;
    if (agent.status === "running" || agent.status === "starting") {
      await api.importAgentCredentials(agent.id, credentials.provider, credentials.values);
    } else {
      await api.storeAgentCredentials(agent.id, credentials.provider, credentials.values);
    }
  }
}

async function createRemoteSessions(
  api: ChatDevApi,
  agent: Agent,
  sessions: LocalAgentSession[],
  mainSession: LocalAgentSession,
  credentialsByProvider: Map<LocalAgentSession["provider"], LocalProviderCredentials>,
  credentialScope: "global" | "agent" | "none",
  mainModelOverride?: string,
  mainRuntimeOverride?: string,
): Promise<RemoteSession[]> {
  const runtimeFor = (session: LocalAgentSession) => remoteRuntimeForSession(
    session,
    credentialScope === "none" ? undefined : credentialsByProvider.get(session.provider),
  );
  const main = await api.updateAgentThread(agent.id, agent.id, {
    name: mainSession.title,
    runtime: mainRuntimeOverride || runtimeFor(mainSession),
    model: mainModelOverride || mainSession.model || null,
    sourceProvider: mainSession.provider,
    sourceSessionId: mainSession.sessionId,
  });
  const existing = await api.listAgentThreads(agent);
  const linked: RemoteSession[] = [{ local: mainSession, remote: main }];
  for (const local of sessions) {
    if (local.sessionId === mainSession.sessionId && local.provider === mainSession.provider) continue;
    const matched = existing.find((remote) => (
      !remote.isPrimary
      && remote.sourceProvider === local.provider
      && remote.sourceSessionId === local.sessionId
    ));
    const remote = matched
      ? await api.updateAgentThread(agent.id, matched.id, {
        name: local.title,
        runtime: runtimeFor(local),
        model: local.model || null,
        sourceProvider: local.provider,
        sourceSessionId: local.sessionId,
      })
      : await api.createAgentThread(agent.id, {
        name: local.title,
        runtime: runtimeFor(local),
        ...(local.model ? { model: local.model } : {}),
        sourceProvider: local.provider,
        sourceSessionId: local.sessionId,
        start: false,
      });
    linked.push({ local, remote });
  }
  return linked;
}

async function importSessionHistories(
  api: ChatDevApi,
  agent: Agent,
  sessions: RemoteSession[],
  report: (message: string) => void | Promise<void>,
): Promise<void> {
  for (const [index, { local, remote }] of sessions.entries()) {
    await report(`Importing conversation ${index + 1} of ${sessions.length}: ${local.title}`);
    const messages = await readSessionMessages(local);
    if (messages.length) {
      await api.importChatMessages({
        agentId: agent.id,
        threadId: remote.id,
        provider: local.provider,
        sessionId: local.sessionId,
        messages,
      });
    }
  }
}

async function attachCodingSessions(
  api: ChatDevApi,
  agent: Agent,
  sessions: RemoteSession[],
  report: (message: string) => void | Promise<void>,
): Promise<void> {
  for (const [index, { local, remote }] of sessions.entries()) {
    await report(`Connecting session ${index + 1} of ${sessions.length}: ${local.title}`);
    await api.importCodingSession({
      agentId: agent.id,
      threadId: remote.id,
      runtime: remote.runtime,
      provider: local.provider,
      sessionId: local.sessionId,
      localCwd: local.cwd,
      data: await readSession(local),
      referenceOnly: local.provider === "cursor",
    });
    await startSessionTranscriptSync(api, agent.id, remote.id, local);
  }
}

async function reportBrowserProgress(
  api: ChatDevApi,
  token: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  message: string,
): Promise<void> {
  progress.report({ message });
  await api.updateEditorHandoff(token, { status: "uploading", progressMessage: message });
}

async function openAgentPage(api: ChatDevApi, agent: Agent): Promise<void> {
  const browserUrl = await api.getAgentOpenUrl(agent.id);
  const opened = await vscode.env.openExternal(vscode.Uri.parse(browserUrl));
  if (!opened) await vscode.env.clipboard.writeText(browserUrl);
}

export async function ensureRunning(api: ChatDevApi, agent: Agent): Promise<void> {
  if (agent.status === "running") return;
  if (agent.status !== "starting") await api.startAgent(agent.id);
  await waitUntilRunning(api, agent.id);
}

async function waitUntilRunning(api: ChatDevApi, agentId: string): Promise<void> {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Starting chat.dev agent", cancellable: false }, async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const agent = await api.getAgent(agentId);
      if (agent.status === "running") return;
      if (agent.status === "errored") throw new Error(agent.statusSummary || "The chat.dev agent failed to start.");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("The chat.dev agent did not become ready within three minutes.");
  });
}

async function openRemoteFolder(agent: Agent): Promise<void> {
  const root = workspaceDisplayName(agent.name || agent.id);
  const uri = vscode.Uri.from({ scheme: "chatdev", authority: root, path: `/${root}`, query: new URLSearchParams({ agentId: agent.id, root }).toString() });
  await vscode.commands.executeCommand("vscode.openFolder", uri, false);
}

type EditorState = {
  tabs: Array<{ path: string; active: boolean; line?: number; character?: number }>;
};

function captureEditorState(folder: vscode.Uri): EditorState {
  const selections = new Map(vscode.window.visibleTextEditors.map((editor) => [
    editor.document.uri.toString(),
    editor.selection.active,
  ]));
  const tabs: EditorState["tabs"] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.scheme !== "file") continue;
      const relativePath = path.relative(folder.fsPath, tab.input.uri.fsPath);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      const selection = selections.get(tab.input.uri.toString());
      tabs.push({
        path: relativePath.split(path.sep).join(path.posix.sep),
        active: tab.isActive,
        ...(selection ? { line: selection.line, character: selection.character } : {}),
      });
      if (tabs.length >= 50) return { tabs };
    }
  }
  return { tabs };
}

type UploadEntry = { uri: vscode.Uri; relativePath: string; type: vscode.FileType; size: number };

async function uploadWorkspace(
  api: ChatDevApi,
  agentId: string,
  folder: vscode.Uri,
  entries: UploadEntry[],
  excludes: Set<string>,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  report?: (message: string) => void | Promise<void>,
): Promise<void> {
  const itemCount = entries.length;
  let archive: Awaited<ReturnType<typeof createWorkspaceArchive>> | undefined;
  let archiveError: unknown;
  try {
    archive = await createWorkspaceArchive(folder, excludes, entries.map((entry) => entry.relativePath));
    const message = `Uploading ${itemCount} project items in one verified transfer`;
    progress.report({ message, increment: 75 });
    await report?.(message);
    const result = await api.uploadWorkspaceArchive(agentId, archive.path, itemCount);
    if (result.itemCount !== itemCount) {
      throw new Error(`The agent extracted ${result.itemCount} of ${itemCount} project items.`);
    }
    progress.report({ message: `Verified ${result.itemCount} project items`, increment: 10 });
    await report?.(`Verified ${result.itemCount} uploaded project items`);
    return;
  } catch (error) {
    archiveError = error;
  } finally {
    await archive?.dispose();
  }

  const files = entries.filter((entry) => entry.type & vscode.FileType.File);
  if (!files.length) throw archiveError;
  const reason = archiveError instanceof Error ? archiveError.message : String(archiveError);
  await report?.(`The archive transfer stopped (${reason}). Uploading ${files.length} files individually`);
  const failures: string[] = [];
  for (const [index, entry] of files.entries()) {
    if (index === 0 || (index + 1) % 25 === 0 || index + 1 === files.length) {
      const message = `Uploading file ${index + 1} of ${files.length}: ${entry.relativePath}`;
      progress.report({ message, increment: 80 / files.length });
      await report?.(message);
    }
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await api.uploadLocalFile(agentId, entry.relativePath, entry.uri.fsPath);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await delay(attempt * 500);
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      failures.push(`${entry.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    throw new Error(`Uploaded ${files.length - failures.length} of ${files.length} project files. ${failures.slice(0, 5).join("; ")}`);
  }
  await report?.(`Verified all ${files.length} project files`);
}

async function collectEntries(root: vscode.Uri, excludes: Set<string>): Promise<UploadEntry[]> {
  const entries: UploadEntry[] = [];
  async function visit(directory: vscode.Uri, relativeDirectory: string): Promise<void> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
      if (excludes.has(name)) continue;
      const uri = vscode.Uri.joinPath(directory, name);
      const relativePath = path.posix.join(relativeDirectory, name);
      if (type & vscode.FileType.SymbolicLink) {
        if (!(await isPortableWorkspaceSymlink(uri))) continue;
        entries.push({ uri, relativePath, type: vscode.FileType.SymbolicLink, size: 0 });
      } else if (type & vscode.FileType.Directory) {
        entries.push({ uri, relativePath, type: vscode.FileType.Directory, size: 0 });
        await visit(uri, relativePath);
      } else if (type & vscode.FileType.File) {
        entries.push({ uri, relativePath, type: vscode.FileType.File, size: (await vscode.workspace.fs.stat(uri)).size });
      }
    }
  }
  await visit(root, "");
  return entries;
}

function excludedDirectoryNames(): Set<string> {
  return new Set(vscode.workspace.getConfiguration("chatdev").get<string[]>("uploadExcludes", []));
}

function workspaceDisplayName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "chatdev-agent";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remoteRuntimeForSession(session: LocalAgentSession, credentials?: LocalProviderCredentials): LocalAgentSession["runtime"] {
  if (session.provider !== "cursor") return session.runtime;
  return credentials && (credentials.values.CURSOR_AUTH_JSON || credentials.values.CURSOR_API_KEY)
    ? "cursor-agent-tmux"
    : "codex-tmux";
}

function remoteDestinationLabel(session: LocalAgentSession, credentials: LocalProviderCredentials): string {
  const runtime = remoteRuntimeForSession(session, credentials);
  if (runtime === "cursor-agent-tmux") return "continues with Cursor Agent";
  if (runtime === "claude-code-tmux") return "continues with Claude Code";
  if (session.provider === "cursor") return "continues with Codex using chat.dev";
  return "continues with Codex";
}

async function loadMachineTiers(api: ChatDevApi): Promise<ContinuePanelMachineTier[]> {
  const fallback: ContinuePanelMachineTier[] = [
    { id: "standard", label: "Standard", cpuKind: "shared", cpus: 2, memoryMb: 1024, volumeGb: 1, monthlyUsd: 7 },
    { id: "pro", label: "Pro", cpuKind: "shared", cpus: 4, memoryMb: 4096, volumeGb: 10, monthlyUsd: 39 },
    { id: "max", label: "Max", cpuKind: "performance", cpus: 4, memoryMb: 8192, volumeGb: 50, monthlyUsd: 130 },
    { id: "gpu", label: "GPU", cpuKind: "performance", cpus: 8, memoryMb: 32768, volumeGb: 100, monthlyUsd: 3432, gpuKind: "a100-sxm4-80gb" },
  ];
  const supported = new Set(fallback.map((tier) => tier.id));
  try {
    const tiers = (await api.listEditorMachineTiers()).filter((tier): tier is EditorMachineTier => supported.has(tier.id));
    return tiers.length === fallback.length ? tiers : fallback;
  } catch {
    return fallback;
  }
}

async function loadPendingContinuation(
  api: ChatDevApi,
  workspacePath: string,
  sessions: LocalAgentSession[],
): Promise<{ agent: Agent; settings: ContinuePanelSettings } | undefined> {
  const stored = api.globalState.get<PendingContinuation[]>(PENDING_CONTINUATIONS_KEY, []);
  const pending = stored.find((item) => item.serverUrl === api.serverUrl && item.workspacePath === workspacePath);
  if (!pending) return undefined;
  if (!sessions.some((session) => session.sessionId === pending.settings.mainSessionId)) {
    await clearPendingContinuation(api, workspacePath, pending.agentId);
    return undefined;
  }
  try {
    const agent = await api.getAgent(pending.agentId);
    if (agent.status !== "deleted") return { agent, settings: pending.settings };
    await clearPendingContinuation(api, workspacePath, pending.agentId);
    return undefined;
  } catch (error) {
    if (!isAgentNotFoundError(error)) throw error;
    await clearPendingContinuation(api, workspacePath, pending.agentId);
    return undefined;
  }
}

async function nextAvailableAgentName(api: ChatDevApi, requested: string): Promise<string> {
  return replacementAgentName(requested, await api.listAgents());
}

async function rememberPendingContinuation(
  api: ChatDevApi,
  workspacePath: string,
  agentId: string,
  settings: ContinuePanelSettings,
): Promise<void> {
  const stored = api.globalState.get<PendingContinuation[]>(PENDING_CONTINUATIONS_KEY, []);
  const next = [
    { serverUrl: api.serverUrl, workspacePath, agentId, settings },
    ...stored.filter((item) => !(item.serverUrl === api.serverUrl && item.workspacePath === workspacePath)),
  ].slice(0, 10);
  await api.globalState.update(PENDING_CONTINUATIONS_KEY, next);
}

async function clearPendingContinuation(api: ChatDevApi, workspacePath: string, agentId: string): Promise<void> {
  const stored = api.globalState.get<PendingContinuation[]>(PENDING_CONTINUATIONS_KEY, []);
  await api.globalState.update(PENDING_CONTINUATIONS_KEY, stored.filter((item) => !(
    item.serverUrl === api.serverUrl && item.workspacePath === workspacePath && item.agentId === agentId
  )));
}
