import * as path from "path";
import * as vscode from "vscode";
import type { Socket } from "socket.io-client";
import { ChatDevApi } from "./api";

type RpcResult = { ok: boolean; error?: string; [key: string]: unknown };

export class ChatDevFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private socket: Socket | undefined;
  private readonly joined = new Set<string>();
  private readonly displayRoots = new Map<string, Set<string>>();

  constructor(private readonly api: ChatDevApi) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const result = await this.rpc(uri, "stat_path", { path: remotePath(uri) });
    return {
      type: result.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: Number(result.ctime || 0),
      mtime: Number(result.mtime || 0),
      size: Number(result.size || 0),
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const result = await this.rpc(uri, "list_dir", { path: remotePath(uri) });
    if (result.truncated) throw vscode.FileSystemError.Unavailable("Directory has too many entries to display.");
    return (result.entries as Array<{ name: string; type: string }>).map((entry) => [
      entry.name,
      entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.rpc(uri, "create_dir", { path: remotePath(uri) });
    this.fire(uri, vscode.FileChangeType.Created);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const result = await this.rpc(uri, "read_file", { path: remotePath(uri) });
    return Buffer.from(String(result.dataBase64 || ""), "base64");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    if (!options.create || !options.overwrite) {
      try {
        await this.stat(uri);
        if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      } catch (error) {
        if (!options.create && isNotFound(error)) throw vscode.FileSystemError.FileNotFound(uri);
        if (!isNotFound(error)) throw error;
      }
    }
    await this.rpc(uri, "write_file", { path: remotePath(uri), dataBase64: Buffer.from(content).toString("base64") });
    this.fire(uri, vscode.FileChangeType.Changed);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.rpc(uri, "delete_path", { path: remotePath(uri), recursive: options.recursive });
    this.fire(uri, vscode.FileChangeType.Deleted);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (agentIdFromUri(oldUri) !== agentIdFromUri(newUri)) throw vscode.FileSystemError.NoPermissions("Files cannot be moved between agents.");
    await this.rpc(oldUri, "rename_path", { oldPath: remotePath(oldUri), newPath: remotePath(newUri), overwrite: options.overwrite });
    this.changes.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  dispose(): void {
    this.socket?.disconnect();
    this.changes.dispose();
  }

  private async ensureSocket(agentId: string): Promise<Socket> {
    if (!this.socket?.connected) {
      this.socket?.disconnect();
      this.socket = await this.api.connectSocket();
      this.joined.clear();
      this.socket.on("connect", () => {
        for (const id of this.joined) this.socket?.emit("join", { agentId: id });
      });
      this.socket.on("fs_change", ({ agentId, paths }: { agentId: string; paths: string[] }) => {
        const events: vscode.FileChangeEvent[] = [];
        for (const changedPath of paths.length ? paths : [""]) {
          events.push({
            type: vscode.FileChangeType.Changed,
            uri: vscode.Uri.from({ scheme: "chatdev", authority: agentId, path: `/${changedPath}` }),
          });
          for (const root of this.displayRoots.get(agentId) || []) {
            events.push({
              type: vscode.FileChangeType.Changed,
              uri: vscode.Uri.from({ scheme: "chatdev", authority: root, path: path.posix.join("/", changedPath), query: new URLSearchParams({ agentId, root }).toString() }),
            });
          }
        }
        this.changes.fire(events);
      });
    }
    if (!this.joined.has(agentId)) {
      this.joined.add(agentId);
      this.socket.emit("join", { agentId });
    }
    return this.socket;
  }

  private async rpc(uri: vscode.Uri, event: string, payload: Record<string, unknown>): Promise<RpcResult> {
    const agentId = agentIdFromUri(uri);
    if (!agentId) throw vscode.FileSystemError.FileNotFound("Missing chat.dev agent ID.");
    const root = displayRoot(uri);
    if (root) {
      const roots = this.displayRoots.get(agentId) || new Set<string>();
      roots.add(root);
      this.displayRoots.set(agentId, roots);
    }
    const socket = await this.ensureSocket(agentId);
    const result = await new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(vscode.FileSystemError.Unavailable("chat.dev workspace request timed out.")), rpcTimeout(event));
      socket.emit(event, { agentId, ...payload }, (response: RpcResult) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
    if (!result.ok) throw fileSystemError(uri, String(result.error || "Remote workspace request failed."));
    return result;
  }

  private fire(uri: vscode.Uri, type: vscode.FileChangeType): void {
    this.changes.fire([{ type, uri }, { type: vscode.FileChangeType.Changed, uri: vscode.Uri.joinPath(uri, "..") }]);
  }
}

function agentIdFromUri(uri: vscode.Uri): string {
  return new URLSearchParams(uri.query).get("agentId") || uri.authority.split("+")[0] || "";
}

function remotePath(uri: vscode.Uri): string {
  const normalized = path.posix.normalize(uri.path).replace(/^\/+/, "");
  if (normalized === ".." || normalized.startsWith("../")) throw vscode.FileSystemError.NoPermissions("Path leaves the agent workspace.");
  if (normalized === ".") return "";
  const root = displayRoot(uri);
  if (!root) return normalized;
  if (normalized === root) return "";
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

function displayRoot(uri: vscode.Uri): string | undefined {
  const root = new URLSearchParams(uri.query).get("root") || undefined;
  return root && /^[a-z0-9._-]{1,64}$/i.test(root) ? root : undefined;
}

function rpcTimeout(event: string): number {
  if (["write_file", "create_dir", "rename_path", "delete_path"].includes(event)) return 120_000;
  if (event === "read_file") return 60_000;
  return 30_000;
}

function fileSystemError(uri: vscode.Uri, message: string): vscode.FileSystemError {
  if (/agent not found|agent .*deleted/i.test(message)) {
    return vscode.FileSystemError.Unavailable("This chat.dev project was deleted. Close it and open another agent or a local folder.");
  }
  if (/not found|no such file/i.test(message)) return vscode.FileSystemError.FileNotFound(uri);
  if (/already exists/i.test(message)) return vscode.FileSystemError.FileExists(uri);
  if (/permission|refusing|outside workspace/i.test(message)) return vscode.FileSystemError.NoPermissions(message);
  return vscode.FileSystemError.Unavailable(message);
}

function isNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}
