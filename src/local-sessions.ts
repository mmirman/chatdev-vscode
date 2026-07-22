import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { dedupeCursorTranscriptMessages } from "./cursor-sync-identity";
import { querySqlite } from "./sqlite";

export type LocalAgentSession = {
  provider: "codex" | "claude" | "cursor";
  runtime: "codex-tmux" | "claude-code-tmux" | "cursor-agent-tmux";
  sessionId: string;
  filePath?: string;
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

export async function findLocalAgentSessions(workspace: vscode.Uri): Promise<LocalAgentSession[]> {
  if (workspace.scheme !== "file") return [];
  const workspacePath = await canonicalPath(workspace.fsPath);
  const [cursor, codex, claude] = await Promise.all([
    findCursorSessions(workspacePath),
    findCodexSessions(workspacePath),
    findClaudeSessions(workspacePath),
  ]);
  if (isCursorHost() && cursor.length) return sortSessions(cursor);
  return sortSessions([...cursor, ...codex, ...claude]);
}

function sortSessions(sessions: LocalAgentSession[]): LocalAgentSession[] {
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

function isCursorHost(): boolean {
  return /cursor/i.test(vscode.env.appName);
}

export async function readSession(session: LocalAgentSession): Promise<Uint8Array> {
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
  if (session.messages?.length) return session.messages.slice(-1000);
  if (!session.filePath) return [];
  if (session.provider === "cursor") return readCursorTranscriptMessages(session.filePath);
  const lines = (await fs.readFile(session.filePath, "utf8")).split(/\r?\n/).filter(Boolean);
  const messages: LocalSessionMessage[] = [];
  for (const line of lines) {
    const record = parseJson(line);
    const message = session.provider === "codex"
      ? codexMessage(record)
      : session.provider === "cursor"
        ? cursorTranscriptMessage(record)
        : claudeMessage(record);
    if (!message || !message.content || isBootstrapContext(message.content)) continue;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role && previous.content === message.content) continue;
    messages.push(message);
  }
  return messages.slice(-1000);
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
    for (const key of ["text", "content", "input_text", "output_text"]) {
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
