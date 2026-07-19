import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { ChatDevApi, type AgentThread, type ChatMessage } from "./api";
import { continueCursorSessionInBrowser, currentAgentId } from "./commands";
import {
  APPEND_COMPOSER_MESSAGES_COMMAND,
  PRUNE_COMPOSER_MESSAGES_COMMAND,
  PRUNE_COMPOSER_MESSAGES_PATCH_MARKER,
  patchCursorWorkbenchSource,
} from "./cursor-workbench-patch";
import {
  cursorNativeRequestId,
  recordCursorNativeTurn,
  recordCursorRemoteBubbles,
} from "./cursor-sync-identity";
import { currentMirroredAgentId } from "./workspace-mirror";

const execFileAsync = promisify(execFile);
const BRIDGE_DIRECTORY = "chatdev-cursor-agent-bridge";
const BRIDGE_VERSION = "1.1.0";
const CURSOR_MODEL_NAME = "chat.dev";
let bridgeInstallation: Promise<void> | undefined;

type CursorAgentCreateOptions = {
  state?: Record<string, unknown>;
  notifyStateUpdate?: (state: Record<string, unknown>) => void;
};

type CursorAgentRunOptions = {
  userMessage?: unknown;
  requestId?: string;
  userBubbleId?: string;
  modelName?: string;
  requestedModel?: { modelId?: string };
  abortSignal?: AbortSignal;
};

type CursorProviderState = {
  chatdevAgentId?: string;
  chatdevThreadId?: string;
  cursorSessionId?: string;
};

type CursorSessionBinding = {
  agentId: string;
  threadId: string;
};

type SessionMessageRow = ChatMessage & {
  append?: boolean;
  streamId?: string | null;
  kind?: string | null;
};

export function registerCursorAgentPanel(context: vscode.ExtensionContext, api: ChatDevApi): vscode.Disposable[] {
  const cursorHost = /cursor/i.test(vscode.env.appName);
  void vscode.commands.executeCommand("setContext", "chatdev.cursorHost", cursorHost);
  if (!cursorHost) return [];

  const controller = new CursorAgentPanelController(context, api);
  const disposables = [
    controller,
    vscode.commands.registerCommand("chatdev.internal.cursorProviderEnabled", () => api.isSignedIn()),
    vscode.commands.registerCommand("chatdev.internal.createCursorAgentHandle", (input: { sessionId?: string; options?: CursorAgentCreateOptions }) => {
      const sessionId = String(input?.sessionId || "").trim();
      if (!sessionId) throw new Error("Cursor did not provide a conversation id.");
      return createCursorAgentHandle(api, controller, sessionId, input?.options || {});
    }),
    vscode.commands.registerCommand("chatdev.internal.cursorAgentCreated", (input: { sessionId?: string; state?: CursorProviderState }) => {
      const sessionId = String(input?.sessionId || "").trim();
      if (sessionId) void controller.handleCursorAgentCreated(sessionId, input?.state).catch((error) => {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }),
    vscode.commands.registerCommand("chatdev.internal.bindCursorSession", async (input: {
      sessionId?: string;
      agentId?: string;
      threadId?: string;
      existingMessages?: Array<{ role?: string; content?: string }>;
    }) => {
      const sessionId = String(input?.sessionId || "").trim();
      const agentId = String(input?.agentId || "").trim();
      const threadId = String(input?.threadId || "").trim();
      if (!sessionId || !agentId || !threadId) throw new Error("The Cursor session binding is incomplete.");
      await controller.bindCursorSession(sessionId, { agentId, threadId }, true, input.existingMessages || []);
    }),
    vscode.commands.registerCommand("chatdev.internal.cursorBridgeReady", async () => {
      if (!(await bridgeIsCurrent())) {
        await ensureCursorBridgeReady(context);
        return false;
      }
      await vscode.commands.executeCommand("setContext", "chatdev.cursorBridgeActive", true);
      if (!activeChatDevAgentId(api)) return false;
      await controller.openDefaultSession();
      return true;
    }),
    vscode.commands.registerCommand("chatdev.openCursorAgentSession", async () => {
      if (!(await ensureCursorBridgeReady(context))) return;
      return controller.pickAndOpenSession();
    }),
    vscode.commands.registerCommand("chatdev.openCursorAgentItem", async (input: { id?: string; agent?: { id?: string } }) => {
      const agentId = String(input?.agent?.id || input?.id || "").trim();
      if (!agentId) throw new Error("Choose a chat.dev agent first.");
      if (!(await ensureCursorBridgeReady(context))) return;
      return controller.openAgentSession(agentId);
    }),
    vscode.commands.registerCommand("chatdev.enableCursorAgentPanel", async () => {
      await ensureCursorBridgeReady(context);
    }),
  ];

  void refreshCursorBridge();
  return disposables;
}

export async function ensureCursorBridgeReady(context: vscode.ExtensionContext): Promise<boolean> {
  if (!/cursor/i.test(vscode.env.appName)) return true;
  if (await bridgeIsCurrent()) {
    await vscode.commands.executeCommand("setContext", "chatdev.cursorBridgeActive", true);
    await refreshCursorBridge();
    return true;
  }
  bridgeInstallation ||= installCursorBridge(context).finally(() => { bridgeInstallation = undefined; });
  await bridgeInstallation;
  return false;
}

async function refreshCursorBridge(): Promise<void> {
  try { await vscode.commands.executeCommand("chatdev.cursorBridge.refresh"); } catch {}
}

function activeChatDevAgentId(api: ChatDevApi): string | undefined {
  return currentAgentId() || currentMirroredAgentId(api.serverUrl);
}

type CursorComposerSync = {
  agentId: string;
  threadId: string;
  composerId: string;
  activeRuns: number;
  seenMaxId: number;
  timer: ReturnType<typeof setInterval>;
  refreshing: boolean;
};

class CursorAgentPanelController implements vscode.Disposable {
  private readonly syncs = new Map<string, CursorComposerSync>();
  private readonly bindings = new Map<string, CursorSessionBinding>();
  private readonly reconciledBindings = new Set<string>();
  private readonly pendingBindings = new Map<string, Promise<CursorSessionBinding>>();
  private pendingCreatedComposerBinding: CursorSessionBinding | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly api: ChatDevApi) {}

  async openDefaultSession(): Promise<void> {
    await this.openSession(false);
  }

  async pickAndOpenSession(): Promise<void> {
    await this.api.ensureSignedIn();
    let agentId = activeChatDevAgentId(this.api);
    if (!agentId) {
      const agents = (await this.api.listAgents())
        .filter((agent) => agent.status !== "deleted" && agent.agentRuntime !== "tool-agent")
        .sort((left, right) => left.name.localeCompare(right.name));
      agentId = await vscode.window.showQuickPick(agents.map((agent) => ({
        label: agent.name,
        description: `${agent.status} · ${agent.agentRuntime || "coding agent"}`,
        agentId: agent.id,
      })), {
        title: "Open a chat.dev agent in Cursor Agent",
        placeHolder: "Choose an agent",
      }).then((item) => item?.agentId);
    }
    if (agentId) await this.openSession(true, agentId);
  }

  async openAgentSession(agentId: string): Promise<void> {
    await this.api.ensureSignedIn();
    await this.openSession(true, agentId);
  }

  async ensureCursorSessionBinding(
    sessionId: string,
    state?: CursorProviderState,
    requestedModel?: string,
  ): Promise<CursorSessionBinding> {
    const stateAgentId = String(state?.chatdevAgentId || "").trim();
    if (stateAgentId) {
      const binding = { agentId: stateAgentId, threadId: String(state?.chatdevThreadId || stateAgentId) };
      await this.bindCursorSession(sessionId, binding);
      await this.applyCursorModel(binding, requestedModel);
      return binding;
    }
    const activeAgentId = activeChatDevAgentId(this.api);
    const memory = this.bindings.get(sessionId);
    if (memory) {
      if (activeAgentId && memory.agentId !== activeAgentId) {
        const rebound = await this.createSessionOnActiveAgent(activeAgentId, sessionId, requestedModel);
        await this.bindCursorSession(sessionId, rebound);
        return rebound;
      }
      await this.applyCursorModel(memory, requestedModel);
      return memory;
    }
    const bindingKey = cursorSessionBindingKey(this.api.serverUrl, sessionId);
    const stored = this.context.workspaceState.get<CursorSessionBinding>(bindingKey)
      || this.api.globalState.get<CursorSessionBinding>(bindingKey);
    if (stored?.agentId && stored?.threadId) {
      if (activeAgentId && stored.agentId !== activeAgentId) {
        const rebound = await this.createSessionOnActiveAgent(activeAgentId, sessionId, requestedModel);
        await this.bindCursorSession(sessionId, rebound);
        return rebound;
      }
      this.bindings.set(sessionId, stored);
      await this.applyCursorModel(stored, requestedModel);
      return stored;
    }
    const pending = this.pendingBindings.get(sessionId);
    if (pending) return pending;
    const created = (activeAgentId
      ? this.createSessionOnActiveAgent(activeAgentId, sessionId, requestedModel)
      : continueCursorSessionInBrowser(this.api, sessionId))
      .then(async (binding) => {
        await this.bindCursorSession(sessionId, binding);
        return binding;
      })
      .finally(() => this.pendingBindings.delete(sessionId));
    this.pendingBindings.set(sessionId, created);
    return created;
  }

  async handleCursorAgentCreated(sessionId: string, state?: CursorProviderState): Promise<void> {
    const agentId = String(state?.chatdevAgentId || "").trim();
    if (agentId) {
      await this.bindCursorSession(sessionId, {
        agentId,
        threadId: String(state?.chatdevThreadId || agentId),
      });
      return;
    }
    if (this.pendingCreatedComposerBinding) {
      await this.bindCursorSession(sessionId, this.pendingCreatedComposerBinding);
      return;
    }
    const activeAgentId = activeChatDevAgentId(this.api);
    if (activeAgentId) await this.ensureCursorSessionBinding(sessionId, state);
  }

  beginNativeRun(agentId: string, threadId: string): void {
    const sync = this.syncs.get(cursorSyncKey(agentId, threadId));
    if (sync) sync.activeRuns += 1;
  }

  async finishNativeRun(agentId: string, threadId: string): Promise<void> {
    const sync = this.syncs.get(cursorSyncKey(agentId, threadId));
    if (!sync) return;
    try {
      const rows = await this.api.getAgentThreadMessages(agentId, threadId);
      await this.advanceSeen(sync, maximumMessageId(rows));
    } catch {
      // The next idle refresh retries after transient disconnects.
    } finally {
      sync.activeRuns = Math.max(0, sync.activeRuns - 1);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const sync of this.syncs.values()) clearInterval(sync.timer);
    this.syncs.clear();
  }

  private async openSession(choose: boolean, requestedAgentId?: string): Promise<void> {
    const agentId = requestedAgentId || activeChatDevAgentId(this.api);
    if (!agentId) return;
    const agent = await this.api.getAgent(agentId);
    const threads = await this.api.listAgentThreads(agent);
    let thread: AgentThread | undefined = threads.find((candidate) => candidate.isDefault) || threads[0];
    if (choose && threads.length > 1) {
      thread = await vscode.window.showQuickPick(threads.map((candidate) => ({
        label: `${candidate.isDefault ? "$(home)" : "$(comment-discussion)"} ${candidate.name}`,
        description: `${candidate.runtime}${candidate.model ? ` · ${candidate.model}` : ""}`,
        detail: candidate.isDefault ? "Default session" : `${candidate.status} session`,
        thread: candidate,
      })), {
        title: `${agent.name} sessions`,
        placeHolder: "Choose the session to open in Cursor's Agent panel",
      }).then((item) => item?.thread);
    }
    if (!thread) return;

    const mappingKey = cursorComposerMappingKey(this.api.serverUrl, agentId, thread.id);
    let composerId = this.context.workspaceState.get<string>(mappingKey);
    if (composerId) {
      const existing = await Promise.resolve(vscode.commands.executeCommand("composer.getComposerHandleById", composerId)).catch(() => undefined);
      if (existing) {
        await vscode.commands.executeCommand(PRUNE_COMPOSER_MESSAGES_COMMAND, composerId);
        await this.bindCursorSession(composerId, { agentId, threadId: thread.id });
        await this.startSync(agentId, thread.id, composerId);
        await vscode.commands.executeCommand("composer.openComposer", composerId);
        return;
      }
      composerId = undefined;
    }

    const rows = await this.api.getAgentThreadHistory(agentId, thread.id);
    const history = cursorHistory(rows, agentId, thread.id);
    const before = await selectedCursorComposerIds();
    const title = thread.isDefault ? agent.name : `${agent.name} [${thread.name}]`;
    this.pendingCreatedComposerBinding = { agentId, threadId: thread.id };
    try {
      await vscode.commands.executeCommand("composer.createNew", {
        unifiedMode: "agent",
        openInNewTab: true,
        partialState: {
          name: title,
          subtitle: title,
          status: "none",
          unifiedMode: "agent",
          forceMode: "edit",
          isAgentic: true,
          isNAL: true,
          agentBackend: "claude-code",
          agentBackendData: {
            chatdevAgentId: agentId,
            chatdevThreadId: thread.id,
            cursorSessionId: thread.sourceSessionId || undefined,
          },
          applyAgentBackendTypeRestrictions: false,
          restrictAgentModeSwitching: true,
          modelConfig: { modelName: CURSOR_MODEL_NAME, maxMode: false },
          fullConversationHeadersOnly: history.headers,
          conversationMap: history.conversationMap,
        },
      });
      const after = await selectedCursorComposerIds();
      composerId = [...after].reverse().find((candidate) => !before.includes(candidate));
      if (!composerId) throw new Error("Cursor did not create the chat.dev Agent conversation.");
      recordCursorRemoteBubbles(composerId, history.bubbles);
      await this.context.workspaceState.update(mappingKey, composerId);
      await this.bindCursorSession(composerId, { agentId, threadId: thread.id });
    } finally {
      this.pendingCreatedComposerBinding = undefined;
    }
    await this.context.workspaceState.update(cursorSeenKey(agentId, thread.id), maximumMessageId(rows));
    await this.startSync(agentId, thread.id, composerId);
    await vscode.commands.executeCommand("composer.openComposer", composerId);
  }

  private async startSync(agentId: string, threadId: string, composerId: string): Promise<void> {
    const key = cursorSyncKey(agentId, threadId);
    const existing = this.syncs.get(key);
    if (existing) {
      existing.composerId = composerId;
      return;
    }
    let seenMaxId = this.context.workspaceState.get<number>(cursorSeenKey(agentId, threadId));
    if (seenMaxId === undefined) {
      const rows = await this.api.getAgentThreadMessages(agentId, threadId);
      seenMaxId = maximumMessageId(rows);
      await this.context.workspaceState.update(cursorSeenKey(agentId, threadId), seenMaxId);
    }
    const sync: CursorComposerSync = {
      agentId,
      threadId,
      composerId,
      activeRuns: 0,
      seenMaxId,
      refreshing: false,
      timer: setInterval(() => { void this.refreshSync(key); }, 1_000),
    };
    this.syncs.set(key, sync);
  }

  private async refreshSync(key: string): Promise<void> {
    const sync = this.syncs.get(key);
    if (!sync || this.disposed || sync.refreshing || sync.activeRuns > 0) return;
    sync.refreshing = true;
    try {
      const rows = await this.api.getAgentThreadMessages(sync.agentId, sync.threadId);
      const unseenRows = rows.filter((row) => Number(row.id || 0) > sync.seenMaxId);
      if (unseenRows.length === 0) return;
      const unseen = unseenRows.filter((row) => !isImportedFromCursorSession(row, sync.composerId));
      const history = cursorHistory(unseen, sync.agentId, sync.threadId);
      if (history.bubbles.length > 0) {
        recordCursorRemoteBubbles(sync.composerId, history.bubbles);
        const appended = await vscode.commands.executeCommand<boolean>(
          APPEND_COMPOSER_MESSAGES_COMMAND,
          sync.composerId,
          history.bubbles,
        );
        if (!appended) return;
      }
      await this.advanceSeen(sync, maximumMessageId(unseenRows));
    } catch {
      // Polling is intentionally quiet; connection and reload races recover on the next tick.
    } finally {
      sync.refreshing = false;
    }
  }

  private async advanceSeen(sync: CursorComposerSync, next: number): Promise<void> {
    if (next <= sync.seenMaxId) return;
    sync.seenMaxId = next;
    await this.context.workspaceState.update(cursorSeenKey(sync.agentId, sync.threadId), next);
  }

  async bindCursorSession(
    sessionId: string,
    binding: CursorSessionBinding,
    beginAtLatest = false,
    existingMessages: Array<{ role?: string; content?: string }> = [],
  ): Promise<void> {
    const previous = this.bindings.get(sessionId);
    const reconciliationKey = `${sessionId}:${binding.agentId}:${binding.threadId}`;
    const currentSync = this.syncs.get(cursorSyncKey(binding.agentId, binding.threadId));
    if (
      previous?.agentId === binding.agentId
      && previous.threadId === binding.threadId
      && currentSync?.composerId === sessionId
      && (!beginAtLatest || this.reconciledBindings.has(reconciliationKey))
    ) return;
    if (previous && (previous.agentId !== binding.agentId || previous.threadId !== binding.threadId)) {
      const previousKey = cursorSyncKey(previous.agentId, previous.threadId);
      const previousSync = this.syncs.get(previousKey);
      if (previousSync?.composerId === sessionId) {
        clearInterval(previousSync.timer);
        this.syncs.delete(previousKey);
      }
    }
    this.bindings.set(sessionId, binding);
    const key = cursorSessionBindingKey(this.api.serverUrl, sessionId);
    await Promise.all([
      this.context.workspaceState.update(key, binding),
      this.api.globalState.update(key, binding),
    ]);
    if (beginAtLatest) {
      const rows = await this.api.getAgentThreadMessages(binding.agentId, binding.threadId);
      const missing = remoteMessagesMissingLocally(rows, existingMessages);
      const history = cursorHistory(missing, binding.agentId, binding.threadId);
      if (history.bubbles.length) {
        recordCursorRemoteBubbles(sessionId, history.bubbles);
        const appended = await vscode.commands.executeCommand<boolean>(
          APPEND_COMPOSER_MESSAGES_COMMAND,
          sessionId,
          history.bubbles,
        );
        if (!appended) throw new Error("Cursor could not add the chat.dev messages to this conversation.");
      }
      const latest = maximumMessageId(rows);
      await this.context.workspaceState.update(cursorSeenKey(binding.agentId, binding.threadId), latest);
      const existing = this.syncs.get(cursorSyncKey(binding.agentId, binding.threadId));
      if (existing) {
        existing.composerId = sessionId;
        existing.seenMaxId = latest;
      }
      this.reconciledBindings.add(reconciliationKey);
    }
    await this.startSync(binding.agentId, binding.threadId, sessionId);
  }

  private async createSessionOnActiveAgent(
    agentId: string,
    cursorSessionId: string,
    requestedModel?: string,
  ): Promise<CursorSessionBinding> {
    const agent = await this.api.getAgent(agentId);
    let thread = (await this.api.listAgentThreads(agent)).find((candidate) => (
      candidate.sourceProvider === "cursor" && candidate.sourceSessionId === cursorSessionId
    ));
    if (!thread) {
      try {
        thread = await this.api.createAgentThread(agentId, {
          name: `Cursor ${cursorSessionId.slice(0, 8)}`,
          runtime: agent.agentRuntime === "cursor-agent-tmux" ? "cursor-agent-tmux" : (agent.agentRuntime || "codex-tmux"),
          ...(normalizedCursorModel(requestedModel) ? { model: normalizedCursorModel(requestedModel) } : {}),
          sourceProvider: "cursor",
          sourceSessionId: cursorSessionId,
          start: false,
        });
      } catch (error) {
        thread = (await this.api.listAgentThreads(await this.api.getAgent(agentId))).find((candidate) => (
          candidate.sourceProvider === "cursor" && candidate.sourceSessionId === cursorSessionId
        ));
        if (!thread) throw error;
      }
    }
    const binding = { agentId, threadId: thread.id };
    await this.applyCursorModel(binding, requestedModel, thread);
    return binding;
  }

  private async applyCursorModel(
    binding: CursorSessionBinding,
    requestedModel?: string,
    knownThread?: AgentThread,
  ): Promise<void> {
    const model = normalizedCursorModel(requestedModel);
    if (!model) return;
    const agent = await this.api.getAgent(binding.agentId);
    const thread = knownThread || (await this.api.listAgentThreads(agent)).find((candidate) => candidate.id === binding.threadId);
    if (!thread || thread.model === model) return;
    const updated = await this.api.updateAgentThread(binding.agentId, binding.threadId, { model });
    if (updated.status === "running" || updated.status === "starting") {
      await this.api.restartAgentThread(binding.agentId, binding.threadId);
    }
  }
}

function cursorSyncKey(agentId: string, threadId: string): string {
  return `${agentId}:${threadId}`;
}

function cursorComposerMappingKey(serverUrl: string, agentId: string, threadId: string): string {
  return `chatdev.cursorComposer:${serverUrl}:${agentId}:${threadId}`;
}

function cursorSessionBindingKey(serverUrl: string, sessionId: string): string {
  return `chatdev.cursorSessionBinding:${serverUrl}:${sessionId}`;
}

function cursorSeenKey(agentId: string, threadId: string): string {
  return `chatdev.cursorComposerSeen:${agentId}:${threadId}`;
}

function normalizedCursorModel(value: unknown): string | undefined {
  const model = String(value || "").trim();
  if (!model || model === CURSOR_MODEL_NAME || model.length > 200) return undefined;
  return model;
}

async function selectedCursorComposerIds(): Promise<string[]> {
  const result = await vscode.commands.executeCommand<unknown>("composer.getOrderedSelectedComposerIds");
  return Array.isArray(result) ? result.filter((value): value is string => typeof value === "string") : [];
}

function maximumMessageId(rows: ChatMessage[]): number {
  return rows.reduce((maximum, row) => Math.max(maximum, Number(row.id || 0)), 0);
}

function remoteMessagesMissingLocally(
  rows: ChatMessage[],
  local: Array<{ role?: string; content?: string }>,
): ChatMessage[] {
  const counts = new Map<string, number>();
  for (const message of local) {
    const key = comparableMessageKey(message.role, message.content);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rows.filter((row) => {
    if ((row.role === "agent" || row.role === "assistant") && !isVisibleCompletedMessage(row)) return false;
    const key = comparableMessageKey(row.role, row.content);
    if (!key) return false;
    const remaining = counts.get(key) || 0;
    if (!remaining) return true;
    counts.set(key, remaining - 1);
    return false;
  });
}

function comparableMessageKey(role: string | undefined, content: string | undefined): string | undefined {
  const normalizedRole = role === "user" ? "user" : role === "agent" || role === "assistant" ? "assistant" : "";
  const normalizedContent = String(content || "").trim();
  return normalizedRole && normalizedContent ? `${normalizedRole}\u0000${normalizedContent}` : undefined;
}

function cursorHistory(rows: ChatMessage[], agentId: string, threadId: string): {
  headers: Array<Record<string, unknown>>;
  conversationMap: Record<string, Record<string, unknown>>;
  bubbles: Array<Record<string, unknown>>;
} {
  const headers: Array<Record<string, unknown>> = [];
  const conversationMap: Record<string, Record<string, unknown>> = {};
  const bubbles: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const role = row.role === "user" ? "user" : row.role === "agent" || row.role === "assistant" ? "assistant" : null;
    const content = String(row.content || "").trim();
    if (!role || !content || (role === "assistant" && !isVisibleCompletedMessage(row))) return;
    const type = role === "user" ? 1 : 2;
    const bubbleId = stableUuid(`${agentId}:${threadId}:${row.id}:${role}`);
    const createdAt = validIsoDate(row.createdAt, index);
    const logicalKey = `${role}\0${createdAt}\0${content}`;
    if (seen.has(logicalKey)) return;
    seen.add(logicalKey);
    const bubble: Record<string, unknown> = {
      _v: 3,
      type,
      bubbleId,
      createdAt,
      requestId: validCursorRequestId(row.turnId) || validCursorRequestId(row.runtimeTurnId) || stableUuid(`request:${agentId}:${threadId}:${row.id}`),
      chatdevTurnId: row.turnId || undefined,
      chatdevSourceKey: row.sourceKey || undefined,
      text: content,
      unifiedMode: 2,
      ...(role === "user" ? { richText: cursorRichText(content), context: emptyCursorContext() } : { codeBlocks: [] }),
    };
    bubbles.push(bubble);
    conversationMap[bubbleId] = bubble;
    headers.push({
      bubbleId,
      type,
      createdAt,
      grouping: { isRenderable: true, hasText: true, isShortPlainText: content.length < 240, toolDisplayComputed: true },
    });
  });
  return { headers, conversationMap, bubbles };
}

function isVisibleCompletedMessage(row: ChatMessage): boolean {
  if (shouldHideCursorPanelMessage(row)) return false;
  const phase = String(row.phase || "").toLowerCase();
  const kind = String(row.kind || "").toLowerCase();
  return !row.append && (
    ["final_answer", "error", "submit_error", "uncertain_done"].includes(phase)
    || ["final_answer", "turn-completed", "turn-error", "turn-cancelled"].includes(kind)
    || (!phase && !kind)
  );
}

function isImportedFromCursorSession(row: ChatMessage, sessionId: string): boolean {
  return String(row.sourceKey || "").startsWith(`editor:cursor:${sessionId}:`);
}

function stableUuid(value: string): string {
  const hex = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function validIsoDate(value: string | null | undefined, offset: number): string {
  const date = value ? new Date(value) : new Date(Date.now() + offset);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(Date.now() + offset).toISOString();
}

function cursorRichText(text: string): string {
  return JSON.stringify({
    root: {
      children: [{
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
        direction: "ltr",
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1,
      }],
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });
}

function emptyCursorContext(): Record<string, unknown> {
  return {
    composers: [], selectedCommits: [], selectedPullRequests: [], selectedImages: [], selectedDocuments: [],
    selectedVideos: [], folderSelections: [], fileSelections: [], terminalFiles: [], selections: [],
    terminalSelections: [], selectedDocs: [], externalLinks: [], cursorRules: [], cursorCommands: [],
    gitPRDiffSelections: [], subagentSelections: [], browserSelections: [], extraContext: [],
    mentions: {
      composers: {}, selectedCommits: {}, selectedPullRequests: {}, gitDiff: [], gitDiffFromBranchToMain: [],
      selectedImages: {}, selectedDocuments: {}, selectedVideos: {}, folderSelections: {}, fileSelections: {},
      terminalFiles: {}, selections: {}, terminalSelections: {}, selectedDocs: {}, externalLinks: {},
      diffHistory: [], cursorRules: {}, cursorCommands: {}, uiElementSelections: [], consoleLogs: [],
      ideEditorsState: [], gitPRDiffSelections: {}, subagentSelections: {}, browserSelections: {},
    },
  };
}

function createCursorAgentHandle(api: ChatDevApi, controller: CursorAgentPanelController, cursorSessionId: string, options: CursorAgentCreateOptions) {
  const providerState = (options.state || {}) as CursorProviderState;
  return {
    run: (runOptions: CursorAgentRunOptions) => runCursorAgentTurn(api, controller, cursorSessionId, providerState, options, runOptions),
  };
}

async function* runCursorAgentTurn(
  api: ChatDevApi,
  controller: CursorAgentPanelController,
  cursorSessionId: string,
  providerState: CursorProviderState,
  createOptions: CursorAgentCreateOptions,
  runOptions: CursorAgentRunOptions,
): AsyncGenerator<CursorInteractionUpdate> {
  const message = cursorMessageText(runOptions.userMessage);
  if (!message) throw new Error("Cursor sent an empty message.");
  const requestedModel = normalizedCursorModel(runOptions.requestedModel?.modelId || runOptions.modelName);
  const requestId = cursorNativeRequestId(runOptions.requestId, runOptions.userBubbleId, crypto.randomUUID());
  recordCursorNativeTurn(cursorSessionId, runOptions.userBubbleId, requestId);
  const { agentId, thread } = await resolveCursorSession(api, controller, cursorSessionId, providerState, requestedModel);
  controller.beginNativeRun(agentId, thread.id);
  createOptions.notifyStateUpdate?.({
    chatdevAgentId: agentId,
    chatdevThreadId: thread.id,
    cursorSessionId,
  });

  const socket = await api.connectSocket();
  const queue = new InteractionUpdateQueue();
  const streamed = new Map<string, string>();
  const seenRows = new Map<number, string>();
  let ended = false;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let baselineId = 0;

  const finish = () => {
    if (ended) return;
    ended = true;
    queue.push(CursorInteractionUpdate.turnEnded());
    queue.end();
  };
  const scheduleFinish = () => {
    if (completionTimer || ended) return;
    completionTimer = setTimeout(finish, 80);
  };
  const consumeRow = (row: SessionMessageRow | undefined) => {
    if (!row || row.role === "user" || Number(row.id || 0) <= baselineId) return;
    const content = String(row.content || "");
    const rowFingerprint = `${content}:${row.phase || ""}:${row.kind || ""}`;
    if (row.id && seenRows.get(Number(row.id)) === rowFingerprint) return;
    if (row.id) seenRows.set(Number(row.id), rowFingerprint);
    if (content && !shouldHideCursorPanelMessage(row)) {
      const streamKey = String(row.streamId || row.id || crypto.randomUUID());
      const previous = streamed.get(streamKey) || "";
      const delta = content.startsWith(previous) ? content.slice(previous.length) : content;
      streamed.set(streamKey, content);
      for (let offset = 0; offset < delta.length; offset += 8_000) {
        queue.push(CursorInteractionUpdate.text(delta.slice(offset, offset + 8_000)));
      }
    }
    if (isCompletedRow(row)) scheduleFinish();
  };
  const handleSessionMessage = ({ agentId: incomingAgentId, threadId, message: row }: { agentId: string; threadId?: string; message?: SessionMessageRow }) => {
    if (incomingAgentId === agentId && (threadId || agentId) === thread.id) consumeRow(row);
  };
  const abort = () => {
    socket.emit("stdin", { agentId, threadId: thread.id, data: "\x03" });
    queue.end();
  };

  try {
    const existing = await api.getAgentThreadMessages(agentId, thread.id);
    baselineId = existing.reduce((maximum, row) => Math.max(maximum, Number(row.id || 0)), 0);
    socket.emit("join", { agentId, threadId: thread.id });
    socket.on("session_message", handleSessionMessage);
    runOptions.abortSignal?.addEventListener("abort", abort, { once: true });
    heartbeatTimer = setInterval(() => queue.push(CursorInteractionUpdate.heartbeat()), 10_000);
    timeoutTimer = setTimeout(() => queue.fail(new Error("The chat.dev agent did not finish this turn within 30 minutes.")), 30 * 60_000);
    pollTimer = setInterval(() => {
      void api.getAgentThreadMessages(agentId, thread.id).then((rows) => rows.forEach(consumeRow)).catch(() => undefined);
    }, 750);

    await api.sendAgentThreadMessage(agentId, thread.id, message, requestId);

    for await (const update of queue) yield update;
  } finally {
    if (completionTimer) clearTimeout(completionTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    runOptions.abortSignal?.removeEventListener("abort", abort);
    socket.off("session_message", handleSessionMessage);
    socket.emit("leave", { agentId, threadId: thread.id });
    socket.disconnect();
    await controller.finishNativeRun(agentId, thread.id);
  }
}

async function resolveCursorSession(
  api: ChatDevApi,
  controller: CursorAgentPanelController,
  cursorSessionId: string,
  state: CursorProviderState,
  requestedModel?: string,
): Promise<{ agentId: string; thread: AgentThread }> {
  const binding = await controller.ensureCursorSessionBinding(cursorSessionId, state, requestedModel);
  const agentId = binding.agentId;
  const agent = await api.getAgent(agentId);
  const threads = await api.listAgentThreads(agent);
  const thread = threads.find((candidate) => candidate.id === state.chatdevThreadId)
    || threads.find((candidate) => candidate.id === binding.threadId)
    || threads.find((candidate) => candidate.sourceSessionId === cursorSessionId)
    || (binding.threadId === agentId ? threads.find((candidate) => candidate.isDefault) : undefined);
  if (!thread) throw new Error("This chat.dev agent has no coding session.");
  return { agentId, thread };
}

function cursorMessageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const candidate of [record.text, record.message, record.query, record.prompt]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function validCursorRequestId(value: unknown): string | undefined {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_.:-]{8,100}$/.test(id) ? id : undefined;
}

function shouldHideCursorPanelMessage(row: SessionMessageRow): boolean {
  return ["command_output", "tool_output", "terminal_output"].includes(String(row.phase || ""));
}

function isCompletedRow(row: SessionMessageRow): boolean {
  const phase = String(row.phase || "").toLowerCase();
  const kind = String(row.kind || "").toLowerCase();
  return ["final_answer", "error", "submit_error", "uncertain_done"].includes(phase)
    || ["final_answer", "turn-completed", "turn-error", "turn-cancelled"].includes(kind);
}

class CursorInteractionUpdate {
  private constructor(private readonly bytes: Uint8Array) {}

  toBinary(): Uint8Array {
    return this.bytes;
  }

  static text(text: string): CursorInteractionUpdate {
    const encoded = new TextEncoder().encode(text);
    const nested = concatBytes(Uint8Array.of(0x0a), encodeVarint(encoded.length), encoded);
    return new CursorInteractionUpdate(concatBytes(Uint8Array.of(0x0a), encodeVarint(nested.length), nested));
  }

  static heartbeat(): CursorInteractionUpdate {
    return new CursorInteractionUpdate(Uint8Array.of(0x6a, 0x00));
  }

  static turnEnded(): CursorInteractionUpdate {
    return new CursorInteractionUpdate(Uint8Array.of(0x72, 0x00));
  }
}

class InteractionUpdateQueue implements AsyncIterable<CursorInteractionUpdate> {
  private readonly values: CursorInteractionUpdate[] = [];
  private readonly waiters: Array<(result: IteratorResult<CursorInteractionUpdate>) => void> = [];
  private done = false;
  private error: Error | undefined;

  push(value: CursorInteractionUpdate): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.error = error;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<CursorInteractionUpdate> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<CursorInteractionUpdate>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.trunc(value));
  do {
    let next = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) next |= 0x80;
    bytes.push(next);
  } while (remaining);
  return Uint8Array.from(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function bridgeIsCurrent(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(vscode.env.appRoot, "extensions", BRIDGE_DIRECTORY, "package.json"), "utf8");
    if (JSON.parse(raw).version !== BRIDGE_VERSION) return false;
    const workbenchPath = cursorWorkbenchPath();
    const workbench = await fs.readFile(workbenchPath, "utf8");
    if (!workbench.includes(APPEND_COMPOSER_MESSAGES_COMMAND)
      || !workbench.includes(PRUNE_COMPOSER_MESSAGES_COMMAND)
      || !workbench.includes(PRUNE_COMPOSER_MESSAGES_PATCH_MARKER)
      || !/isModelCompatibleWithClaudeCodeBackend\([^)]*\)\{return [^=]+==="chat\.dev"\|\|/.test(workbench)
      || !/getAgentBackendForFirstSubmit\([^)]*\)\{if\([^=]+\.modelName==="chat\.dev"\)/.test(workbench)) return false;
    const product = JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, "product.json"), "utf8"));
    return product?.checksums?.["vs/workbench/workbench.desktop.main.js"] === sha256Base64(workbench);
  } catch {
    return false;
  }
}

async function installCursorBridge(context: vscode.ExtensionContext): Promise<void> {
  const source = path.join(context.extensionUri.fsPath, "cursor-bridge");
  const target = path.join(vscode.env.appRoot, "extensions", BRIDGE_DIRECTORY);
  const patch = await prepareCursorWorkbenchPatch();
  try {
    await copyBridge(source, target);
    await installPatchedCursorFiles(patch);
  } catch (error: any) {
    if (!/EACCES|EPERM|permission denied/i.test(String(error?.code || error?.message || error))) throw error;
    await installCursorBridgeWithElevation(source, target, patch);
  } finally {
    await fs.rm(patch.tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (process.platform === "darwin") await resignCursorIfNeeded();
  void vscode.window.showInformationMessage("Cursor is reloading once to connect chat.dev to its Agent panel.");
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function copyBridge(source: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: true });
}

type CursorWorkbenchPatch = {
  workbenchPath: string;
  productPath: string;
  patchedWorkbenchPath: string;
  patchedProductPath: string;
  tempDirectory: string;
};

async function prepareCursorWorkbenchPatch(): Promise<CursorWorkbenchPatch> {
  const workbenchPath = cursorWorkbenchPath();
  const productPath = path.join(vscode.env.appRoot, "product.json");
  const workbench = patchCursorWorkbenchSource(await fs.readFile(workbenchPath, "utf8"));
  const productSource = await fs.readFile(productPath, "utf8");
  const product = JSON.parse(productSource) as { checksums?: Record<string, string> };
  const checksumKey = "vs/workbench/workbench.desktop.main.js";
  const previousChecksum = product.checksums?.[checksumKey];
  if (!previousChecksum) throw new Error("This Cursor build does not expose its workbench checksum.");
  const checksum = sha256Base64(workbench);
  const productPattern = new RegExp(`("${escapeRegExp(checksumKey)}"\\s*:\\s*")${escapeRegExp(previousChecksum)}(")`);
  const patchedProduct = productSource.replace(productPattern, `$1${checksum}$2`);
  if (patchedProduct === productSource && previousChecksum !== checksum) {
    throw new Error("Could not update Cursor's workbench checksum.");
  }
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chatdev-cursor-"));
  const patchedWorkbenchPath = path.join(tempDirectory, "workbench.desktop.main.js");
  const patchedProductPath = path.join(tempDirectory, "product.json");
  await Promise.all([
    fs.writeFile(patchedWorkbenchPath, workbench),
    fs.writeFile(patchedProductPath, patchedProduct),
  ]);
  return { workbenchPath, productPath, patchedWorkbenchPath, patchedProductPath, tempDirectory };
}

function cursorWorkbenchPath(): string {
  return path.join(vscode.env.appRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
}

function sha256Base64(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64").replace(/=+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function installPatchedCursorFiles(patch: CursorWorkbenchPatch): Promise<void> {
  await fs.copyFile(patch.patchedWorkbenchPath, patch.workbenchPath);
  await fs.copyFile(patch.patchedProductPath, patch.productPath);
}

async function installCursorBridgeWithElevation(source: string, target: string, patch: CursorWorkbenchPatch): Promise<void> {
  const command = [
    `rm -rf ${shellQuote(target)}`,
    `mkdir -p ${shellQuote(path.dirname(target))}`,
    `cp -R ${shellQuote(source)} ${shellQuote(target)}`,
    `cp ${shellQuote(patch.patchedWorkbenchPath)} ${shellQuote(patch.workbenchPath)}`,
    `cp ${shellQuote(patch.patchedProductPath)} ${shellQuote(patch.productPath)}`,
  ].join(" && ");
  if (process.platform === "darwin") {
    const script = `do shell script ${appleScriptString(command)} with administrator privileges`;
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 120_000 });
    return;
  }
  if (process.platform === "linux") {
    await execFileAsync("pkexec", ["/bin/sh", "-c", command], { timeout: 120_000 });
    return;
  }
  throw new Error(`Cursor is installed in a protected folder. Give your account write access to ${path.dirname(target)}, then run "chat.dev: Connect Cursor Agent Panel" again.`);
}

async function resignCursorIfNeeded(): Promise<void> {
  const appBundle = path.resolve(vscode.env.appRoot, "../../..");
  if (!appBundle.endsWith(".app")) return;
  try {
    await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appBundle], { timeout: 120_000 });
  } catch (error: any) {
    if (!/permission denied|not permitted/i.test(String(error?.message || error))) throw error;
    const command = `/usr/bin/codesign --force --deep --sign - ${shellQuote(appBundle)}`;
    const script = `do shell script ${appleScriptString(command)} with administrator privileges`;
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 120_000 });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
