import * as crypto from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import * as vscode from "vscode";
import { io, type Socket } from "socket.io-client";

const LEGACY_SECRET_KEY = "chatdev.accessToken";
const DEFAULT_SERVER_URL = "https://api.chat.dev";

export type Agent = {
  id: string;
  name: string;
  status: string;
  statusSummary?: string | null;
  agentRuntime?: string | null;
  model?: string | null;
  machineSize?: string | null;
  volumeGb?: number | null;
};

export type AgentUpdateResult = Agent & {
  needsRestart?: boolean;
};

export type EditorConversation = {
  id: string;
  title: string;
  provider: "codex" | "claude" | "cursor";
  runtime: "codex-tmux" | "claude-code-tmux" | "cursor-agent-tmux";
  model?: string;
  mtime: number;
  credentialSources?: string[];
};

export type EditorHandoff = {
  kind: "continue" | "open";
  callbackUri: string;
  projectName: string | null;
  projectPath: string | null;
  conversations: EditorConversation[];
  status: "pending" | "selected" | "uploading" | "complete" | "failed" | "retry_requested";
  agentId: string | null;
  conversationId: string | null;
  mainSessionId?: string | null;
  credentialScope: "global" | "agent" | "none";
  progressMessage: string | null;
  error: string | null;
  expiresAt: string;
  agentAvailable?: boolean | null;
};

export type ChatMessage = {
  id: number;
  role: string;
  content: string;
  source?: string | null;
  sourceKey?: string | null;
  kind?: string | null;
  phase?: string | null;
  runtimeTurnId?: string | null;
  streamId?: string | null;
  append?: boolean;
  createdAt?: string | null;
};

export type AgentThread = {
  id: string;
  agentId: string;
  name: string;
  runtime: string;
  model: string | null;
  status: "starting" | "running" | "stopped" | "errored";
  isPrimary: boolean;
  isMain?: boolean;
  parentThreadId: string | null;
  forkedFromMessageId: number | null;
  forkThroughRuntimeTurnId: string | null;
  branchKind: "main" | "new" | "branch" | "edit" | "import";
  sourceProvider?: "codex" | "claude" | "cursor" | null;
  sourceSessionId?: string | null;
};

export type ImportedChatMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string | null;
  sourceId?: string;
  turnId?: string;
};

export type EditorLanguageModel = {
  id: string;
  name: string;
  provider: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { toolCalling?: boolean | number; imageInput?: boolean };
};

export type EditorLanguageModelEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: object }
  | { type: "error"; message: string }
  | { type: "done" };

export type EditorMachineTier = {
  id: "standard" | "pro" | "max" | "gpu";
  label: string;
  cpuKind: "shared" | "performance";
  cpus: number;
  memoryMb: number;
  volumeGb: number;
  monthlyUsd: number;
  gpuKind?: string;
  gpus?: number;
};

export class ChatDevApi {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get globalState(): vscode.Memento {
    return this.context.globalState;
  }

  get serverUrl(): string {
    return vscode.workspace.getConfiguration("chatdev").get<string>("serverUrl", DEFAULT_SERVER_URL).replace(/\/+$/, "");
  }

  private get secretKey(): string {
    return `${LEGACY_SECRET_KEY}:${this.serverUrl}`;
  }

  async isSignedIn(): Promise<boolean> {
    return !!(await this.context.secrets.get(this.secretKey));
  }

  async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const response = await this.fetch(path, init, authenticated);
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = new Error(String(body.error || `chat.dev request failed (${response.status})`));
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return body as T;
  }

  private async requestSessionApi<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await this.request<T>(path, init);
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 404) throw error;
      return this.request<T>(path.replace("/sessions", "/threads"), init);
    }
  }

  async fetch(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (authenticated) {
      const token = await this.context.secrets.get(this.secretKey);
      if (!token) throw new Error("Sign in to chat.dev first.");
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(`${this.serverUrl}${path}`, { ...init, headers });
  }

  async signIn(): Promise<void> {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const device = await this.request<{
      deviceCode: string;
      userCode: string;
      verificationUriComplete: string;
      interval: number;
      expiresAt: string;
    }>("/api/auth/extension/device", {
      method: "POST",
      body: JSON.stringify({ codeChallenge, clientName: `${vscode.env.appName} on ${process.platform}` }),
    }, false);

    const opened = await vscode.env.openExternal(vscode.Uri.parse(device.verificationUriComplete));
    if (!opened) {
      await vscode.env.clipboard.writeText(device.verificationUriComplete);
      void vscode.window.showInformationMessage(`Open the copied URL and enter code ${device.userCode}.`);
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Waiting for chat.dev authorization (${device.userCode})`,
      cancellable: true,
    }, async (_progress, cancellation) => {
      while (!cancellation.isCancellationRequested && Date.now() < Date.parse(device.expiresAt)) {
        await delay(Math.max(2, device.interval) * 1000);
        try {
          const token = await this.request<{ accessToken: string }>("/api/auth/extension/token", {
            method: "POST",
            body: JSON.stringify({ deviceCode: device.deviceCode, codeVerifier: verifier }),
          }, false);
          await this.context.secrets.store(this.secretKey, token.accessToken);
          await vscode.commands.executeCommand("setContext", "chatdev.signedIn", true);
          return;
        } catch (error) {
          if ((error as Error & { status?: number }).status === 428) continue;
          throw error;
        }
      }
      throw new Error(cancellation.isCancellationRequested ? "Sign in canceled." : "The device code expired.");
    });
  }

  async signOut(): Promise<void> {
    const token = await this.context.secrets.get(this.secretKey);
    if (token) await this.request("/api/auth/extension/token", { method: "DELETE" }).catch(() => undefined);
    await this.context.secrets.delete(this.secretKey);
    await this.context.secrets.delete(LEGACY_SECRET_KEY);
    await vscode.commands.executeCommand("setContext", "chatdev.signedIn", false);
  }

  async ensureSignedIn(): Promise<void> {
    if (!(await this.isSignedIn())) await this.signIn();
  }

  async listAgents(): Promise<Agent[]> {
    return (await this.request<{ agents: Agent[] }>("/api/agents")).agents;
  }

  async getAgent(id: string): Promise<Agent> {
    return this.request<Agent>(`/api/agents/${encodeURIComponent(id)}`);
  }

  async getChatMessages(agentId: string, limit = 200): Promise<ChatMessage[]> {
    const result = await this.request<{ messages: ChatMessage[] }>(`/api/chat/${encodeURIComponent(agentId)}/messages?limit=${encodeURIComponent(String(limit))}`);
    return result.messages || [];
  }

  async listAgentThreads(agent: Agent): Promise<AgentThread[]> {
    try {
      const result = await this.requestSessionApi<{ sessions?: AgentThread[]; threads?: AgentThread[] }>(`/api/agents/${encodeURIComponent(agent.id)}/sessions`);
      const threads = result.sessions || result.threads || [];
      return threads.map((thread) => ({
        ...thread,
        isPrimary: thread.isMain ?? thread.isPrimary,
        forkedFromMessageId: thread.forkedFromMessageId ?? null,
        forkThroughRuntimeTurnId: thread.forkThroughRuntimeTurnId ?? null,
        branchKind: thread.branchKind || ((thread.isMain ?? thread.isPrimary) ? "main" : thread.parentThreadId ? "branch" : "new"),
      }));
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 404) throw error;
      return [{
        id: agent.id,
        agentId: agent.id,
        name: "Main",
        runtime: agent.agentRuntime || "codex-tmux",
        model: null,
        status: (["starting", "running", "errored"].includes(agent.status) ? agent.status : "stopped") as AgentThread["status"],
        isPrimary: true,
        parentThreadId: null,
        forkedFromMessageId: null,
        forkThroughRuntimeTurnId: null,
        branchKind: "main",
      }];
    }
  }

  async startAgentThread(agentId: string, threadId: string): Promise<AgentThread> {
    const result = await this.requestSessionApi<{ session?: AgentThread; thread?: AgentThread }>(
      `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/start`,
      { method: "POST", body: "{}" },
    );
    return result.session || result.thread!;
  }

  async restartAgentThread(agentId: string, threadId: string): Promise<AgentThread> {
    const result = await this.requestSessionApi<{ session?: AgentThread; thread?: AgentThread }>(
      `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/restart`,
      { method: "POST", body: "{}" },
    );
    return result.session || result.thread!;
  }

  async createAgentThread(agentId: string, input: {
    name: string;
    runtime: string;
    model?: string;
    sourceProvider: "codex" | "claude" | "cursor";
    sourceSessionId: string;
    start?: boolean;
  }): Promise<AgentThread> {
    const result = await this.requestSessionApi<{ session?: AgentThread; thread?: AgentThread }>(
      `/api/agents/${encodeURIComponent(agentId)}/sessions`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.session || result.thread!;
  }

  async updateAgentThread(agentId: string, threadId: string, input: {
    name?: string;
    runtime?: string;
    model?: string | null;
    sourceProvider?: "codex" | "claude" | "cursor";
    sourceSessionId?: string;
  }): Promise<AgentThread> {
    const result = await this.requestSessionApi<{ session?: AgentThread; thread?: AgentThread }>(
      `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return result.session || result.thread!;
  }

  async sendChatMessage(agentId: string, message: string): Promise<void> {
    await this.request("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({ agentId, message }),
    });
  }

  async getAgentThreadMessages(agentId: string, threadId: string, limit = 500): Promise<ChatMessage[]> {
    const result = await this.requestSessionApi<{ messages?: ChatMessage[] }>(
      `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/messages?limit=${Math.max(1, Math.min(500, limit))}`,
    );
    return result.messages || [];
  }

  async getAgentThreadHistory(agentId: string, threadId: string, maximum = 5_000): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    let beforeId = 0;
    while (messages.length < maximum) {
      const query = new URLSearchParams({ limit: String(Math.min(500, maximum - messages.length)) });
      if (beforeId > 0) query.set("beforeId", String(beforeId));
      const page = await this.requestSessionApi<{ messages?: ChatMessage[]; oldestId?: number | null; hasMoreOlder?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/messages?${query.toString()}`,
      );
      const rows = page.messages || [];
      messages.unshift(...rows);
      const oldestId = Number(page.oldestId || rows[0]?.id || 0);
      if (!page.hasMoreOlder || !oldestId || oldestId === beforeId || rows.length === 0) break;
      beforeId = oldestId;
    }
    return messages.slice(-maximum);
  }

  async sendAgentThreadMessage(agentId: string, threadId: string, message: string, clientMessageId: string): Promise<void> {
    await this.requestSessionApi(
      `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(threadId)}/messages`,
      { method: "POST", body: JSON.stringify({ message, clientMessageId }) },
    );
  }

  async importChatMessages(input: {
    agentId: string;
    threadId: string;
    provider: "codex" | "claude" | "cursor";
    sessionId: string;
    messages: ImportedChatMessage[];
  }): Promise<number> {
    const body = JSON.stringify({
      provider: input.provider,
      sessionId: input.sessionId,
      messages: input.messages,
    });
    let result: { imported: number };
    try {
      result = await this.requestSessionApi<{ imported: number }>(
        `/api/agents/${encodeURIComponent(input.agentId)}/sessions/${encodeURIComponent(input.threadId)}/import-messages`,
        { method: "POST", body },
      );
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 404) throw error;
      result = await this.request<{ imported: number }>(`/api/chat/${encodeURIComponent(input.agentId)}/import-messages`, {
        method: "POST",
        body,
      });
    }
    return result.imported || 0;
  }

  async writeWorkspaceFile(agentId: string, remotePath: string, data: Uint8Array): Promise<void> {
    const socket = await this.connectSocket();
    try {
      const result = await socketAck<{ ok: boolean; error?: string }>(socket, "write_file", {
        agentId,
        path: remotePath,
        dataBase64: Buffer.from(data).toString("base64"),
      }, 120_000);
      if (!result.ok) throw new Error(result.error || "Could not update the remote conversation context.");
    } finally {
      socket.disconnect();
    }
  }

  async listEditorLanguageModels(): Promise<EditorLanguageModel[]> {
    return (await this.request<{ models: EditorLanguageModel[] }>("/api/editor/language-models")).models || [];
  }

  async listEditorMachineTiers(): Promise<EditorMachineTier[]> {
    return (await this.request<{ tiers: EditorMachineTier[] }>("/api/editor/machine-tiers")).tiers || [];
  }

  async streamEditorLanguageModelChat(
    input: Record<string, unknown>,
    onEvent: (event: EditorLanguageModelEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetch("/api/editor/language-models/chat-stream", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(String(body.error || `chat.dev model request failed (${response.status})`));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as EditorLanguageModelEvent;
        if (event.type === "error") throw new Error(event.message);
        onEvent(event);
      }
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer) as EditorLanguageModelEvent;
      if (event.type === "error") throw new Error(event.message);
      onEvent(event);
    }
  }

  async createEditorHandoff(input: {
    kind: "continue" | "open";
    callbackUri: string;
    projectName?: string;
    projectPath?: string;
    conversations?: EditorConversation[];
  }): Promise<{ token: string; browserUrl: string; expiresAt: string }> {
    return this.request("/api/editor-handoffs", { method: "POST", body: JSON.stringify(input) });
  }

  async getEditorHandoff(token: string): Promise<EditorHandoff> {
    return (await this.request<{ handoff: EditorHandoff }>(`/api/editor-handoffs/${encodeURIComponent(token)}`)).handoff;
  }

  async updateEditorHandoff(token: string, input: {
    status: "uploading" | "complete" | "failed";
    progressMessage?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.request(`/api/editor-handoffs/${encodeURIComponent(token)}/progress`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createAgent(input: Record<string, unknown>): Promise<Agent> {
    return this.request<Agent>("/api/agents", { method: "POST", body: JSON.stringify(input) });
  }

  async updateAgent(id: string, input: Record<string, unknown>): Promise<AgentUpdateResult> {
    return this.request<AgentUpdateResult>(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async startAgent(id: string): Promise<void> {
    await this.request(`/api/agents/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" });
  }

  async stopAgent(id: string): Promise<void> {
    await this.request(`/api/agents/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" });
  }

  async deleteAgent(id: string): Promise<void> {
    await this.request(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async saveGlobalProviderCredentials(provider: "codex" | "claude" | "cursor", values: Record<string, string>): Promise<string[]> {
    const result = await this.request<{ keys: string[] }>("/api/credentials/import-provider", {
      method: "POST",
      body: JSON.stringify({ provider, values }),
    });
    return result.keys;
  }

  async importAgentCredentials(agentId: string, provider: "codex" | "claude" | "cursor", values: Record<string, string>): Promise<string[]> {
    const socket = await this.connectSocket();
    try {
      const result = await socketAck<{ ok: boolean; keys?: string[]; error?: string }>(socket, "credential_import", { agentId, provider, values });
      if (!result.ok) throw new Error(result.error || "Could not install provider credentials on the agent.");
      return result.keys || [];
    } finally {
      socket.disconnect();
    }
  }

  async storeAgentCredentials(agentId: string, provider: "codex" | "claude" | "cursor", values: Record<string, string>): Promise<string[]> {
    const result = await this.request<{ keys: string[] }>(`/api/credentials/agents/${encodeURIComponent(agentId)}/import-provider`, {
      method: "POST",
      body: JSON.stringify({ provider, values }),
    });
    return result.keys || [];
  }

  async getAgentOpenUrl(agentId: string): Promise<string> {
    return (await this.request<{ browserUrl: string }>(`/api/editor-handoffs/agents/${encodeURIComponent(agentId)}/open-url`)).browserUrl;
  }

  async uploadLocalFile(agentId: string, remotePath: string, localPath: string): Promise<void> {
    const metadata = await stat(localPath);
    const socket = await this.connectSocket();
    try {
      const begin = await socketAck<{ ok: boolean; transferId?: string; error?: string }>(socket, "file_upload_begin", {
        agentId,
        path: remotePath,
        size: metadata.size,
        mode: metadata.mode,
      });
      if (!begin.ok || !begin.transferId) throw new Error(begin.error || "Could not start large file upload.");
      const hash = crypto.createHash("sha256");
      let sequence = 0;
      for await (const rawChunk of createReadStream(localPath, { highWaterMark: 512 * 1024 })) {
        const chunk = Buffer.from(rawChunk);
        hash.update(chunk);
        const response = await socketAck<{ ok: boolean; error?: string }>(socket, "file_upload_chunk", {
          agentId,
          transferId: begin.transferId,
          sequence: sequence++,
          dataBase64: chunk.toString("base64"),
        });
        if (!response.ok) throw new Error(response.error || "Large file upload failed.");
      }
      const commit = await socketAck<{ ok: boolean; error?: string }>(socket, "file_upload_commit", {
        agentId,
        transferId: begin.transferId,
        sha256: hash.digest("hex"),
      }, 120_000);
      if (!commit.ok) throw new Error(commit.error || "Could not finalize large file upload.");
    } finally {
      socket.disconnect();
    }
  }

  async uploadWorkspaceArchive(agentId: string, archivePath: string, itemCount: number): Promise<{ itemCount: number; bytes: number }> {
    const metadata = await stat(archivePath);
    const socket = await this.connectSocket();
    try {
      const begin = await socketAck<{ ok: boolean; transferId?: string; error?: string }>(socket, "workspace_upload_begin", {
        agentId,
        size: metadata.size,
        itemCount,
      });
      if (!begin.ok || !begin.transferId) throw new Error(begin.error || "Could not start workspace upload.");
      const hash = crypto.createHash("sha256");
      let sequence = 0;
      for await (const rawChunk of createReadStream(archivePath, { highWaterMark: 512 * 1024 })) {
        const chunk = Buffer.from(rawChunk);
        hash.update(chunk);
        const response = await socketAck<{ ok: boolean; error?: string }>(socket, "workspace_upload_chunk", {
          agentId,
          transferId: begin.transferId,
          sequence: sequence++,
          dataBase64: chunk.toString("base64"),
        }, 60_000);
        if (!response.ok) throw new Error(response.error || "Workspace upload failed.");
      }
      const commit = await socketAck<{ ok: boolean; itemCount?: number; bytes?: number; error?: string }>(socket, "workspace_upload_commit", {
        agentId,
        transferId: begin.transferId,
        sha256: hash.digest("hex"),
      }, 180_000);
      if (!commit.ok) throw new Error(commit.error || "Could not finalize workspace upload.");
      return { itemCount: Number(commit.itemCount || 0), bytes: Number(commit.bytes || 0) };
    } finally {
      socket.disconnect();
    }
  }

  async connectSocket(): Promise<Socket> {
    const { token } = await this.request<{ token: string }>("/api/auth/socket-token");
    const socket = io(this.serverUrl, { transports: ["websocket"], auth: { token }, reconnection: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to chat.dev.")), 15_000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
    });
    let refreshing = false;
    socket.on("connect_error", (error) => {
      if (refreshing || !/unauthorized/i.test(error.message)) return;
      refreshing = true;
      void this.request<{ token: string }>("/api/auth/socket-token").then((fresh) => {
        socket.auth = { token: fresh.token };
        socket.connect();
      }).finally(() => { refreshing = false; });
    });
    return socket;
  }

  async importCodingSession(input: {
    agentId: string;
    threadId: string;
    runtime: string;
    provider: "codex" | "claude" | "cursor";
    sessionId: string;
    localCwd: string;
    data: Uint8Array;
    referenceOnly?: boolean;
  }): Promise<void> {
    const socket = await this.connectSocket();
    try {
      const bytes = Buffer.from(input.data);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const begin = await socketAck<{ ok: boolean; transferId?: string; error?: string }>(socket, "session_import_begin", {
        agentId: input.agentId,
        targetSessionId: input.threadId,
        threadId: input.threadId,
        runtime: input.runtime,
        provider: input.provider,
        sourceSessionId: input.sessionId,
        sessionId: input.sessionId,
        localCwd: input.localCwd,
        size: bytes.length,
        sha256,
        referenceOnly: input.referenceOnly ?? input.provider === "cursor",
      });
      if (!begin.ok || !begin.transferId) throw new Error(begin.error || "Could not start coding-session transfer.");
      const chunkBytes = 512 * 1024;
      for (let offset = 0, sequence = 0; offset < bytes.length; offset += chunkBytes, sequence++) {
        const chunk = await socketAck<{ ok: boolean; error?: string }>(socket, "session_import_chunk", {
          agentId: input.agentId,
          transferId: begin.transferId,
          sequence,
          dataBase64: bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)).toString("base64"),
        });
        if (!chunk.ok) throw new Error(chunk.error || "Coding-session transfer failed.");
      }
      const commit = await socketAck<{ ok: boolean; error?: string }>(socket, "session_import_commit", {
        agentId: input.agentId,
        transferId: begin.transferId,
      }, 150_000);
      if (!commit.ok) throw new Error(commit.error || "Could not resume the coding session remotely.");
    } finally {
      socket.disconnect();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketAck<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chat.dev ${event} request timed out.`)), timeoutMs);
    socket.emit(event, payload, (result: T) => { clearTimeout(timer); resolve(result); });
  });
}
