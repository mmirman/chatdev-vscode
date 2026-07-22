import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { dedupeCursorTranscriptMessages } from "./cursor-sync-identity";
import { querySqlite } from "./sqlite";

export type LocalAgentSession = {
  provider: "codex" | "claude" | "cursor" | "copilot";
  runtime: "codex-tmux" | "claude-code-tmux" | "cursor-agent-tmux" | "copilot-tmux";
  sessionId: string;
  filePath?: string;
  sessionDirectory?: string;
  sessionFormat?: "copilot-cli" | "vscode-chat";
  stateDbPath?: string;
  cwd: string;
  model?: string;
  title: string;
  mtime: number;
  size: number;
  messages?: LocalSessionMessage[];
};

export type LocalSessionMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string | null;
  sourceId?: string;
  turnId?: string;
  originKey?: string;
};

const SESSION_SCAN_BYTES = 2 * 1024 * 1024;
let extensionGlobalStoragePath: string | undefined;

export function configureLocalSessionStorage(globalStoragePath: string): void {
  extensionGlobalStoragePath = globalStoragePath;
}

export async function findLocalAgentSessions(workspace: vscode.Uri): Promise<LocalAgentSession[]> {
  if (workspace.scheme !== "file") return [];
  const workspacePath = await canonicalPath(workspace.fsPath);
  const [cursor, vscodeChat, copilot, codex, claude] = await Promise.all([
    findCursorSessions(workspacePath),
    findVSCodeChatSessions(workspacePath),
    findCopilotSessions(workspacePath),
    findCodexSessions(workspacePath),
    findClaudeSessions(workspacePath),
  ]);
  if (isCursorHost() && cursor.length) return sortSessions(cursor);
  if (!isCursorHost() && (vscodeChat.length || copilot.length)) {
    const sessions = new Map(copilot.map((session) => [session.sessionId, session]));
    for (const session of vscodeChat) sessions.set(session.sessionId, session);
    return sortSessions([...sessions.values()]);
  }
  return sortSessions([...cursor, ...copilot, ...codex, ...claude]);
}

function sortSessions(sessions: LocalAgentSession[]): LocalAgentSession[] {
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

function isCursorHost(): boolean {
  return /cursor/i.test(vscode.env.appName);
}

export async function readSession(session: LocalAgentSession): Promise<Uint8Array> {
  if (session.provider === "copilot" && session.sessionFormat === "vscode-chat") {
    return readVSCodeChatSessionBundle(session);
  }
  if (session.provider === "copilot" && session.sessionDirectory) {
    return readCopilotSessionBundle(session);
  }
  if (session.provider === "cursor") {
    return renderCursorSessionTranscript(session, await readSessionMessages(session));
  }
  if (!session.filePath) return new Uint8Array();
  return fs.readFile(session.filePath);
}

export function renderCursorSessionTranscript(session: LocalAgentSession, messages: LocalSessionMessage[]): Uint8Array {
  const lines = [
    "# Imported Cursor Conversation",
    "",
    `Cursor conversation ID: ${session.sessionId}`,
    `Original project: ${session.cwd}`,
    "",
  ];
  for (const message of messages) {
    lines.push(`## ${message.role === "user" ? "User" : "Assistant"}`, "", message.content, "");
  }
  return new TextEncoder().encode(lines.join("\n"));
}

export async function readSessionMessages(session: LocalAgentSession): Promise<LocalSessionMessage[]> {
  if (session.provider === "cursor" && session.stateDbPath) {
    try {
      const metadata = await fs.stat(session.stateDbPath);
      const rows = await readCursorRows(session.stateDbPath);
      const refreshed = (await cursorSessionsFromRows(
        rows,
        { dbPath: session.stateDbPath, workspacePath: session.cwd },
        session.cwd,
        metadata.mtimeMs,
        metadata.size,
      )).find((candidate) => candidate.sessionId === session.sessionId);
      if (refreshed?.messages?.length) return refreshed.messages.slice(-1000);
    } catch {
      // Cursor can rotate or lock its state database briefly while saving.
    }
  }
  if (session.provider === "copilot" && session.sessionFormat === "vscode-chat" && session.filePath) {
    try {
      return vscodeChatMessages(await readVSCodeChatData(session.filePath), session.sessionId).slice(-1000);
    } catch {
      // VS Code may be appending a mutation while this polling pass reads it.
    }
  }
  if (session.messages?.length) return session.messages.slice(-1000);
  if (!session.filePath) return [];
  if (session.provider === "cursor") return readCursorTranscriptMessages(session.filePath);
  const lines = (await fs.readFile(session.filePath, "utf8")).split(/\r?\n/).filter(Boolean);
  const messages: LocalSessionMessage[] = [];
  for (const line of lines) {
    const record = parseJson(line);
    const message = session.provider === "codex"
      ? codexMessage(record)
      : session.provider === "copilot"
        ? copilotMessage(record)
        : claudeMessage(record);
    if (!message || !message.content || isBootstrapContext(message.content)) continue;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role && previous.content === message.content) continue;
    messages.push(message);
  }
  return messages.slice(-1000);
}

async function findCopilotSessions(workspacePath: string): Promise<LocalAgentSession[]> {
  const roots = [
    process.env.COPILOT_HOME && path.join(process.env.COPILOT_HOME, "session-state"),
    process.env.XDG_STATE_HOME && path.join(process.env.XDG_STATE_HOME, ".copilot", "session-state"),
    path.join(os.homedir(), ".copilot", "session-state"),
  ].filter((value): value is string => !!value);
  const sessions: LocalAgentSession[] = [];
  for (const root of [...new Set(roots)]) {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDirectory = path.join(root, entry.name);
      const filePath = path.join(sessionDirectory, "events.jsonl");
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        const lines = await readLines(filePath);
        const records = lines.map(parseJson).filter(Boolean);
        const start = records.find((record) => record?.type === "session.start");
        const workspace = await readCopilotWorkspace(path.join(sessionDirectory, "workspace.yaml"));
        const cwd = firstString([workspace.cwd, start?.data?.context?.cwd]);
        if (!cwd || !(await relatedPath(cwd, workspacePath))) continue;
        const modelChanges = records.filter((record) => record?.type === "session.model_change");
        const model = firstString([
          modelChanges[modelChanges.length - 1]?.data?.newModel,
          lastCopilotAssistantModel(records),
        ]);
        const sessionId = firstString([workspace.id, start?.data?.sessionId, entry.name])!;
        sessions.push({
          provider: "copilot",
          runtime: "copilot-tmux",
          sessionId,
          filePath,
          sessionDirectory,
          sessionFormat: "copilot-cli",
          cwd,
          model,
          title: workspace.name || firstCopilotUserText(records) || `Copilot ${sessionId.slice(0, 8)}`,
          mtime: stat.mtimeMs,
          size: stat.size,
        });
      } catch {}
    }
  }
  return [...new Map(sessions.map((session) => [session.sessionId, session])).values()];
}

async function findVSCodeChatSessions(workspacePath: string): Promise<LocalAgentSession[]> {
  if (isCursorHost()) return [];
  const sessions: LocalAgentSession[] = [];
  for (const userDirectory of await vscodeUserDirectories()) {
    const storageRoot = path.join(userDirectory, "workspaceStorage");
    let workspaces: import("fs").Dirent[];
    try { workspaces = await fs.readdir(storageRoot, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of workspaces) {
      if (!entry.isDirectory()) continue;
      const workspaceDirectory = path.join(storageRoot, entry.name);
      if (!(await vscodeStorageMatchesWorkspace(workspaceDirectory, workspacePath))) continue;
      const chatDirectory = path.join(workspaceDirectory, "chatSessions");
      let files: import("fs").Dirent[];
      try { files = await fs.readdir(chatDirectory, { withFileTypes: true }); }
      catch { continue; }
      const preferred = new Map<string, string>();
      for (const file of files) {
        if (!file.isFile() || !/\.jsonl?$/i.test(file.name)) continue;
        const stem = file.name.replace(/\.jsonl?$/i, "");
        const candidate = path.join(chatDirectory, file.name);
        if (file.name.toLowerCase().endsWith(".jsonl") || !preferred.has(stem)) preferred.set(stem, candidate);
      }
      for (const filePath of preferred.values()) {
        try {
          const [stat, data] = await Promise.all([fs.stat(filePath), readVSCodeChatData(filePath)]);
          if (!vscodeChatIsAgentSession(data)) continue;
          const sourceSessionId = firstString([data.sessionId, path.basename(filePath).replace(/\.jsonl?$/i, "")]);
          if (!sourceSessionId) continue;
          const sessionId = copilotSessionId(sourceSessionId);
          const messages = vscodeChatMessages(data, sessionId);
          if (!messages.length) continue;
          const firstUser = messages.find((message) => message.role === "user")?.content;
          sessions.push({
            provider: "copilot",
            runtime: "copilot-tmux",
            sessionId,
            filePath,
            sessionFormat: "vscode-chat",
            cwd: workspacePath,
            model: vscodeChatModel(data),
            title: firstString([data.customTitle, data.computedTitle])?.replace(/\s+/g, " ").slice(0, 90)
              || firstUser?.replace(/\s+/g, " ").slice(0, 90)
              || `GitHub Copilot ${sessionId.slice(0, 8)}`,
            mtime: stat.mtimeMs,
            size: stat.size,
            messages,
          });
        } catch {}
      }
    }
  }
  return [...new Map(sessions.map((session) => [session.sessionId, session])).values()];
}

async function vscodeUserDirectories(): Promise<string[]> {
  const product = vscode.env.appName.toLowerCase();
  const preferredProduct = product.includes("insider")
    ? "Code - Insiders"
    : product.includes("vscodium")
      ? "VSCodium"
      : product.includes("oss")
        ? "Code - OSS"
        : "Code";
  const products = [...new Set([preferredProduct, "Code", "Code - Insiders", "VSCodium", "Code - OSS"])];
  const commandLineUserData = commandLineValue("--user-data-dir");
  const explicit = [process.env.VSCODE_USER_DATA_DIR, commandLineUserData]
    .filter((value): value is string => !!value)
    .map((value) => path.basename(value).toLowerCase() === "user" ? value : path.join(value, "User"));
  const platform = process.platform === "darwin"
    ? products.map((name) => path.join(os.homedir(), "Library", "Application Support", name, "User"))
    : process.platform === "win32"
      ? products.map((name) => process.env.APPDATA ? path.join(process.env.APPDATA, name, "User") : "").filter(Boolean)
      : products.map((name) => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), name, "User"));
  const portable = process.env.VSCODE_PORTABLE ? [path.join(process.env.VSCODE_PORTABLE, "user-data", "User")] : [];
  const extensionStorageAncestors: string[] = [];
  if (extensionGlobalStoragePath) {
    let current = path.resolve(extensionGlobalStoragePath);
    for (let index = 0; index < 6; index += 1) {
      current = path.dirname(current);
      extensionStorageAncestors.push(current);
    }
  }
  const linuxPackages = process.platform === "linux" ? [
    path.join(os.homedir(), "snap", "code", "current", ".config", "Code", "User"),
    path.join(os.homedir(), ".var", "app", "com.visualstudio.code", "config", "Code", "User"),
  ] : [];
  const existing: string[] = [];
  for (const candidate of [...new Set([...extensionStorageAncestors, ...explicit, ...portable, ...platform, ...linuxPackages])]) {
    try {
      if ((await fs.stat(path.join(candidate, "workspaceStorage"))).isDirectory()) existing.push(candidate);
    } catch {}
  }
  return existing;
}

function commandLineValue(name: string): string | undefined {
  for (let index = 0; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === name) return process.argv[index + 1];
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  }
  return undefined;
}

async function vscodeStorageMatchesWorkspace(workspaceDirectory: string, workspacePath: string): Promise<boolean> {
  let data: Record<string, unknown>;
  try { data = JSON.parse(await fs.readFile(path.join(workspaceDirectory, "workspace.json"), "utf8")); }
  catch { return false; }
  const folder = pathFromUriLike(firstString([data.folder]));
  if (folder && await sameWorkspacePath(folder, workspacePath)) return true;
  const storedWorkspace = pathFromUriLike(firstString([data.workspace, data.configuration]));
  const openWorkspace = vscode.workspace.workspaceFile?.scheme === "file" ? vscode.workspace.workspaceFile.fsPath : undefined;
  if (storedWorkspace && openWorkspace && await sameWorkspacePath(storedWorkspace, openWorkspace)) return true;
  if (!storedWorkspace) return false;
  try {
    const definition = JSON.parse(await fs.readFile(storedWorkspace, "utf8")) as { folders?: Array<{ path?: string; uri?: string }> };
    for (const item of definition.folders || []) {
      const configured = item.uri ? pathFromUriLike(item.uri) : item.path ? path.resolve(path.dirname(storedWorkspace), item.path) : undefined;
      if (configured && await sameWorkspacePath(configured, workspacePath)) return true;
    }
  } catch {}
  return false;
}

async function readVSCodeChatData(filePath: string): Promise<Record<string, any>> {
  const content = await fs.readFile(filePath, "utf8");
  if (!filePath.toLowerCase().endsWith(".jsonl")) {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid VS Code chat session");
    return parsed;
  }
  let state: any;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseJson(line);
    if (!entry || typeof entry.kind !== "number") continue;
    if (entry.kind === 0) {
      state = entry.v;
    } else if (state !== undefined && entry.kind === 1) {
      state = applyVSCodeSet(state, entry.k, entry.v, false);
    } else if (state !== undefined && entry.kind === 2) {
      state = applyVSCodePush(state, entry.k, entry.v, entry.i);
    } else if (state !== undefined && entry.kind === 3) {
      state = applyVSCodeSet(state, entry.k, undefined, true);
    }
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid VS Code chat mutation log");
  return state;
}

function applyVSCodeSet(state: any, keyPath: unknown, value: unknown, remove: boolean): any {
  if (!Array.isArray(keyPath)) return state;
  if (!keyPath.length) return value;
  let parent = state;
  for (const segment of keyPath.slice(0, -1)) {
    if (!parent || typeof parent !== "object") return state;
    parent = parent[segment as any];
  }
  if (!parent || typeof parent !== "object") return state;
  const key = keyPath[keyPath.length - 1] as any;
  if (remove) delete parent[key];
  else parent[key] = value;
  return state;
}

function applyVSCodePush(state: any, keyPath: unknown, values: unknown, startIndex: unknown): any {
  if (!Array.isArray(keyPath)) return state;
  if (!keyPath.length) {
    const current = Array.isArray(state) ? state : [];
    if (Number.isInteger(startIndex) && Number(startIndex) >= 0) current.length = Number(startIndex);
    if (Array.isArray(values)) current.push(...values);
    return current;
  }
  let parent = state;
  for (const segment of keyPath.slice(0, -1)) {
    if (!parent || typeof parent !== "object") return state;
    parent = parent[segment as any];
  }
  if (!parent || typeof parent !== "object") return state;
  const key = keyPath[keyPath.length - 1] as any;
  const current = Array.isArray(parent[key]) ? parent[key] : [];
  if (Number.isInteger(startIndex) && Number(startIndex) >= 0) current.length = Number(startIndex);
  if (Array.isArray(values)) current.push(...values);
  parent[key] = current;
  return state;
}

function vscodeChatIsAgentSession(data: Record<string, any>): boolean {
  const inputMode = String(data.inputState?.mode?.kind || data.inputState?.mode?.id || "").toLowerCase();
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const requestUsesCopilotAgent = requests.some((request: any) => String(request?.agent?.id || "").toLowerCase().startsWith("github.copilot"));
  const requestIsAgentMode = requests.some((request: any) => {
    const mode = String(request?.modeInfo?.kind || request?.modeInfo?.telemetryModeId || "").toLowerCase();
    return mode === "agent";
  });
  const selectedModel = data.inputState?.selectedModel;
  const modelUsesCopilot = [selectedModel?.identifier, selectedModel?.metadata?.vendor, selectedModel?.metadata?.provider]
    .some((value) => /^(?:github\.)?copilot(?:[/:]|$)/i.test(String(value || "")));
  const responderUsesCopilot = /copilot/i.test(String(data.responderUsername || ""));
  return (inputMode === "agent" || requestIsAgentMode || requestUsesCopilotAgent)
    && (requestUsesCopilotAgent || modelUsesCopilot || responderUsesCopilot);
}

function vscodeChatMessages(data: Record<string, any>, sessionId: string): LocalSessionMessage[] {
  if (!Array.isArray(data.requests)) return [];
  const messages: LocalSessionMessage[] = [];
  for (let index = 0; index < data.requests.length; index += 1) {
    const request = data.requests[index];
    if (!request || typeof request !== "object") continue;
    const requestId = firstString([request.requestId]) || `${index}`;
    const turnId = `vscode:${sessionId}:${requestId}`;
    const userText = typeof request.message === "string" ? request.message.trim() : String(request.message?.text || "").trim();
    if (!request.isSystemInitiated && userText && !isBootstrapContext(userText)) {
      const sourceId = `${turnId}:user`;
      messages.push({
        role: "user",
        content: userText,
        createdAt: vscodeChatDate(request.timestamp),
        sourceId,
        turnId,
        originKey: sourceId,
      });
    }
    const assistantText = vscodeChatResponseText(request.response);
    if (!assistantText) continue;
    const sourceId = `${turnId}:assistant`;
    const assistant: LocalSessionMessage = {
      role: "assistant",
      content: assistantText,
      createdAt: vscodeChatDate(request.responseTimestamp),
      sourceId,
      turnId,
      originKey: sourceId,
    };
    if (request.isSystemInitiated && messages[messages.length - 1]?.role === "assistant") {
      const previous = messages[messages.length - 1];
      messages[messages.length - 1] = { ...previous, content: `${previous.content}\n\n${assistantText}` };
    } else {
      messages.push(assistant);
    }
  }
  return messages;
}

function vscodeChatResponseText(response: unknown): string {
  if (!Array.isArray(response)) return "";
  const parts: string[] = [];
  for (const value of response) {
    if (typeof value === "string") {
      if (value.trim()) parts.push(value.trim());
      continue;
    }
    const part = objectValue(value);
    if (!part) continue;
    const kind = String(part.kind || "");
    if (kind === "thinking" || kind === "toolInvocation" || kind === "toolInvocationSerialized") continue;
    let text: string | undefined;
    if (!kind && typeof part.value === "string") text = part.value;
    else if (kind === "markdownContent") text = textContent(part.content);
    else if (kind === "inlineReference") text = firstString([part.name]);
    else if (!kind || kind === "markdown") text = textContent(part);
    if (text?.trim()) parts.push(text.trim());
  }
  return parts.join("\n").trim();
}

function vscodeChatDate(value: unknown): string | null {
  const timestamp = cursorTimestampValue(value);
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function vscodeChatModel(data: Record<string, any>): string | undefined {
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const latestRequestModel = [...requests].reverse().map((request) => firstString([request?.modelId])).find(Boolean);
  return normalizeCopilotModel(firstString([
    data.inputState?.selectedModel?.metadata?.id,
    data.inputState?.selectedModel?.identifier,
    latestRequestModel,
  ]));
}

function normalizeCopilotModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^(?:github\.)?copilot[/:]/i, "").trim() || undefined;
}

function copilotSessionId(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : stableUuid("vscode-session", value);
}

function stableUuid(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readVSCodeChatSessionBundle(session: LocalAgentSession): Promise<Uint8Array> {
  const messages = session.filePath
    ? vscodeChatMessages(await readVSCodeChatData(session.filePath), session.sessionId)
    : session.messages || [];
  let clock = Math.max(0, Math.min(...messages.map((message) => Date.parse(message.createdAt || "")).filter(Number.isFinite), Date.now()));
  let parentId: string | null = null;
  const events: any[] = [];
  const push = (id: string, type: string, data: Record<string, unknown>, requestedTime?: string | null) => {
    const parsed = requestedTime ? Date.parse(requestedTime) : NaN;
    clock = Math.max(clock + 1, Number.isFinite(parsed) ? parsed : clock + 1);
    events.push({ id, parentId, timestamp: new Date(clock).toISOString(), type, data });
    parentId = id;
  };
  const startId = stableUuid(session.sessionId, "session.start");
  push(startId, "session.start", {
    sessionId: session.sessionId,
    copilotVersion: "0.0.0",
    producer: "chatdev-vscode-migration",
    startTime: new Date(clock).toISOString(),
    version: 1,
    ...(session.model ? { selectedModel: session.model } : {}),
    context: { cwd: session.cwd },
  }, messages[0]?.createdAt);
  for (const message of messages) {
    const identity = message.sourceId || `${message.turnId || "turn"}:${message.role}:${message.content}`;
    const eventId = stableUuid(session.sessionId, identity);
    if (message.role === "user") {
      push(eventId, "user.message", {
        content: message.content,
        source: "user",
      }, message.createdAt);
    } else {
      push(eventId, "assistant.message", {
        content: message.content,
        messageId: stableUuid(session.sessionId, identity, "message"),
        ...(session.model ? { model: session.model } : {}),
      }, message.createdAt);
    }
  }
  const eventLog = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const files = [{ path: "events.jsonl", mode: 0o600, dataBase64: Buffer.from(eventLog).toString("base64") }];
  return gzipSync(Buffer.from(JSON.stringify({ version: 1, sessionId: session.sessionId, files })), { level: 6 });
}

async function readCopilotWorkspace(filePath: string): Promise<{ id?: string; cwd?: string; name?: string }> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const result: { id?: string; cwd?: string; name?: string } = {};
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^(id|cwd|name):\s*(.*)$/);
      if (!match) continue;
      const value = parseYamlScalar(match[2]);
      if (match[1] === "id") result.id = value;
      else if (match[1] === "cwd") result.cwd = value;
      else result.name = value;
    }
    return result;
  } catch {
    return {};
  }
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return String(JSON.parse(trimmed)); } catch {}
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function firstCopilotUserText(records: any[]): string | undefined {
  const message = records.find((record) => record?.type === "user.message");
  const content = typeof message?.data?.content === "string" ? message.data.content.trim() : "";
  return content ? content.replace(/\s+/g, " ").slice(0, 90) : undefined;
}

function lastCopilotAssistantModel(records: any[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "assistant.message" && typeof record?.data?.model === "string") return record.data.model;
  }
  return undefined;
}

async function readCopilotSessionBundle(session: LocalAgentSession): Promise<Uint8Array> {
  const root = session.sessionDirectory!;
  const files: Array<{ path: string; mode: number; dataBase64: string }> = [];
  let rawBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolute);
      rawBytes += stat.size;
      if (rawBytes > 100 * 1024 * 1024) throw new Error(`Copilot session ${session.title} is larger than the 100 MB transfer limit.`);
      const relative = path.relative(root, absolute).split(path.sep).join(path.posix.sep);
      files.push({ path: relative, mode: stat.mode & 0o777, dataBase64: (await fs.readFile(absolute)).toString("base64") });
    }
  };
  await visit(root);
  if (!files.some((file) => file.path === "events.jsonl")) throw new Error(`Copilot session ${session.title} has no event log.`);
  const payload = Buffer.from(JSON.stringify({ version: 1, sessionId: session.sessionId, files }));
  return gzipSync(payload, { level: 6 });
}

async function findCodexSessions(workspacePath: string): Promise<LocalAgentSession[]> {
  const roots = [
    path.join(os.homedir(), ".codex", "sessions"),
    ...(process.env.CODEX_HOME ? [path.join(process.env.CODEX_HOME, "sessions")] : []),
  ];
  const files = (await Promise.all([...new Set(roots)].map(jsonlFiles))).flat();
  const sessions: LocalAgentSession[] = [];
  const seenSessionIds = new Set<string>();
  for (const filePath of [...new Set(files)]) {
    try {
      const stat = await fs.stat(filePath);
      const lines = await readLines(filePath);
      const records = lines.map(parseJson).filter(Boolean);
      const meta = codexMetadata(records, filePath);
      if (!meta.sessionId || !meta.cwd || !(await relatedPath(meta.cwd, workspacePath))) continue;
      if (seenSessionIds.has(meta.sessionId)) continue;
      seenSessionIds.add(meta.sessionId);
      sessions.push({
        provider: "codex",
        runtime: "codex-tmux",
        sessionId: meta.sessionId,
        filePath,
        cwd: meta.cwd,
        model: meta.model,
        title: firstUserText(lines) || `Codex ${meta.sessionId.slice(0, 8)}`,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {}
  }
  return sessions;
}

async function findCursorSessions(workspacePath: string): Promise<LocalAgentSession[]> {
  const [composers, transcripts] = await Promise.all([
    findCursorComposerSessions(workspacePath),
    findCursorAgentTranscripts(workspacePath),
  ]);
  // Cursor's composer database is the visible chat. Agent transcripts replay
  // some internal Build prompts, so use them only as metadata and a fallback.
  const transcriptsById = new Map(transcripts.map((session) => [session.sessionId, session]));
  const sessions = composers.map((composer) => {
    const transcript = transcriptsById.get(composer.sessionId);
    if (!transcript) return composer;
    transcriptsById.delete(composer.sessionId);
    return {
      ...composer,
      filePath: transcript.filePath,
      cwd: transcript.cwd || composer.cwd,
      model: composer.model || transcript.model,
      mtime: Math.max(composer.mtime, transcript.mtime),
      size: Math.max(composer.size, transcript.size),
      messages: composer.messages?.length ? composer.messages : transcript.messages,
    };
  });
  return sortSessions([...sessions, ...transcriptsById.values()]);
}

async function findCursorAgentTranscripts(workspacePath: string): Promise<LocalAgentSession[]> {
  const projectsRoot = path.join(os.homedir(), ".cursor", "projects");
  let projectEntries: import("fs").Dirent[];
  try { projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true }); }
  catch { return []; }

  const sessions: LocalAgentSession[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, projectEntry.name);
    const projectCwd = await cursorProjectCwd(projectDir, projectEntry.name, workspacePath);
    if (!projectCwd || !(await sameWorkspacePath(projectCwd, workspacePath))) continue;
    const transcriptsDir = path.join(projectDir, "agent-transcripts");
    const candidatesBySession = new Map<string, string[]>();
    for (const filePath of await cursorTranscriptFiles(transcriptsDir)) {
      const sessionId = cursorTranscriptId(filePath, transcriptsDir);
      if (!sessionId) continue;
      const candidates = candidatesBySession.get(sessionId) || [];
      candidates.push(filePath);
      candidatesBySession.set(sessionId, candidates);
    }
    for (const [sessionId, candidates] of candidatesBySession) {
      candidates.sort((left, right) => cursorTranscriptPreference(left) - cursorTranscriptPreference(right));
      for (const filePath of candidates) {
        const session = await cursorTranscriptSession(filePath, projectCwd, sessionId);
        if (!session) continue;
        sessions.push(session);
        break;
      }
    }
  }
  return sortSessions([...new Map(sessions.map((session) => [session.sessionId, session])).values()]);
}

async function cursorTranscriptFiles(transcriptsDir: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name === "subagents") continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 1) await visit(child, depth + 1);
      else if (entry.isFile() && /\.(jsonl|txt)$/i.test(entry.name)) files.push(child);
    }
  };
  await visit(transcriptsDir, 0);
  return files;
}

function cursorTranscriptId(filePath: string, transcriptsDir: string): string | undefined {
  const relative = path.relative(transcriptsDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const segments = relative.split(path.sep);
  const stem = path.basename(filePath).replace(/\.(jsonl|txt)$/i, "");
  const encoded = segments.length > 1 && (stem === segments[0] || stem === "transcript")
    ? segments[0]
    : stem;
  try {
    return decodeURIComponent(encoded.replace(/_/g, "%"));
  } catch {
    return encoded;
  }
}

function cursorTranscriptPreference(filePath: string): number {
  return filePath.toLowerCase().endsWith(".jsonl") ? 0 : 1;
}

async function cursorProjectCwd(projectDir: string, slug: string, workspacePath: string): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(projectDir, "repo.json"), "utf8")) as Record<string, unknown>;
    const explicit = firstString([metadata.workspace, metadata.rootPath, metadata.path]);
    if (explicit) return pathFromUriLike(explicit);
  } catch {}
  const normalizedSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const normalizedWorkspace = workspacePath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalizedSlug === normalizedWorkspace || normalizedSlug.endsWith(normalizedWorkspace)
    ? workspacePath
    : undefined;
}

async function cursorTranscriptSession(filePath: string, cwd: string, sessionId: string): Promise<LocalAgentSession | undefined> {
  try {
    const metadata = await fs.stat(filePath);
    const messages = await readCursorTranscriptMessages(filePath);
    let model: string | undefined;
    if (filePath.toLowerCase().endsWith(".jsonl")) {
      for (const record of (await readLines(filePath)).map(parseJson).filter(Boolean)) {
        if (!model && cursorTranscriptRole(record) === "assistant") {
          model = firstString([record?.model, record?.message?.model]);
        }
      }
    }
    if (!messages.length) return undefined;
    const firstUser = messages.find((message) => message.role === "user")?.content;
    return {
      provider: "cursor",
      runtime: "cursor-agent-tmux",
      sessionId,
      filePath,
      cwd,
      model,
      title: firstUser?.replace(/\s+/g, " ").trim().slice(0, 90) || `Cursor ${sessionId.slice(0, 8)}`,
      mtime: metadata.mtimeMs,
      size: metadata.size,
      messages: dedupeCursorTranscriptMessages(messages).slice(-1000),
    };
  } catch {
    return undefined;
  }
}

async function readCursorTranscriptMessages(filePath: string): Promise<LocalSessionMessage[]> {
  if (filePath.toLowerCase().endsWith(".txt")) {
    return parseCursorTextTranscript(await fs.readFile(filePath, "utf8"));
  }
  const messages: LocalSessionMessage[] = [];
  for (const line of await readLines(filePath)) {
    const message = cursorTranscriptMessage(parseJson(line));
    if (!message || isBootstrapContext(message.content)) continue;
    messages.push(message);
  }
  return dedupeCursorTranscriptMessages(messages).slice(-1000);
}

function parseCursorTextTranscript(content: string): LocalSessionMessage[] {
  const marker = /(?:^|\r?\n\r?\n)(user|assistant):\r?\n/g;
  const matches = [...content.matchAll(marker)];
  const messages: LocalSessionMessage[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index || 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const text = content.slice(start, end).trim();
    if (!text || isBootstrapContext(text)) continue;
    messages.push({ role: match[1] as "user" | "assistant", content: text });
  }
  return dedupeCursorTranscriptMessages(messages).slice(-1000);
}

function cursorTranscriptText(value: unknown, role: "user" | "assistant"): string | undefined {
  const text = cursorTranscriptTextParts(value).join("\n");
  if (!text) return undefined;
  if (role === "user") {
    const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)].map((match) => match[1].trim()).filter(Boolean);
    if (queries.length) return queries.join("\n");
  }
  return text.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "").trim();
}

function cursorTranscriptTextParts(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => cursorTranscriptTextParts(item, depth + 1));
  const record = objectValue(value);
  if (!record) return [];
  const type = String(record.type || record.kind || "").toLowerCase();
  const textual = !type || ["text", "input_text", "output_text", "user_query", "markdown", "plain_text"].includes(type);
  if (textual && typeof record.text === "string" && record.text.trim()) return [record.text];
  const container = !type || ["message", "content", "parts", "user", "assistant", "user_message", "assistant_message"].includes(type);
  if (!textual && !container) return [];
  for (const key of ["content", "message", "userQuery", "user_query", "query", "prompt"]) {
    const nested = cursorTranscriptTextParts(record[key], depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function cursorTranscriptRole(record: any): "user" | "assistant" | undefined {
  return messageRole(record?.role ?? record?.message?.role ?? record?.author ?? record?.speaker)
    || messageRole(record?.type ?? record?.kind ?? record?.message?.type);
}

async function findCursorComposerSessions(workspacePath: string): Promise<LocalAgentSession[]> {
  const roots = await cursorUserDirectories();
  const sessions: LocalAgentSession[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const source of await cursorStateSources(root, workspacePath)) {
      try {
        const stat = await fs.stat(source.dbPath);
        const rows = await readCursorRows(source.dbPath);
        for (const session of await cursorSessionsFromRows(rows, source, workspacePath, stat.mtimeMs, stat.size)) {
          if (seen.has(session.sessionId)) continue;
          seen.add(session.sessionId);
          sessions.push(session);
        }
      } catch {}
    }
  }
  return sessions;
}

type CursorStateSource = { dbPath: string; workspacePath?: string };
type CursorRow = { key: string; value: unknown };
type CursorComposer = {
  id: string;
  header?: Record<string, unknown>;
  data?: Record<string, unknown>;
  bubbles: Array<{ id: string; value: unknown }>;
};

async function cursorUserDirectories(): Promise<string[]> {
  const candidates = [
    process.env.CURSOR_USER_DIR,
    process.env.CURSOR_CHRONICLE_CURSOR_USER_DIR,
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Cursor", "User") : undefined,
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "Cursor", "User") : undefined,
    path.join(os.homedir(), ".config", "Cursor", "User"),
  ].filter((item): item is string => !!item);
  const existing: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) existing.push(candidate);
    } catch {}
  }
  return existing;
}

async function cursorStateSources(userDir: string, workspacePath: string): Promise<CursorStateSource[]> {
  const sources: CursorStateSource[] = [];
  const globalDb = path.join(userDir, "globalStorage", "state.vscdb");
  try {
    if ((await fs.stat(globalDb)).isFile()) sources.push({ dbPath: globalDb });
  } catch {}

  const storageRoot = path.join(userDir, "workspaceStorage");
  let entries: import("fs").Dirent[];
  try { entries = await fs.readdir(storageRoot, { withFileTypes: true }); }
  catch { return sources; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(storageRoot, entry.name);
    const workspaceInfo = await readCursorWorkspaceInfo(path.join(workspaceDir, "workspace.json"));
    if (workspaceInfo && !(await relatedPath(workspaceInfo, workspacePath))) continue;
    const dbPath = path.join(workspaceDir, "state.vscdb");
    try {
      if ((await fs.stat(dbPath)).isFile()) sources.push({ dbPath, workspacePath: workspaceInfo });
    } catch {}
  }
  return sources;
}

async function readCursorWorkspaceInfo(filePath: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    return pathFromUriLike(firstString([data.folder, data.workspace, data.configuration]));
  } catch {
    return undefined;
  }
}

async function readCursorRows(dbPath: string): Promise<CursorRow[]> {
  const tables = await querySqlite<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ItemTable', 'cursorDiskKV')");
  const rows: CursorRow[] = [];
  for (const table of tables.map((item) => item.name).filter((name) => name === "ItemTable" || name === "cursorDiskKV")) {
    rows.push(...await querySqlite<CursorRow>(dbPath, `SELECT key, value FROM ${table} WHERE key = 'composer.composerHeaders' OR key = 'composer.composerData' OR key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'`));
  }
  const headerTable = await querySqlite<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders'");
  if (headerTable.length) {
    rows.push(...await querySqlite<CursorRow>(
      dbPath,
      "SELECT 'composerHeader:' || composerId AS key, value FROM composerHeaders WHERE COALESCE(isArchived, 0) = 0 AND COALESCE(isSubagent, 0) = 0",
    ));
  }
  return rows;
}

async function cursorSessionsFromRows(rows: CursorRow[], source: CursorStateSource, workspacePath: string, mtime: number, size: number): Promise<LocalAgentSession[]> {
  const composers = new Map<string, CursorComposer>();
  const addComposer = (id: string): CursorComposer => {
    const existing = composers.get(id);
    if (existing) return existing;
    const created = { id, bubbles: [] };
    composers.set(id, created);
    return created;
  };

  for (const row of rows) {
    const value = parseCursorDbValue(row.value);
    if (row.key === "composer.composerHeaders" || row.key === "composer.composerData") {
      for (const item of collectCursorComposerRecords(value)) {
        const id = cursorComposerId(item);
        if (!id) continue;
        const composer = addComposer(id);
        if (row.key === "composer.composerHeaders") composer.header = { ...(composer.header || {}), ...item };
        else composer.data = { ...(composer.data || {}), ...item };
      }
    } else if (row.key.startsWith("composerHeader:")) {
      const id = row.key.slice("composerHeader:".length);
      const header = objectValue(value);
      if (id && header) addComposer(id).header = { ...(addComposer(id).header || {}), ...header };
    } else if (row.key.startsWith("composerData:")) {
      const id = row.key.slice("composerData:".length);
      const data = objectValue(value);
      if (id && data) addComposer(id).data = { ...(addComposer(id).data || {}), ...data };
    } else if (row.key.startsWith("bubbleId:")) {
      const [, composerId, bubbleId] = row.key.split(":");
      if (composerId && bubbleId) addComposer(composerId).bubbles.push({ id: bubbleId, value });
    }
  }

  const sessions: LocalAgentSession[] = [];
  for (const composer of composers.values()) {
    const metadata = { ...(composer.header || {}), ...(composer.data || {}) };
    if (!cursorComposerIsVisible(metadata)) continue;
    if (metadata.unifiedMode && metadata.unifiedMode !== "agent") continue;
    const metadataWorkspace = cursorWorkspacePath(metadata);
    if (source.workspacePath && !(await sameWorkspacePath(source.workspacePath, workspacePath))) continue;
    if (metadataWorkspace && !(await sameWorkspacePath(metadataWorkspace, workspacePath))) continue;
    if (!source.workspacePath && !metadataWorkspace) continue;
    const messages = cursorMessages(composer);
    if (!cursorComposerHasActivity(metadata, messages)) continue;
    const title = cursorTitle(metadata, messages, composer.id);
    sessions.push({
      provider: "cursor",
      runtime: "cursor-agent-tmux",
      sessionId: composer.id,
      stateDbPath: source.dbPath,
      cwd: metadataWorkspace || source.workspacePath || workspacePath,
      model: cursorModel(metadata),
      title,
      mtime: cursorTimestamp(metadata) || mtime,
      size,
      messages,
    });
  }
  return sessions;
}

function collectCursorComposerRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (!value || depth > 7) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectCursorComposerRecords(item, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const id = cursorComposerId(record);
  const records = id ? [record] : [];
  for (const child of Object.values(record)) {
    records.push(...collectCursorComposerRecords(child, depth + 1));
  }
  return records;
}

function cursorComposerId(record: Record<string, unknown>): string | undefined {
  const explicit = firstString([record.composerId, record.conversationId, record.sessionId]);
  if (explicit) return explicit;
  const looksLikeHeader = [
    record.name,
    record.title,
    record.conversationTitle,
    record.workspaceId,
    record.workspacePath,
    record.fullConversationHeadersOnly,
  ].some((value) => value !== undefined && value !== null);
  return looksLikeHeader ? firstString([record.id]) : undefined;
}

function cursorComposerIsVisible(metadata: Record<string, unknown>): boolean {
  const enabled = (value: unknown) => value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
  if (enabled(metadata.isArchived) || enabled(metadata.archived)) return false;
  if (enabled(metadata.isDeleted) || enabled(metadata.deleted) || metadata.deletedAt) return false;
  return !["archived", "deleted", "removed"].includes(String(metadata.status || "").toLowerCase());
}

function cursorComposerHasActivity(metadata: Record<string, unknown>, messages: LocalSessionMessage[]): boolean {
  if (messages.length > 0) return true;
  if (firstString([metadata.name, metadata.title, metadata.conversationTitle, metadata.subtitle])) return true;
  const createdAt = cursorTimestampValue(metadata.createdAt);
  const updatedAt = cursorTimestampValue(metadata.lastUpdatedAt ?? metadata.updatedAt);
  return updatedAt !== undefined && (createdAt === undefined || updatedAt > createdAt);
}

function cursorMessages(composer: CursorComposer): LocalSessionMessage[] {
  const byId = new Map(composer.bubbles.map((bubble) => [bubble.id, bubble.value]));
  const orderedIds = cursorBubbleOrder(composer.header).concat(cursorBubbleOrder(composer.data)).filter((id, index, all) => all.indexOf(id) === index);
  const values = orderedIds.length
    ? orderedIds.map((id) => ({ id, value: byId.get(id) })).filter((item) => item.value !== undefined)
    : composer.bubbles.map((bubble) => ({ id: bubble.id, value: bubble.value }));
  return dedupeCursorTranscriptMessages(
    values.map(({ id, value }) => cursorMessage(value, id)).filter((item): item is LocalSessionMessage => !!item && !isBootstrapContext(item.content)),
  ).slice(-1000);
}

function cursorBubbleOrder(value: unknown): string[] {
  const record = objectValue(value);
  if (!record) return [];
  return collectBubbleIds(record.fullConversationHeadersOnly || record.conversation || record.bubbles || record.messages);
}

function collectBubbleIds(value: unknown, depth = 0): string[] {
  if (!value || depth > 6) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectBubbleIds(item, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const id = firstString([record.bubbleId, record.id]);
  return [...(id ? [id] : []), ...Object.values(record).flatMap((item) => collectBubbleIds(item, depth + 1))];
}

function cursorMessage(value: unknown, sourceId?: string): LocalSessionMessage | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const role = cursorRole(record);
  if (!role) return undefined;
  const content = textContent(record.text ?? record.content ?? record.markdown ?? record.message)?.trim();
  if (!content) return undefined;
  return {
    role,
    content,
    createdAt: cursorDate(record.createdAt ?? record.timestamp ?? record.time),
    sourceId,
    turnId: firstString([record.chatdevTurnId, record.requestId, record.generationUUID, record.chatGenerationUUID, record.runtimeTurnId]),
    originKey: firstString([record.chatdevSourceKey]),
  };
}

function cursorRole(record: Record<string, unknown>): "user" | "assistant" | undefined {
  const role = messageRole(record.role || record.typeName || record.kind);
  if (role) return role;
  if (record.type === 1 || record.type === "1" || record.type === "user") return "user";
  if (record.type === 2 || record.type === "2" || record.type === "assistant" || record.type === "ai") return "assistant";
  return undefined;
}

function cursorTitle(metadata: Record<string, unknown>, messages: LocalSessionMessage[], id: string): string {
  const named = firstString([metadata.name, metadata.title, metadata.conversationTitle]);
  if (named) return named.replace(/\s+/g, " ").trim().slice(0, 90);
  const firstUser = messages.find((message) => message.role === "user")?.content;
  if (firstUser) return firstUser.replace(/\s+/g, " ").trim().slice(0, 90);
  return `Cursor ${id.slice(0, 8)}`;
}

function cursorModel(metadata: Record<string, unknown>): string | undefined {
  const model = firstString([
    metadata.model,
    metadata.modelName,
    metadata.aiModel,
    findNestedString(metadata.modelConfig, ["modelName", "modelId", "id", "name"]),
    findNestedString(metadata.requestedModel, ["modelId", "modelName", "id", "name"]),
  ]);
  return model === "chat.dev" ? undefined : model;
}

function cursorWorkspacePath(metadata: Record<string, unknown>): string | undefined {
  const direct = firstString([
    metadata.workspacePath,
    metadata.workspace,
    metadata.cwd,
    findNestedString(metadata.workspaceIdentifier, ["fsPath", "path", "folder", "workspace"]),
  ]);
  return pathFromUriLike(direct);
}

function cursorTimestamp(metadata: Record<string, unknown>): number | undefined {
  for (const key of ["lastUpdatedAt", "updatedAt", "createdAt", "timestamp"]) {
    const timestamp = cursorTimestampValue(metadata[key]);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function cursorTimestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return normalizeTimestamp(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return normalizeTimestamp(parsed);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return undefined;
}

function cursorDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(normalizeTimestamp(value)).toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    const date = Number.isFinite(parsed) ? normalizeTimestamp(parsed) : Date.parse(value);
    if (Number.isFinite(date)) return new Date(date).toISOString();
  }
  return null;
}

function normalizeTimestamp(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function pathFromUriLike(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const uri = vscode.Uri.parse(value);
    if (uri.scheme === "file") return uri.fsPath;
  } catch {}
  return value;
}

function parseCursorDbValue(value: unknown): unknown {
  let current = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value;
  for (let index = 0; index < 2; index++) {
    if (typeof current !== "string") break;
    const trimmed = current.trim();
    if (!trimmed || !/^[\[{"]/.test(trimmed)) break;
    try { current = JSON.parse(trimmed); }
    catch { break; }
  }
  return current;
}

function codexMetadata(records: any[], filePath: string): { sessionId?: string; cwd?: string; model?: string } {
  const sessionMeta = records.find((item) => item?.type === "session_meta");
  const sessionPayload = objectValue(sessionMeta?.payload) || objectValue(sessionMeta);
  const turnContext = records.find((item) => item?.type === "turn_context");
  const turnPayload = objectValue(turnContext?.payload) || objectValue(turnContext);
  const sessionId = firstString([
    sessionPayload?.session_id,
    sessionPayload?.sessionId,
    findNestedString(records, ["session_id", "sessionId", "conversation_id", "conversationId"]),
    path.basename(filePath, ".jsonl").replace(/^rollout-/, ""),
  ]);
  const cwd = firstString([
    sessionPayload?.cwd,
    sessionPayload?.workspace,
    sessionPayload?.workspace_path,
    sessionPayload?.workspacePath,
    turnPayload?.cwd,
    turnPayload?.workspace,
    turnPayload?.workspace_path,
    turnPayload?.workspacePath,
  ]);
  const model = firstString([
    turnPayload?.model,
    findNestedString(records, ["model"]),
  ]);
  return { sessionId, cwd, model };
}

async function findClaudeSessions(workspacePath: string): Promise<LocalAgentSession[]> {
  const roots = [
    path.join(os.homedir(), ".claude", "projects"),
    ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(process.env.CLAUDE_CONFIG_DIR, "projects")] : []),
  ];
  const files = (await Promise.all(roots.map(jsonlFiles))).flat();
  const sessions: LocalAgentSession[] = [];
  for (const filePath of [...new Set(files)]) {
    try {
      const stat = await fs.stat(filePath);
      const lines = await readLines(filePath);
      const records = lines.map(parseJson).filter(Boolean);
      const record = records.find((item) => item?.sessionId && item?.cwd);
      const sessionId = String(record?.sessionId || path.basename(filePath, ".jsonl"));
      const cwd = String(record?.cwd || "");
      if (!cwd || !(await relatedPath(cwd, workspacePath))) continue;
      const model = records.find((item) => typeof item?.message?.model === "string")?.message?.model;
      sessions.push({
        provider: "claude",
        runtime: "claude-code-tmux",
        sessionId,
        filePath,
        cwd,
        model: typeof model === "string" ? model : undefined,
        title: firstUserText(lines) || `Claude ${sessionId.slice(0, 8)}`,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {}
  }
  return sessions;
}

async function jsonlFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(child);
    }));
  }
  await visit(root);
  return results;
}

async function readLines(filePath: string): Promise<string[]> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= SESSION_SCAN_BYTES) {
      const buffer = Buffer.alloc(stat.size);
      await handle.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    }
    const head = Buffer.alloc(SESSION_SCAN_BYTES);
    const tail = Buffer.alloc(SESSION_SCAN_BYTES);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, Math.max(0, stat.size - tail.length));
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`.split(/\r?\n/).filter(Boolean);
  } finally {
    await handle.close();
  }
}

function parseJson(line: string): any | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

function firstUserText(lines: string[]): string | undefined {
  for (const line of lines) {
    const record = parseJson(line);
    const payload = record?.payload;
    const candidates = [
      payload?.userMessage,
      payload?.type === "user_message" ? payload?.message : undefined,
      payload?.role === "user" ? payload?.content : undefined,
      payload?.message?.content,
      record?.message?.content,
    ];
    for (const candidate of candidates) {
      const text = textContent(candidate);
      if (text && !isBootstrapContext(text)) {
        return text.replace(/\s+/g, " ").trim().slice(0, 90);
      }
    }
  }
  return undefined;
}

function codexMessage(record: any): LocalSessionMessage | undefined {
  const payload = record?.payload ?? record;
  const role = messageRole(payload?.role || payload?.message?.role || record?.message?.role);
  if (payload?.type === "user_message") return messageFrom("user", payload?.message ?? payload?.content, record);
  if (payload?.type === "assistant_message") return messageFrom("assistant", payload?.message ?? payload?.content, record);
  if (payload?.type === "message" && role) return messageFrom(role, payload?.content ?? payload?.message?.content, record);
  if (record?.type === "response_item" && payload?.type === "message" && role) return messageFrom(role, payload?.content, record);
  if (record?.type === "message" && role) return messageFrom(role, record?.content ?? record?.message?.content, record);
  return undefined;
}

function claudeMessage(record: any): LocalSessionMessage | undefined {
  const role = messageRole(record?.message?.role || record?.role || record?.type);
  if (!role) return undefined;
  return messageFrom(role, record?.message?.content ?? record?.content, record);
}

function copilotMessage(record: any): LocalSessionMessage | undefined {
  const role = record?.type === "user.message"
    ? "user"
    : record?.type === "assistant.message"
      ? "assistant"
      : undefined;
  const content = typeof record?.data?.content === "string" ? record.data.content.trim() : "";
  if (!role || !content) return undefined;
  return {
    role,
    content,
    createdAt: typeof record?.timestamp === "string" ? record.timestamp : null,
    sourceId: typeof record?.id === "string" ? `copilot:${record.id}` : undefined,
    turnId: firstString([record?.data?.interactionId, record?.data?.turnId]),
    originKey: typeof record?.id === "string" ? `copilot:${record.id}` : undefined,
  };
}

function cursorTranscriptMessage(record: any): LocalSessionMessage | undefined {
  const role = cursorTranscriptRole(record);
  if (!role) return undefined;
  const content = cursorTranscriptText(
    record?.message?.content
      ?? record?.content
      ?? record?.userQuery
      ?? record?.user_query
      ?? record?.query
      ?? record?.prompt,
    role,
  )?.trim();
  if (!content) return undefined;
  return {
    role,
    content,
    createdAt: cursorDate(record?.timestamp ?? record?.createdAt ?? record?.message?.timestamp ?? record?.message?.createdAt),
  };
}

function messageRole(value: unknown): "user" | "assistant" | undefined {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["user", "human", "user_message", "user-message"].includes(role)) return "user";
  if (["assistant", "agent", "ai", "assistant_message", "assistant-message"].includes(role)) return "assistant";
  return undefined;
}

function messageFrom(role: "user" | "assistant", value: unknown, record: any): LocalSessionMessage | undefined {
  const content = textContent(value)?.replace(/\s+\n/g, "\n").trim();
  if (!content) return undefined;
  return {
    role,
    content,
    createdAt: typeof record?.timestamp === "string" ? record.timestamp : typeof record?.created_at === "string" ? record.created_at : null,
  };
}

function isBootstrapContext(text: string): boolean {
  const trimmed = text.trim();
  return /^# AGENTS\.md instructions|^<environment_context>/i.test(trimmed);
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => textContent(item) || "").join(" ").trim();
    return text || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "value", "input_text", "output_text"]) {
      const field = record[key];
      if (typeof field === "string" && field.trim()) return field;
      if (Array.isArray(field)) {
        const text = textContent(field);
        if (text) return text;
      }
    }
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function findNestedString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (!value || depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const found = findNestedString(item, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function relatedPath(left: string, right: string): Promise<boolean> {
  const canonicalLeft = await canonicalPath(left);
  const canonicalRight = await canonicalPath(right);
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const a = normalize(canonicalLeft);
  const b = normalize(canonicalRight);
  return a === b || isChildPath(a, b) || isChildPath(b, a);
}

async function sameWorkspacePath(left: string, right: string): Promise<boolean> {
  const canonicalLeft = await canonicalPath(left);
  const canonicalRight = await canonicalPath(right);
  return process.platform === "win32"
    ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
    : canonicalLeft === canonicalRight;
}

function isChildPath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function canonicalPath(value: string): Promise<string> {
  try { return path.resolve(await fs.realpath(value)); }
  catch { return path.resolve(value); }
}
