import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";
import type { Socket } from "socket.io-client";
import { ChatDevApi } from "./api";
import { forgetAgentSessionSyncs } from "./session-sync";

const STORAGE_KEY = "chatdev.workspaceMirrors";
const active = new Map<string, WorkspaceMirror>();

type StoredMirror = {
  serverUrl: string;
  agentId: string;
  workspacePath: string;
};

type RpcResult = { ok: boolean; error?: string; [key: string]: unknown };

export async function startWorkspaceMirror(api: ChatDevApi, agentId: string, workspace: vscode.Uri): Promise<void> {
  if (workspace.scheme !== "file") return;
  const workspacePath = path.resolve(workspace.fsPath);
  const key = mirrorKey(api.serverUrl, workspacePath);
  const previous = active.get(key);
  if (previous?.agentId === agentId) return;
  previous?.dispose();
  const mirror = new WorkspaceMirror(api, agentId, workspace);
  active.set(key, mirror);
  await rememberMirror(api, agentId, workspacePath);
  await mirror.start();
}

export async function restoreWorkspaceMirrors(api: ChatDevApi): Promise<void> {
  if (!(await api.isSignedIn())) return;
  const folders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "file");
  const openPaths = new Set(folders.map((folder) => path.resolve(folder.uri.fsPath)));
  for (const [key, mirror] of active) {
    if (mirror.serverUrl !== api.serverUrl || !openPaths.has(mirror.workspacePath)) {
      mirror.dispose();
      active.delete(key);
    }
  }
  const stored = api.globalState.get<StoredMirror[]>(STORAGE_KEY, []);
  for (const folder of folders) {
    const workspacePath = path.resolve(folder.uri.fsPath);
    const match = stored.find((item) => item.serverUrl === api.serverUrl && path.resolve(item.workspacePath) === workspacePath);
    if (!match) continue;
    try {
      const agent = await api.getAgent(match.agentId);
      if (agent.status === "deleted") throw notFoundError();
      await startWorkspaceMirror(api, match.agentId, folder.uri);
    } catch (error) {
      if (!isNotFoundError(error)) continue;
      await forgetMirror(api, match);
      await forgetAgentSessionSyncs(api, match.agentId);
      if (vscode.window.state.focused) {
        void vscode.window.showWarningMessage(
          `${folder.name} is no longer connected because its chat.dev agent was deleted. Your local files are unchanged.`,
          "Start New Agent",
        ).then((choice) => {
          if (choice === "Start New Agent") void vscode.commands.executeCommand("chatdev.moveSession");
        });
      }
    }
  }
}

export function currentMirroredAgentId(serverUrl?: string): string | undefined {
  const paths = new Set((vscode.workspace.workspaceFolders || [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => path.resolve(folder.uri.fsPath)));
  for (const mirror of active.values()) {
    if ((!serverUrl || mirror.serverUrl === serverUrl) && paths.has(mirror.workspacePath)) return mirror.agentId;
  }
  return undefined;
}

export function disposeWorkspaceMirrors(): void {
  for (const mirror of active.values()) mirror.dispose();
  active.clear();
}

class WorkspaceMirror implements vscode.Disposable {
  readonly workspacePath: string;
  readonly serverUrl: string;
  private socket: Socket | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private documentSubscription: vscode.Disposable | undefined;
  private readonly documentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly suppressed = new Map<string, SuppressedRemoteWrite>();
  private readonly locallyPushed = new Map<string, { hash: string; until: number }>();
  private readonly pathQueues = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly api: ChatDevApi,
    readonly agentId: string,
    private readonly root: vscode.Uri,
  ) {
    this.workspacePath = path.resolve(root.fsPath);
    this.serverUrl = api.serverUrl;
  }

  async start(): Promise<void> {
    this.socket = await this.api.connectSocket();
    this.socket.on("fs_change", ({ agentId, paths, originSocketId }: { agentId: string; paths?: string[]; originSocketId?: string }) => {
      if (agentId !== this.agentId) return;
      if (originSocketId && originSocketId === this.socket?.id) return;
      for (const remotePath of paths || []) {
        if (!remotePath || this.ignored(remotePath)) continue;
        this.enqueue(remotePath, () => this.pullRemotePath(remotePath));
      }
    });
    this.socket.on("connect", () => this.socket?.emit("join", { agentId: this.agentId }));
    this.socket.emit("join", { agentId: this.agentId });

    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root.fsPath, "**/*"));
    this.watcher.onDidCreate((uri) => this.onLocalChange(uri, false));
    this.watcher.onDidChange((uri) => this.onLocalChange(uri, false));
    this.watcher.onDidDelete((uri) => this.onLocalChange(uri, true));
    this.documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      this.onLocalDocumentChange(event.document);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.documentSubscription?.dispose();
    this.documentSubscription = undefined;
    for (const timer of this.documentTimers.values()) clearTimeout(timer);
    this.documentTimers.clear();
    this.socket?.disconnect();
    this.socket = undefined;
    this.pathQueues.clear();
    this.suppressed.clear();
    this.locallyPushed.clear();
  }

  private onLocalChange(uri: vscode.Uri, deleted: boolean): void {
    const relativePath = this.relativePath(uri);
    if (!relativePath || this.ignored(relativePath)) return;
    this.enqueue(relativePath, async () => {
      if (await this.matchesRemoteWrite(relativePath, uri, deleted)) return;
      if (deleted) await this.deleteRemotePath(relativePath);
      else await this.pushLocalPath(relativePath, uri);
    });
  }

  private onLocalDocumentChange(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file" || document.isClosed) return;
    const relativePath = this.relativePath(document.uri);
    if (!relativePath || this.ignored(relativePath)) return;
    const contents = Buffer.from(document.getText(), "utf8");
    const expected = this.suppressed.get(relativePath);
    if (expected?.kind === "file" && expected.until > Date.now() && expected.hash === hash(contents)) return;
    const previous = this.documentTimers.get(relativePath);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.documentTimers.delete(relativePath);
      this.enqueue(relativePath, () => this.pushLocalDocument(relativePath, document));
    }, 120);
    this.documentTimers.set(relativePath, timer);
  }

  private enqueue(relativePath: string, operation: () => Promise<void>): void {
    const previous = this.pathQueues.get(relativePath) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation).catch((error) => {
      console.warn(`[chat.dev] workspace mirror failed for ${relativePath}:`, error);
    }).finally(() => {
      if (this.pathQueues.get(relativePath) === next) this.pathQueues.delete(relativePath);
    });
    this.pathQueues.set(relativePath, next);
  }

  private async pushLocalPath(relativePath: string, uri: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    let metadata: vscode.FileStat;
    try { metadata = await vscode.workspace.fs.stat(uri); }
    catch { return this.deleteRemotePath(relativePath); }
    if (metadata.type & vscode.FileType.Directory) {
      await this.rpc("create_dir", { path: relativePath });
      return;
    }
    if (!(metadata.type & vscode.FileType.File)) return;
    if (metadata.size > 5 * 1024 * 1024) {
      await this.api.uploadLocalFile(this.agentId, relativePath, uri.fsPath);
      return;
    }
    const data = await vscode.workspace.fs.readFile(uri);
    if (this.wasJustPushed(relativePath, data)) return;
    await this.rpc("write_file", { path: relativePath, dataBase64: Buffer.from(data).toString("base64") });
    this.rememberLocalPush(relativePath, data);
  }

  private async pushLocalDocument(relativePath: string, document: vscode.TextDocument): Promise<void> {
    if (this.disposed || document.isClosed) return;
    const data = Buffer.from(document.getText(), "utf8");
    if (data.byteLength > 5 * 1024 * 1024 || this.wasJustPushed(relativePath, data)) return;
    const expected = this.suppressed.get(relativePath);
    if (expected?.kind === "file" && expected.until > Date.now() && expected.hash === hash(data)) return;
    await this.rpc("write_file", { path: relativePath, dataBase64: data.toString("base64") });
    this.rememberLocalPush(relativePath, data);
  }

  private async deleteRemotePath(relativePath: string): Promise<void> {
    const result = await this.rpc("delete_path", { path: relativePath, recursive: true }, true);
    if (!result.ok && !/not found|no such file/i.test(String(result.error || ""))) {
      throw new Error(String(result.error || "Could not delete remote path"));
    }
  }

  private async pullRemotePath(relativePath: string): Promise<void> {
    if (this.disposed) return;
    const uri = vscode.Uri.joinPath(this.root, ...relativePath.split("/"));
    const stat = await this.rpc("stat_path", { path: relativePath }, true);
    if (!stat.ok) {
      if (/not found|no such file/i.test(String(stat.error || ""))) {
        this.suppressed.set(relativePath, { kind: "deleted", until: Date.now() + 3_000 });
        try { await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }); } catch {}
        return;
      }
      throw new Error(String(stat.error || "Could not inspect remote path"));
    }
    if (stat.type === "directory") {
      this.suppressed.set(relativePath, { kind: "directory", until: Date.now() + 3_000 });
      await vscode.workspace.fs.createDirectory(uri);
      return;
    }
    const file = await this.rpc("read_file", { path: relativePath });
    const contents = Buffer.from(String(file.dataBase64 || ""), "base64");
    const pushed = this.locallyPushed.get(relativePath);
    if (pushed && pushed.until > Date.now() && pushed.hash === hash(contents)) {
      this.locallyPushed.delete(relativePath);
      return;
    }
    this.suppressed.set(relativePath, { kind: "file", hash: hash(contents), until: Date.now() + 3_000 });
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (openDocument) {
      const nextText = contents.toString("utf8");
      if (openDocument.getText() !== nextText) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length)), nextText);
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error("Could not apply the remote editor change locally");
      }
      if (openDocument.isDirty) await openDocument.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, contents);
    }
  }

  private rememberLocalPush(relativePath: string, value: Uint8Array): void {
    this.locallyPushed.set(relativePath, { hash: hash(value), until: Date.now() + 2_000 });
  }

  private wasJustPushed(relativePath: string, value: Uint8Array): boolean {
    const pushed = this.locallyPushed.get(relativePath);
    if (!pushed) return false;
    if (pushed.until <= Date.now()) {
      this.locallyPushed.delete(relativePath);
      return false;
    }
    return pushed.hash === hash(value);
  }

  private async matchesRemoteWrite(relativePath: string, uri: vscode.Uri, deleted: boolean): Promise<boolean> {
    const expected = this.suppressed.get(relativePath);
    if (!expected) return false;
    if (expected.until <= Date.now()) {
      this.suppressed.delete(relativePath);
      return false;
    }
    if (deleted) return expected.kind === "deleted";
    if (expected.kind === "deleted") return false;
    try {
      const metadata = await vscode.workspace.fs.stat(uri);
      if (metadata.type & vscode.FileType.Directory) return expected.kind === "directory";
      if (!(metadata.type & vscode.FileType.File) || expected.kind !== "file") return false;
      return hash(await vscode.workspace.fs.readFile(uri)) === expected.hash;
    } catch {
      return false;
    }
  }

  private async rpc(event: string, payload: Record<string, unknown>, allowError = false): Promise<RpcResult> {
    const socket = this.socket;
    if (!socket?.connected) throw new Error("chat.dev workspace mirror is reconnecting");
    const result = await new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`chat.dev ${event} timed out`)), 120_000);
      socket.emit(event, { agentId: this.agentId, ...payload }, (response: RpcResult) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
    if (!allowError && !result.ok) throw new Error(String(result.error || `chat.dev ${event} failed`));
    return result;
  }

  private relativePath(uri: vscode.Uri): string {
    const value = path.relative(this.workspacePath, uri.fsPath).split(path.sep).join(path.posix.sep);
    return value.startsWith("../") || path.isAbsolute(value) ? "" : value;
  }

  private ignored(relativePath: string): boolean {
    const segments = relativePath.split(/[\\/]/).filter(Boolean);
    const configured = new Set(vscode.workspace.getConfiguration("chatdev").get<string[]>("uploadExcludes", []));
    return segments.some((segment) => segment === ".git" || segment === ".chatdev" || segment === "node_modules" || configured.has(segment));
  }
}

type SuppressedRemoteWrite =
  | { kind: "file"; hash: string; until: number }
  | { kind: "directory" | "deleted"; until: number };

function hash(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function rememberMirror(api: ChatDevApi, agentId: string, workspacePath: string): Promise<void> {
  const stored = api.globalState.get<StoredMirror[]>(STORAGE_KEY, []);
  const next = [
    { serverUrl: api.serverUrl, agentId, workspacePath },
    ...stored.filter((item) => !(item.serverUrl === api.serverUrl && path.resolve(item.workspacePath) === workspacePath)),
  ].slice(0, 20);
  await api.globalState.update(STORAGE_KEY, next);
}

async function forgetMirror(api: ChatDevApi, mirror: StoredMirror): Promise<void> {
  const key = mirrorKey(mirror.serverUrl, mirror.workspacePath);
  active.get(key)?.dispose();
  active.delete(key);
  const stored = api.globalState.get<StoredMirror[]>(STORAGE_KEY, []);
  await api.globalState.update(STORAGE_KEY, stored.filter((item) => !(
    item.serverUrl === mirror.serverUrl
    && item.agentId === mirror.agentId
    && path.resolve(item.workspacePath) === path.resolve(mirror.workspacePath)
  )));
}

function isNotFoundError(error: unknown): boolean {
  return (error as Error & { status?: number })?.status === 404;
}

function notFoundError(): Error {
  const error = new Error("Agent not found") as Error & { status?: number };
  error.status = 404;
  return error;
}

function mirrorKey(serverUrl: string, workspacePath: string): string {
  return `${serverUrl}:${path.resolve(workspacePath)}`;
}
