import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ChatDevApi, type ChatMessage, type ImportedChatMessage } from "./api";
import {
  findLocalAgentSessions,
  readSession,
  readSessionMessages,
  renderCursorSessionTranscript,
  type LocalAgentSession,
} from "./local-sessions";
import {
  cursorMessagesNeedingReconciliation,
  reconcileCursorTranscriptMessages,
} from "./cursor-sync-identity";

const active = new Map<string, ReturnType<typeof setInterval>>();
const initializing = new Set<string>();
const activeWorkspaceDiscoveries = new Map<string, { agentId: string; timer: ReturnType<typeof setInterval> }>();
const STORAGE_KEY = "chatdev.cursorTranscriptSyncs";
const WORKSPACE_STORAGE_KEY = "chatdev.workspaceSessionDiscoveries";

type StoredTranscriptSync = {
  serverUrl: string;
  agentId: string;
  threadId: string;
  session: Omit<LocalAgentSession, "messages">;
};

type StoredWorkspaceDiscovery = {
  serverUrl: string;
  agentId: string;
  workspacePath: string;
};

export async function startSessionTranscriptSync(api: ChatDevApi, agentId: string, threadId: string, session: LocalAgentSession): Promise<void> {
  const key = `${api.serverUrl}:${agentId}:${threadId}:${session.sessionId}`;
  if (active.has(key) || initializing.has(key)) return;
  initializing.add(key);
  try {
    if (session.provider === "cursor" && /cursor/i.test(vscode.env.appName)) {
      const existingMessages = session.messages?.length
        ? session.messages
        : await readSessionMessages({ ...session, messages: undefined });
      await vscode.commands.executeCommand("chatdev.internal.bindCursorSession", {
        sessionId: session.sessionId,
        agentId,
        threadId,
        existingMessages: existingMessages.map(({ role, content }) => ({ role, content })),
      });
    }
    if (!session.filePath && !session.stateDbPath) return;
    await rememberTranscriptSync(api, agentId, threadId, session);
    let lastFingerprint = "";
    let running = false;
    const sync = async () => {
      if (running) return;
      running = true;
      try {
        const fingerprint = await sessionFingerprint(session);
        if (fingerprint === lastFingerprint) return;
        const observedMessages = await readSessionMessages({ ...session, messages: undefined });
        const messages = session.provider === "cursor"
          ? reconcileCursorTranscriptMessages(session.sessionId, observedMessages)
          : observedMessages;
        if (messages.length) {
          if (session.provider === "cursor") {
            await api.writeWorkspaceFile(agentId, `.chatdev/sessions/${threadId}/imported-cursor-conversation.md`, renderCursorSessionTranscript(session, messages));
          }
          const remote = await api.getAgentThreadHistory(agentId, threadId, Math.min(5_000, messages.length + 1_000));
          const missing = session.provider === "cursor"
            ? cursorMessagesNeedingReconciliation(session.sessionId, messages, remote)
            : localMessagesMissingRemotely(messages, remote);
          if (missing.length) {
            await api.importChatMessages({ agentId, threadId, provider: session.provider, sessionId: session.sessionId, messages: missing });
          }
        }
        lastFingerprint = fingerprint;
      } catch {
        // Cursor may replace the transcript atomically while writing. The next pass retries it.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => { void sync(); }, 1_000);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    active.set(key, timer);
    await sync();
  } finally {
    initializing.delete(key);
  }
}

function localMessagesMissingRemotely(local: ImportedChatMessage[], remote: ChatMessage[]): ImportedChatMessage[] {
  const remoteCounts = new Map<string, number>();
  for (const message of remote) {
    const key = comparableMessageKey(message.role, message.content);
    if (key) remoteCounts.set(key, (remoteCounts.get(key) || 0) + 1);
  }
  return local.filter((message) => {
    const key = comparableMessageKey(message.role, message.content);
    if (!key) return false;
    const remaining = remoteCounts.get(key) || 0;
    if (!remaining) return true;
    remoteCounts.set(key, remaining - 1);
    return false;
  });
}

function comparableMessageKey(role: string | undefined, content: string | undefined): string | undefined {
  const normalizedRole = role === "user" ? "user" : role === "agent" || role === "assistant" ? "assistant" : "";
  const normalizedContent = String(content || "").trim();
  return normalizedRole && normalizedContent ? `${normalizedRole}\u0000${normalizedContent}` : undefined;
}

async function sessionFingerprint(session: LocalAgentSession): Promise<string> {
  const paths = [
    session.filePath,
    session.stateDbPath,
    session.stateDbPath ? `${session.stateDbPath}-wal` : undefined,
    session.stateDbPath ? `${session.stateDbPath}-shm` : undefined,
  ].filter((item): item is string => !!item);
  const parts = await Promise.all(paths.map(async (filePath) => {
    try {
      const metadata = await fs.stat(filePath);
      return `${filePath}:${metadata.size}:${metadata.mtimeMs}`;
    } catch {
      return `${filePath}:missing`;
    }
  }));
  return parts.join("|");
}

export function restoreSessionTranscriptSync(api: ChatDevApi, agentId: string): void {
  const stored = api.globalState.get<StoredTranscriptSync[]>(STORAGE_KEY, []);
  for (const item of stored) {
    if (item.serverUrl === api.serverUrl && item.agentId === agentId) {
      void startSessionTranscriptSync(api, item.agentId, item.threadId || item.agentId, item.session);
    }
  }
}

export async function startWorkspaceSessionDiscovery(api: ChatDevApi, agentId: string, workspace: vscode.Uri): Promise<void> {
  if (workspace.scheme !== "file") return;
  const workspacePath = path.resolve(workspace.fsPath);
  const key = `${api.serverUrl}:${workspacePath}`;
  const existing = activeWorkspaceDiscoveries.get(key);
  if (existing?.agentId === agentId) return;
  if (existing) clearInterval(existing.timer);
  try {
    const agent = await api.getAgent(agentId);
    if (agent.status === "deleted") throw notFoundError();
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await forgetWorkspaceDiscovery(api, agentId, workspacePath);
    return;
  }
  await rememberWorkspaceDiscovery(api, agentId, workspacePath);

  let running = false;
  const sync = async () => {
    if (running) return;
    running = true;
    try {
      const agent = await api.getAgent(agentId);
      const localSessions = await findLocalAgentSessions(workspace);
      const remoteSessions = await api.listAgentThreads(agent);
      for (const local of localSessions) {
        const desiredRuntime = local.provider === "cursor" && agent.agentRuntime !== "cursor-agent-tmux"
          ? (agent.agentRuntime || "codex-tmux")
          : local.runtime;
        let remote = remoteSessions.find((candidate) => (
          candidate.sourceProvider === local.provider
          && candidate.sourceSessionId === local.sessionId
        ));
        if (!remote) {
          remote = await api.createAgentThread(agentId, {
            name: local.title,
            runtime: desiredRuntime,
            ...(local.model ? { model: local.model } : {}),
            sourceProvider: local.provider,
            sourceSessionId: local.sessionId,
            start: false,
          });
          remoteSessions.push(remote);
          await api.importCodingSession({
            agentId,
            threadId: remote.id,
            runtime: remote.runtime,
            provider: local.provider,
            sessionId: local.sessionId,
            localCwd: local.cwd,
            data: await readSession(local),
            referenceOnly: local.provider === "cursor",
          });
          const messages = await readSessionMessages(local);
          if (messages.length) {
            await api.importChatMessages({
              agentId,
              threadId: remote.id,
              provider: local.provider,
              sessionId: local.sessionId,
              messages,
            });
          }
        } else {
          const nextModel = local.model || null;
          if (remote.name !== local.title || remote.runtime !== desiredRuntime || (remote.model || null) !== nextModel) {
            remote = await api.updateAgentThread(agentId, remote.id, {
              name: local.title,
              runtime: desiredRuntime,
              model: nextModel,
              sourceProvider: local.provider,
              sourceSessionId: local.sessionId,
            });
          }
        }
        await startSessionTranscriptSync(api, agentId, remote.id, local);
      }
    } catch {
      // Cursor rotates its database while saving and the remote machine may be
      // starting. The next scan retries the complete discovery pass.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void sync(); }, 1_500);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  activeWorkspaceDiscoveries.set(key, { agentId, timer });
  await sync();
}

export async function restoreWorkspaceSessionDiscoveries(api: ChatDevApi): Promise<void> {
  if (!(await api.isSignedIn())) return;
  const folders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "file");
  const openPaths = new Map(folders.map((folder) => [path.resolve(folder.uri.fsPath), folder.uri]));
  for (const [key, discovery] of activeWorkspaceDiscoveries) {
    const workspacePath = key.slice(api.serverUrl.length + 1);
    if (!key.startsWith(`${api.serverUrl}:`) || !openPaths.has(workspacePath)) {
      clearInterval(discovery.timer);
      activeWorkspaceDiscoveries.delete(key);
    }
  }
  const stored = api.globalState.get<StoredWorkspaceDiscovery[]>(WORKSPACE_STORAGE_KEY, []);
  for (const item of stored) {
    if (item.serverUrl !== api.serverUrl) continue;
    const uri = openPaths.get(path.resolve(item.workspacePath));
    if (uri) await startWorkspaceSessionDiscovery(api, item.agentId, uri);
  }
}

export function disposeSessionTranscriptSyncs(): void {
  for (const timer of active.values()) clearInterval(timer);
  active.clear();
  initializing.clear();
  for (const discovery of activeWorkspaceDiscoveries.values()) clearInterval(discovery.timer);
  activeWorkspaceDiscoveries.clear();
}

export async function forgetAgentSessionSyncs(api: ChatDevApi, agentId: string): Promise<void> {
  const prefix = `${api.serverUrl}:${agentId}:`;
  for (const [key, timer] of active) {
    if (!key.startsWith(prefix)) continue;
    clearInterval(timer);
    active.delete(key);
  }
  for (const key of initializing) {
    if (key.startsWith(prefix)) initializing.delete(key);
  }
  const stored = api.globalState.get<StoredTranscriptSync[]>(STORAGE_KEY, []);
  await api.globalState.update(STORAGE_KEY, stored.filter((item) => !(
    item.serverUrl === api.serverUrl && item.agentId === agentId
  )));
}

async function rememberTranscriptSync(api: ChatDevApi, agentId: string, threadId: string, session: LocalAgentSession): Promise<void> {
  const { messages: _messages, ...storedSession } = session;
  const stored = api.globalState.get<StoredTranscriptSync[]>(STORAGE_KEY, []);
  const next = [
    { serverUrl: api.serverUrl, agentId, threadId, session: storedSession },
    ...stored.filter((item) => !(item.serverUrl === api.serverUrl && item.agentId === agentId && item.threadId === threadId && item.session.sessionId === session.sessionId)),
  ].slice(0, 50);
  await api.globalState.update(STORAGE_KEY, next);
}

async function rememberWorkspaceDiscovery(api: ChatDevApi, agentId: string, workspacePath: string): Promise<void> {
  const stored = api.globalState.get<StoredWorkspaceDiscovery[]>(WORKSPACE_STORAGE_KEY, []);
  const next = [
    { serverUrl: api.serverUrl, agentId, workspacePath },
    ...stored.filter((item) => !(item.serverUrl === api.serverUrl && path.resolve(item.workspacePath) === workspacePath)),
  ].slice(0, 50);
  await api.globalState.update(WORKSPACE_STORAGE_KEY, next);
}

async function forgetWorkspaceDiscovery(api: ChatDevApi, agentId: string, workspacePath: string): Promise<void> {
  const key = `${api.serverUrl}:${path.resolve(workspacePath)}`;
  const activeDiscovery = activeWorkspaceDiscoveries.get(key);
  if (activeDiscovery?.agentId === agentId) {
    clearInterval(activeDiscovery.timer);
    activeWorkspaceDiscoveries.delete(key);
  }
  const stored = api.globalState.get<StoredWorkspaceDiscovery[]>(WORKSPACE_STORAGE_KEY, []);
  await api.globalState.update(WORKSPACE_STORAGE_KEY, stored.filter((item) => !(
    item.serverUrl === api.serverUrl
    && item.agentId === agentId
    && path.resolve(item.workspacePath) === path.resolve(workspacePath)
  )));
  await forgetAgentSessionSyncs(api, agentId);
}

function isNotFoundError(error: unknown): boolean {
  return (error as Error & { status?: number })?.status === 404;
}

function notFoundError(): Error {
  const error = new Error("Agent not found") as Error & { status?: number };
  error.status = 404;
  return error;
}
