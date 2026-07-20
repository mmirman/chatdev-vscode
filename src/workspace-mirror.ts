import { createReadStream, type Dirent } from "fs";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { Socket } from "socket.io-client";
import { ChatDevApi } from "./api";
import { forgetAgentSessionSyncs } from "./session-sync";
import {
  type PendingRemoteWorkspaceChange,
  type PendingWorkspaceOperation,
  type PreparedLocalState,
  type RemoteWorkspaceChange,
  type RemoteWorkspaceEntry,
  WorkspaceSyncJournal,
} from "./workspace-sync-journal";
import {
  captureWorkspaceSourceManifest,
  INTERNAL_TEMP_PREFIX,
  ignoredWorkspacePath,
  PARTIAL_SUFFIX,
  SYNC_MANIFEST,
  SYNC_STATUS,
  type WorkspaceSourceManifest,
} from "./workspace-source-manifest";

const STORAGE_KEY = "chatdev.workspaceMirrors";
const CLIENT_ID_KEY = "chatdev.workspaceSyncClientId";
const SMALL_FILE_LIMIT = 1024 * 1024;
const TRANSFER_CHUNK_SIZE = 512 * 1024;
const MANIFEST_CHUNK_SIZE = 1_000;
const OUTBOX_CONCURRENCY = 3;
const CHANGE_POLL_MS = 2_000;
const RECONCILE_MS = 5 * 60_000;
const active = new Map<string, WorkspaceMirror>();

type StoredMirror = {
  serverUrl: string;
  agentId: string;
  workspacePath: string;
};

type StartOptions = {
  initialSync?: boolean;
  sourceManifest?: WorkspaceSourceManifest;
  report?: (message: string) => void | Promise<void>;
};

type RpcResult = {
  ok: boolean;
  error?: string;
  code?: string;
  generation?: string | null;
  revision?: string | null;
  [key: string]: unknown;
};

type SyncStatus = RpcResult & {
  generation: string | null;
  clientId: string | null;
  phase: "idle" | "syncing" | "live";
  cursor: number;
  manifest?: string | null;
  sourceManifestId?: string | null;
  sourceManifestSealed?: boolean;
};

type ManifestResult = {
  entries: Array<{ path: string } & RemoteWorkspaceEntry>;
  startCursor: number;
  headCursor: number;
};

export async function startWorkspaceMirror(
  api: ChatDevApi,
  agentId: string,
  workspace: vscode.Uri,
  options: StartOptions = {},
): Promise<void> {
  if (workspace.scheme !== "file") return;
  const workspacePath = path.resolve(workspace.fsPath);
  const key = mirrorKey(api.serverUrl, workspacePath);
  const previous = active.get(key);
  if (previous?.agentId === agentId) {
    if (options.initialSync) await previous.waitUntilReady();
    return;
  }
  previous?.dispose();
  const mirror = new WorkspaceMirror(api, agentId, workspace);
  active.set(key, mirror);
  await rememberMirror(api, agentId, workspacePath);
  try {
    await mirror.start(options);
  } catch (error) {
    if (active.get(key) === mirror) {
      mirror.dispose();
      active.delete(key);
    }
    throw error;
  }
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
  private journal!: WorkspaceSyncJournal;
  private watcher: vscode.FileSystemWatcher | undefined;
  private documentSubscription: vscode.Disposable | undefined;
  private readonly documentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private changePoller: ReturnType<typeof setInterval> | undefined;
  private reconcilePoller: ReturnType<typeof setInterval> | undefined;
  private readyPromise: Promise<void> | undefined;
  private outboxPromise: Promise<void> | undefined;
  private inboundPromise: Promise<void> | undefined;
  private remoteDrainPromise: Promise<void> | undefined;
  private reconnectPromise: Promise<void> | undefined;
  private reconciliationPromise: Promise<void> | undefined;
  private protocolReady = false;
  private remoteDrainEnabled = false;
  private disposed = false;
  private lastConflictNotice = 0;
  private readonly installedRemoteRevisions = new Map<string, { revision: string; expiresAt: number }>();
  private sourceManifest: WorkspaceSourceManifest | undefined;

  constructor(
    private readonly api: ChatDevApi,
    readonly agentId: string,
    private readonly root: vscode.Uri,
  ) {
    this.workspacePath = path.resolve(root.fsPath);
    this.serverUrl = api.serverUrl;
  }

  async start(options: StartOptions): Promise<void> {
    const storedClientId = this.api.globalState.get<string>(CLIENT_ID_KEY);
    const clientId = storedClientId || `client-${crypto.randomUUID()}`;
    if (!storedClientId) await this.api.globalState.update(CLIENT_ID_KEY, clientId);
    this.journal = await WorkspaceSyncJournal.open({
      storageDirectory: this.api.globalStoragePath,
      serverUrl: this.serverUrl,
      agentId: this.agentId,
      workspacePath: this.workspacePath,
      clientId,
    });
    this.sourceManifest = options.sourceManifest || this.journal.sourceManifest;
    if (options.sourceManifest && this.journal.sourceManifest?.manifestId !== options.sourceManifest.manifestId) {
      await this.journal.setSourceManifest(options.sourceManifest);
    }
    this.socket = await this.api.connectSocket();
    this.installSocketListeners();
    this.installLocalListeners();
    this.readyPromise = this.initializeWithRetry(options);
    if (options.initialSync) await this.readyPromise;
    else void this.readyPromise.catch((error) => console.warn("[chat.dev] workspace mirror initialization stopped:", error));
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise || Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.documentSubscription?.dispose();
    for (const timer of this.documentTimers.values()) clearTimeout(timer);
    this.documentTimers.clear();
    this.installedRemoteRevisions.clear();
    if (this.changePoller) clearInterval(this.changePoller);
    if (this.reconcilePoller) clearInterval(this.reconcilePoller);
    this.socket?.disconnect();
    this.socket = undefined;
  }

  private installSocketListeners(): void {
    this.socket!.on("fs_change", ({ agentId }: { agentId: string }) => {
      if (agentId === this.agentId) this.scheduleRemoteDrain();
    });
    this.socket!.on("connect", () => {
      this.socket?.emit("join", { agentId: this.agentId });
      if (this.protocolReady) this.scheduleReconnectRecovery();
    });
    this.socket!.emit("join", { agentId: this.agentId });
  }

  private installLocalListeners(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root.fsPath, "**/*"));
    this.watcher.onDidCreate((uri) => { void this.queueLocalUri(uri); });
    this.watcher.onDidChange((uri) => { void this.queueLocalUri(uri); });
    this.watcher.onDidDelete((uri) => { void this.queueLocalUri(uri); });
    this.documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      const relativePath = this.relativePath(event.document.uri);
      if (!relativePath || this.ignored(relativePath)) return;
      const previous = this.documentTimers.get(relativePath);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.documentTimers.delete(relativePath);
        const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === event.document.uri.toString());
        const inlineData = document && !document.isClosed ? Buffer.from(document.getText(), "utf8") : undefined;
        void this.queueLocalPath(relativePath, inlineData);
      }, 120);
      this.documentTimers.set(relativePath, timer);
    });
  }

  private async initializeWithRetry(options: StartOptions): Promise<void> {
    let attempt = 0;
    while (!this.disposed) {
      try {
        await this.initializeProtocol(options);
        return;
      } catch (error) {
        if (isGenerationConflict(error)) {
          throw error;
        }
        attempt += 1;
        await safeReport(options.report, `Project sync paused; retrying automatically (${errorMessage(error)})`);
        await delay(Math.min(15_000, 500 * (2 ** Math.min(attempt, 5))));
      }
    }
  }

  private async initializeProtocol(options: StartOptions): Promise<void> {
    const status = await this.rpc<SyncStatus>("workspace_sync_status", {});
    let activeStatus = status;
    let beganGeneration = false;
    if (!status.generation) {
      activeStatus = await this.beginGeneration();
      beganGeneration = true;
    } else if (status.generation !== this.journal.generation || status.clientId !== this.journal.clientId) {
      if (!options.initialSync) {
        throw syncError("workspace_sync_generation_conflict", "This project is connected to a newer editor sync. Continue the project again to move the connection here.");
      }
      await this.journal.setGeneration(`generation-${crypto.randomUUID()}`);
      activeStatus = await this.beginGeneration(status.generation);
      beganGeneration = true;
    } else if (options.sourceManifest
      && status.sourceManifestSealed
      && status.sourceManifestId !== options.sourceManifest.manifestId) {
      await this.journal.setGeneration(`generation-${crypto.randomUUID()}`);
      activeStatus = await this.beginGeneration(status.generation);
      beganGeneration = true;
    } else if (!status.sourceManifestSealed) {
      await this.journal.setGeneration(`generation-${crypto.randomUUID()}`);
      activeStatus = await this.beginGeneration(status.generation);
      beganGeneration = true;
    } else if (status.phase === "syncing") {
      await this.journal.markSyncing();
      activeStatus = await this.beginGeneration();
    } else if (this.journal.phase === "syncing") {
      await this.journal.markLive(status.cursor);
    }

    if (activeStatus.phase === "syncing" || beganGeneration || this.journal.phase === "syncing") {
      const sourceManifest = await this.ensureSourceManifest(options.report);
      await this.registerSourceManifest(activeStatus, sourceManifest, options.report);
      this.protocolReady = true;
      await this.performInitialSync(activeStatus.cursor, options.report);
    } else {
      this.protocolReady = true;
      this.remoteDrainEnabled = true;
      await this.reconcileRemoteManifest();
      await this.scanLocalWorkspace();
      this.scheduleOutbox();
      this.scheduleInbound();
      this.scheduleRemoteDrain();
    }
    this.startPollers();
  }

  private async ensureSourceManifest(report?: (message: string) => void | Promise<void>): Promise<WorkspaceSourceManifest> {
    if (this.sourceManifest) {
      if (this.journal.sourceManifest?.manifestId !== this.sourceManifest.manifestId) {
        await this.journal.setSourceManifest(this.sourceManifest);
      }
      return this.sourceManifest;
    }
    await safeReport(report, "Creating the complete project manifest before copying files");
    const manifest = await captureWorkspaceSourceManifest(this.workspacePath, configuredUploadExcludes());
    this.sourceManifest = manifest;
    await this.journal.setSourceManifest(manifest);
    return manifest;
  }

  private async registerSourceManifest(
    status: SyncStatus,
    manifest: WorkspaceSourceManifest,
    report?: (message: string) => void | Promise<void>,
  ): Promise<void> {
    if (status.sourceManifestSealed && status.sourceManifestId === manifest.manifestId) return;
    await safeReport(report, `Registering ${manifest.entryCount} project objects before copying files`);
    await this.rpc("workspace_sync_source_manifest_begin", {
      generation: this.journal.generation,
      clientId: this.journal.clientId,
      manifestId: manifest.manifestId,
      snapshotStartedAt: manifest.snapshotStartedAt,
      capturedAt: manifest.capturedAt,
      entryCount: manifest.entryCount,
      digest: manifest.digest,
    });
    for (let offset = 0; offset < manifest.entries.length; offset += MANIFEST_CHUNK_SIZE) {
      await this.rpc("workspace_sync_source_manifest_append", {
        generation: this.journal.generation,
        clientId: this.journal.clientId,
        manifestId: manifest.manifestId,
        offset,
        entries: manifest.entries.slice(offset, offset + MANIFEST_CHUNK_SIZE),
      });
    }
    await this.rpc("workspace_sync_source_manifest_seal", {
      generation: this.journal.generation,
      clientId: this.journal.clientId,
      manifestId: manifest.manifestId,
      entryCount: manifest.entryCount,
      digest: manifest.digest,
    });
  }

  private async beginGeneration(expectedGeneration?: string): Promise<SyncStatus> {
    return this.rpc<SyncStatus>("workspace_sync_begin", {
      generation: this.journal.generation,
      clientId: this.journal.clientId,
      ...(expectedGeneration ? { expectedGeneration } : {}),
    });
  }

  private startPollers(): void {
    if (!this.changePoller) {
      this.changePoller = setInterval(() => this.scheduleRemoteDrain(), CHANGE_POLL_MS);
      unrefTimer(this.changePoller);
    }
    if (!this.reconcilePoller) {
      this.reconcilePoller = setInterval(() => {
        void this.reconcileRemoteManifest().catch((error) => console.warn("[chat.dev] workspace reconciliation will retry:", error));
        void this.scanLocalWorkspace().then(() => this.scheduleOutbox()).catch((error) => console.warn("[chat.dev] local reconciliation will retry:", error));
      }, RECONCILE_MS);
      unrefTimer(this.reconcilePoller);
    }
  }

  private async performInitialSync(startCursor: number, report?: (message: string) => void | Promise<void>): Promise<void> {
    await safeReport(report, `Syncing project files as they are found; ${SYNC_STATUS} shows live progress on the chat.dev machine`);
    const manifestPromise = this.fetchRemoteManifest(startCursor);
    const scanPromise = this.scanLocalWorkspace(report);
    const manifest = await manifestPromise;
    if (this.journal.remoteManifestLoaded) await this.stageRemoteManifest(manifest);
    else await this.journal.replaceRemoteManifest(manifest.entries, manifest.startCursor);
    this.remoteDrainEnabled = true;
    this.scheduleOutbox();
    const seen = await scanPromise;

    const remoteOnly: RemoteWorkspaceChange[] = [];
    const pendingRemotePaths = new Set(this.journal.pendingRemoteChanges().map((change) => change.path));
    for (const entry of manifest.entries) {
      if (seen.has(entry.path)
        || this.ignored(entry.path)
        || this.journal.hasPending(entry.path)
        || this.journal.isManaged(entry.path)
        || pendingRemotePaths.has(entry.path)) continue;
      if (await this.localPathExists(entry.path)) continue;
      remoteOnly.push(changeFromEntry(entry));
    }
    if (remoteOnly.length) await this.journal.stageRemoteMaterializations(remoteOnly);
    this.scheduleInbound();
    await this.waitForOutbox();
    await this.waitForInbound();
    await this.flushRemoteChanges();

    await safeReport(report, "Checking for edits made while the project was syncing");
    await this.scanLocalWorkspace();
    await this.waitForOutbox();
    await this.waitForInbound();
    await this.flushRemoteChanges();
    await this.waitForOutbox();
    await this.waitForInbound();

    const completed = await this.rpc<SyncStatus>("workspace_sync_complete", {
      generation: this.journal.generation,
      clientId: this.journal.clientId,
      lastLocalVersion: this.journal.lastAppliedVersion,
      discoveredObjectCount: seen.size,
    });
    await this.journal.markLive(this.journal.remoteCursor);
    await safeReport(report, "Project files are synced; live mirroring is active");
  }

  private async fetchRemoteManifest(startCursor?: number): Promise<ManifestResult> {
    const initialStatus = startCursor == null
      ? await this.rpc<SyncStatus>("workspace_sync_status", {})
      : undefined;
    const cursor = startCursor ?? initialStatus!.cursor;
    const entries: Array<{ path: string } & RemoteWorkspaceEntry> = [];
    let afterPath = "";
    let headCursor = cursor;
    let first = true;
    while (!this.disposed) {
      const result = await this.rpc<RpcResult & {
        entries: Array<{ path: string } & RemoteWorkspaceEntry>;
        nextPath: string | null;
        done: boolean;
        cursor: number;
      }>("workspace_sync_manifest", { afterPath, limit: 2_000, reconcile: first });
      entries.push(...result.entries.filter((entry) => !this.ignored(entry.path)));
      headCursor = Math.max(headCursor, result.cursor);
      if (result.done || !result.nextPath) break;
      afterPath = result.nextPath;
      first = false;
    }
    return { entries, startCursor: cursor, headCursor };
  }

  private async reconcileRemoteManifest(): Promise<void> {
    if (this.reconciliationPromise) return this.reconciliationPromise;
    this.reconciliationPromise = this.performRemoteManifestReconciliation().finally(() => {
      this.reconciliationPromise = undefined;
    });
    return this.reconciliationPromise;
  }

  private async performRemoteManifestReconciliation(): Promise<void> {
    if (!this.protocolReady || this.disposed) return;
    const manifest = await this.fetchRemoteManifest();
    await this.stageRemoteManifest(manifest);
    this.scheduleInbound();
    this.scheduleRemoteDrain();
  }

  private async stageRemoteManifest(manifest: ManifestResult): Promise<void> {
    const previous = new Map(this.journal.effectiveRemoteEntries().map(({ path: entryPath, ...entry }) => [entryPath, entry]));
    const next = new Map(manifest.entries.map(({ path: entryPath, ...entry }) => [entryPath, entry]));
    const changes: RemoteWorkspaceChange[] = [];
    for (const entryPath of new Set([...previous.keys(), ...next.keys()])) {
      const before = previous.get(entryPath);
      const after = next.get(entryPath);
      if (before?.revision === after?.revision && before?.type === after?.type) continue;
      changes.push(after ? changeFromEntry({ path: entryPath, ...after }) : deletedChange(entryPath));
    }
    await this.journal.stageRemoteChanges(changes, manifest.startCursor);
  }

  private scheduleReconnectRecovery(): void {
    if (this.reconnectPromise || this.disposed) return;
    this.reconnectPromise = (async () => {
      try {
        const status = await this.rpc<SyncStatus>("workspace_sync_status", {});
        if (status.generation !== this.journal.generation || status.clientId !== this.journal.clientId) {
          throw syncError("workspace_sync_generation_conflict", "Another editor moved this project connection.");
        }
        await this.reconcileRemoteManifest();
        await this.scanLocalWorkspace();
        this.scheduleOutbox();
        this.scheduleInbound();
        this.scheduleRemoteDrain();
      } catch (error) {
        console.warn("[chat.dev] workspace reconnect recovery will retry:", error);
      } finally {
        this.reconnectPromise = undefined;
      }
    })();
  }

  private async scanLocalWorkspace(report?: (message: string) => void | Promise<void>): Promise<Set<string>> {
    const seen = new Set<string>();
    let itemCount = 0;
    const pending: Array<{ path: string; inlineData?: Uint8Array; sizeHint?: number }> = [];
    const flushPending = async (): Promise<void> => {
      if (!pending.length) return;
      await this.journal.enqueueMany(pending.splice(0));
      this.scheduleOutbox();
    };
    const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const subdirectories: Array<{ absolute: string; relative: string }> = [];
      for (const dirent of entries) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
        if (this.ignored(relativePath)) continue;
        const absolutePath = path.join(absoluteDirectory, dirent.name);
        let metadata: Awaited<ReturnType<typeof fs.lstat>>;
        try { metadata = await fs.lstat(absolutePath); } catch { continue; }
        if (metadata.isSymbolicLink() && !(await this.portableSymlink(absolutePath))) continue;
        if (!metadata.isDirectory() && !metadata.isFile() && !metadata.isSymbolicLink()) continue;
        seen.add(relativePath);
        itemCount += 1;
        const fingerprint = localStatFingerprint(metadata);
        const inlineData = metadata.isFile() ? this.dirtyDocumentData(relativePath) : undefined;
        if (!inlineData && this.journal.isManaged(relativePath) && this.journal.localFingerprint(relativePath) === fingerprint) {
          if (metadata.isDirectory()) subdirectories.push({ absolute: absolutePath, relative: relativePath });
          continue;
        }
        pending.push({ path: relativePath, ...(inlineData ? { inlineData } : {}), sizeHint: inlineData?.byteLength || metadata.size });
        if (pending.length >= 100) await flushPending();
        if (metadata.isDirectory()) subdirectories.push({ absolute: absolutePath, relative: relativePath });
      }
      if (report && (itemCount <= entries.length || itemCount % 250 < entries.length)) {
        await safeReport(report, `Syncing ${itemCount} project items; files already copied are ready to use`);
      }
      for (const directory of subdirectories) await visit(directory.absolute, directory.relative);
    };
    await visit(this.workspacePath, "");
    await flushPending();
    await this.journal.queueManagedDeletions(seen, (entryPath) => this.ignored(entryPath));
    this.scheduleOutbox();
    return seen;
  }

  private async queueLocalUri(uri: vscode.Uri): Promise<void> {
    const relativePath = this.relativePath(uri);
    if (!relativePath || this.ignored(relativePath)) return;
    await this.queueLocalPath(relativePath, this.openDocumentData(relativePath));
  }

  private async queueLocalPath(relativePath: string, inlineData?: Uint8Array): Promise<void> {
    if (this.disposed || !this.journal || this.ignored(relativePath)) return;
    const installed = this.installedRemoteRevisions.get(relativePath);
    if (installed) {
      if (installed.expiresAt > Date.now()) {
        const current = await this.snapshotLocalPath(relativePath, inlineData);
        if (current?.revision === installed.revision) return;
      }
      this.installedRemoteRevisions.delete(relativePath);
    }
    let sizeHint = inlineData?.byteLength || 0;
    if (!inlineData) {
      try { sizeHint = (await fs.lstat(this.absolutePath(relativePath))).size; } catch {}
    }
    await this.journal.enqueue({ path: relativePath, ...(inlineData ? { inlineData } : {}), sizeHint });
    this.scheduleOutbox();
  }

  private scheduleOutbox(): void {
    if (this.outboxPromise || this.disposed || !this.protocolReady) return;
    this.outboxPromise = this.runOutbox().finally(() => {
      this.outboxPromise = undefined;
      if (this.journal.nextReadyOperations(1).length) this.scheduleOutbox();
      this.scheduleInbound();
    });
  }

  private async runOutbox(): Promise<void> {
    while (!this.disposed) {
      const operations = this.journal.nextReadyOperations(OUTBOX_CONCURRENCY);
      if (!operations.length) return;
      await Promise.all(operations.map((operation) => this.processLocalOperation(operation)));
    }
  }

  private async processLocalOperation(operation: PendingWorkspaceOperation): Promise<void> {
    try {
      let prepared = operation.prepared || await this.prepareLocalOperation(operation);
      if (!prepared) {
        await this.journal.discard(operation.path, operation.version);
        return;
      }
      if (!operation.prepared) {
        const updated = await this.journal.markPrepared(operation.path, operation.version, prepared);
        if (!updated) return;
        operation = updated;
      }
      const inflight = await this.journal.markInflight(operation.path, operation.version);
      if (!inflight) return;
      prepared = inflight.prepared!;
      const payload = operationPayload(this.journal, inflight, prepared);
      let result: RpcResult;
      if (prepared.kind === "file") {
        const probe = await this.rpc<RpcResult>("workspace_sync_apply", { ...payload, probeOnly: true });
        result = probe.needsContent
          ? prepared.dataBase64 != null
            ? await this.rpc<RpcResult>("workspace_sync_apply", payload)
            : await this.uploadLargeFile(payload, prepared)
          : probe;
      } else {
        result = await this.rpc<RpcResult>("workspace_sync_apply", payload);
      }
      const entry = remoteEntryFromResult(result.entry);
      const mergedConverged = result.merged !== true
        || await this.convergeMergedFile(inflight.path, prepared, entry);
      await this.journal.acknowledge({
        path: inflight.path,
        version: inflight.version,
        revision: result.revision == null ? null : String(result.revision),
        entry,
        conflict: result.conflict === true || result.merged === true,
        serverCursor: typeof result.cursor === "number" ? result.cursor : undefined,
        remotelyApplied: true,
      });
      if (result.conflict === true) this.showConflictNotice(inflight.path, String(result.conflictPath || ""));
      if (!mergedConverged) await this.queueLocalPath(inflight.path, this.openDocumentData(inflight.path));
      this.scheduleRemoteDrain();
    } catch (error) {
      if (isChecksumMismatch(error) || error instanceof LocalFileChangedError) {
        await this.journal.discard(operation.path, operation.version);
        await this.queueLocalPath(operation.path, this.openDocumentData(operation.path));
      } else {
        await this.journal.fail(operation.path, operation.version, error);
        setTimeout(() => this.scheduleOutbox(), 1_000);
      }
    }
  }

  private async uploadLargeFile(payload: Record<string, unknown>, prepared: PreparedLocalState): Promise<RpcResult> {
    if (!prepared.sourcePath) throw new Error("Large workspace file has no local source path");
    const begin = await this.rpc<RpcResult & { transferId: string }>("workspace_sync_file_begin", { ...payload, size: prepared.size });
    let sequence = 0;
    try {
      for await (const rawChunk of createReadStream(prepared.sourcePath, { highWaterMark: TRANSFER_CHUNK_SIZE })) {
        const chunk = Buffer.from(rawChunk);
        await this.rpc("workspace_sync_file_chunk", {
          transferId: begin.transferId,
          sequence: sequence++,
          dataBase64: chunk.toString("base64"),
        });
      }
      return await this.rpc("workspace_sync_file_commit", { transferId: begin.transferId });
    } catch (error) {
      await this.rpc("workspace_sync_file_abort", { transferId: begin.transferId }).catch(() => undefined);
      throw error;
    }
  }

  private async convergeMergedFile(
    relativePath: string,
    prepared: PreparedLocalState,
    entry: RemoteWorkspaceEntry | null,
  ): Promise<boolean> {
    if (!entry || entry.type !== "file") throw new Error(`chat.dev returned an invalid merged file for ${relativePath}`);
    const contents = await this.readRemoteFileRevision(relativePath, entry);
    if (`f:${hash(contents)}:${entry.mode}` !== entry.revision) {
      throw new Error(`chat.dev returned merged bytes with the wrong revision for ${relativePath}`);
    }

    let current = await this.snapshotLocalPath(relativePath, this.openDocumentData(relativePath));
    if (current?.revision === entry.revision) {
      const document = this.openDocument(relativePath);
      if (document?.isDirty) {
        this.rememberInstalledRemoteRevision(relativePath, entry.revision);
        if (!(await document.save())) throw new Error(`Could not save merged edits to ${relativePath}`);
      }
      return true;
    }
    if (current?.revision !== prepared.revision) return false;

    this.rememberInstalledRemoteRevision(relativePath, entry.revision);
    const target = this.absolutePath(relativePath);
    const document = this.openDocument(relativePath);
    if (document && !document.isClosed) {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        text,
      );
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not apply merged edits to ${relativePath}`);
      if (hash(Buffer.from(document.getText(), "utf8")) !== hash(contents)) return false;
      if (!(await document.save())) throw new Error(`Could not save merged edits to ${relativePath}`);
      await fs.chmod(target, modeOr(entry.mode, 0o644));
    } else {
      const temporary = path.join(path.dirname(target), `${INTERNAL_TEMP_PREFIX}${crypto.randomUUID()}`);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(temporary, contents, { mode: modeOr(entry.mode, 0o644) });
        await removeDirectoryAtTarget(target);
        await atomicReplace(temporary, target);
      } finally {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    current = await this.snapshotLocalPath(relativePath, this.openDocumentData(relativePath));
    if (current?.revision === entry.revision) return true;
    this.installedRemoteRevisions.delete(relativePath);
    return false;
  }

  private rememberInstalledRemoteRevision(relativePath: string, revision: string): void {
    const expiresAt = Date.now() + 5_000;
    this.installedRemoteRevisions.set(relativePath, { revision, expiresAt });
    setTimeout(() => {
      const installed = this.installedRemoteRevisions.get(relativePath);
      if (installed?.revision === revision && installed.expiresAt === expiresAt) {
        this.installedRemoteRevisions.delete(relativePath);
      }
    }, 5_000);
  }

  private async readRemoteFileRevision(relativePath: string, entry: RemoteWorkspaceEntry): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (true) {
      const chunk = await this.rpc<RpcResult & {
        dataBase64: string;
        nextOffset: number;
        eof: boolean;
        size: number;
        revision: string;
      }>("workspace_sync_read_file", {
        path: relativePath,
        offset,
        length: TRANSFER_CHUNK_SIZE,
        expectedRevision: entry.revision,
      });
      if (chunk.revision !== entry.revision) throw new Error(`chat.dev changed ${relativePath} during merge reconciliation`);
      const data = Buffer.from(chunk.dataBase64, "base64");
      if (chunk.nextOffset !== offset + data.length || (!chunk.eof && chunk.nextOffset <= offset)) {
        throw new Error(`chat.dev returned an invalid file chunk for ${relativePath}`);
      }
      chunks.push(data);
      offset = chunk.nextOffset;
      if (chunk.eof) {
        if (offset !== entry.size || Number(chunk.size) !== entry.size) {
          throw new Error(`chat.dev returned the wrong merged file size for ${relativePath}`);
        }
        return Buffer.concat(chunks, offset);
      }
    }
  }

  private async prepareLocalOperation(operation: PendingWorkspaceOperation): Promise<PreparedLocalState | undefined> {
    const inline = operation.inlineDataBase64 == null ? undefined : Buffer.from(operation.inlineDataBase64, "base64");
    return this.snapshotLocalPath(operation.path, inline);
  }

  private async snapshotLocalPath(relativePath: string, inlineData?: Uint8Array): Promise<PreparedLocalState | undefined> {
    const absolutePath = this.absolutePath(relativePath);
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "deleted", revision: null, size: 0, mode: 0 };
      }
      throw error;
    }
    const mode = metadata.mode & 0o777;
    if (metadata.isDirectory()) return { kind: "directory", revision: `d:${mode}`, size: 0, mode, localFingerprint: localStatFingerprint(metadata) };
    if (metadata.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      if (!this.validSymlinkTarget(absolutePath, target)) return undefined;
      return { kind: "symlink", revision: `l:${hash(Buffer.from(target))}:${mode}`, size: 0, mode, target, localFingerprint: localStatFingerprint(metadata) };
    }
    if (!metadata.isFile()) return undefined;
    if (inlineData) {
      const data = Buffer.from(inlineData);
      const contentHash = hash(data);
      return {
        kind: "file",
        revision: `f:${contentHash}:${mode}`,
        size: data.byteLength,
        mode,
        contentHash,
        dataBase64: data.toString("base64"),
      };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = attempt ? await fs.lstat(absolutePath) : metadata;
      if (!before.isFile()) return this.snapshotLocalPath(relativePath);
      if (before.size <= SMALL_FILE_LIMIT) {
        const data = await fs.readFile(absolutePath);
        const after = await fs.lstat(absolutePath);
        if (!sameFileStat(before, after)) continue;
        const contentHash = hash(data);
        return {
          kind: "file",
          revision: `f:${contentHash}:${after.mode & 0o777}`,
          size: data.byteLength,
          mode: after.mode & 0o777,
          contentHash,
          dataBase64: data.toString("base64"),
          localFingerprint: localStatFingerprint(after),
        };
      }
      const contentHash = await hashFile(absolutePath);
      const after = await fs.lstat(absolutePath);
      if (!sameFileStat(before, after)) continue;
      return {
        kind: "file",
        revision: `f:${contentHash}:${after.mode & 0o777}`,
        size: after.size,
        mode: after.mode & 0o777,
        contentHash,
        sourcePath: absolutePath,
        localFingerprint: localStatFingerprint(after),
      };
    }
    throw new LocalFileChangedError(relativePath);
  }

  private scheduleRemoteDrain(): void {
    if (this.remoteDrainPromise || this.disposed || !this.protocolReady || !this.remoteDrainEnabled) return;
    this.remoteDrainPromise = this.drainRemoteChanges().catch((error) => {
      console.warn("[chat.dev] remote workspace changes will retry:", error);
    }).finally(() => {
      this.remoteDrainPromise = undefined;
    });
  }

  private async flushRemoteChanges(): Promise<void> {
    if (this.remoteDrainPromise) return this.remoteDrainPromise;
    if (this.disposed || !this.protocolReady || !this.remoteDrainEnabled) return;
    this.remoteDrainPromise = this.drainRemoteChanges().finally(() => {
      this.remoteDrainPromise = undefined;
    });
    return this.remoteDrainPromise;
  }

  private async drainRemoteChanges(): Promise<void> {
    while (!this.disposed) {
      const result = await this.rpc<RpcResult & {
        changes: RemoteWorkspaceChange[];
        cursor: number;
        headCursor: number;
        hasMore: boolean;
        rescanRequired: boolean;
      }>("workspace_sync_changes", { cursor: this.journal.remoteCursor, limit: 2_000 });
      if (result.rescanRequired) {
        await this.reconcileRemoteManifest();
        return;
      }
      if (result.changes.length) await this.journal.stageRemoteChanges(result.changes, result.cursor);
      else await this.journal.setRemoteCursor(result.cursor);
      await this.flushInboundChanges();
      if (!result.hasMore) return;
    }
  }

  private scheduleInbound(): void {
    if (this.inboundPromise || this.disposed || !this.protocolReady) return;
    this.inboundPromise = this.processInboundChanges().catch((error) => {
      console.warn("[chat.dev] inbound workspace changes will retry:", error);
    }).finally(() => {
      this.inboundPromise = undefined;
    });
  }

  private async flushInboundChanges(): Promise<void> {
    if (this.inboundPromise) return this.inboundPromise;
    if (this.disposed || !this.protocolReady) return;
    this.inboundPromise = this.processInboundChanges().finally(() => {
      this.inboundPromise = undefined;
    });
    return this.inboundPromise;
  }

  private async processInboundChanges(): Promise<void> {
    const blockedPaths = new Set<string>();
    for (const change of this.journal.pendingRemoteChanges()) {
      if (blockedPaths.has(change.path)) continue;
      if (this.ignored(change.path)) {
        await this.journal.acknowledgeRemoteChange(change.id, false);
        continue;
      }
      if (change.status === "applying") {
        await this.materializeRemoteChange(change);
        continue;
      }
      if (change.sequence != null && change.sequence <= this.journal.knownSequence(change.path)) {
        await this.journal.acknowledgeRemoteChange(change.id, false);
        continue;
      }
      if (this.journal.hasPending(change.path)) {
        blockedPaths.add(change.path);
        continue;
      }
      const local = await this.snapshotLocalPath(change.path, this.openDocumentData(change.path));
      const previousRevision = this.journal.known(change.path)?.revision || null;
      if (local && local.revision !== previousRevision && local.revision !== change.revision) {
        await this.enqueuePreparedSnapshot(change.path, local);
        blockedPaths.add(change.path);
        continue;
      }
      const applying = await this.journal.beginRemoteApply(change.id, local?.revision || null);
      if (applying) await this.materializeRemoteChange(applying);
    }
  }

  private async materializeRemoteChange(change: PendingRemoteWorkspaceChange): Promise<void> {
    const expectedRevision = change.expectedLocalRevision ?? null;
    if (change.kind === "file") {
      const temporary = `${this.absolutePath(change.path)}${PARTIAL_SUFFIX}`;
      await fs.mkdir(path.dirname(temporary), { recursive: true });
      await fs.rm(temporary, { recursive: true, force: true });
      try {
        const handle = await fs.open(temporary, "w", modeOr(change.mode, 0o644));
        try {
          let offset = 0;
          while (true) {
            const chunk = await this.rpc<RpcResult & {
              dataBase64: string;
              nextOffset: number;
              eof: boolean;
              revision: string;
            }>("workspace_sync_read_file", {
              path: change.path,
              offset,
              length: TRANSFER_CHUNK_SIZE,
              expectedRevision: change.revision,
            });
            const data = Buffer.from(chunk.dataBase64, "base64");
            if (data.length) await handle.write(data, 0, data.length, offset);
            offset = chunk.nextOffset;
            if (chunk.eof) break;
          }
        } finally {
          await handle.close();
        }
        if (await this.preserveEditMadeDuringRemoteApply(change, expectedRevision)) return;
        await this.installRemoteFile(change, temporary);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    } else {
      if (await this.preserveEditMadeDuringRemoteApply(change, expectedRevision)) return;
      const target = this.absolutePath(change.path);
      if (change.kind === "deleted") {
        await fs.rm(target, { recursive: true, force: true });
      } else if (change.kind === "directory") {
        await replaceNonDirectory(target);
        await fs.mkdir(target, { recursive: true });
        await fs.chmod(target, modeOr(change.mode, 0o755));
      } else {
        const linkTarget = String(change.target || "");
        if (!this.validSymlinkTarget(target, linkTarget)) throw new Error(`Remote symlink points outside the project: ${change.path}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = path.join(path.dirname(target), `${INTERNAL_TEMP_PREFIX}${crypto.randomUUID()}`);
        await fs.symlink(linkTarget, temporary);
        await removeDirectoryAtTarget(target);
        await atomicReplace(temporary, target);
      }
    }
    await this.journal.acknowledgeRemoteChange(change.id);
  }

  private async preserveEditMadeDuringRemoteApply(change: PendingRemoteWorkspaceChange, expectedRevision: string | null): Promise<boolean> {
    const current = await this.snapshotLocalPath(change.path, this.openDocumentData(change.path));
    if ((current?.revision || null) === expectedRevision) return false;
    if (current) await this.enqueuePreparedSnapshot(change.path, current);
    await this.journal.acknowledgeRemoteChange(change.id, false);
    this.scheduleOutbox();
    return true;
  }

  private async installRemoteFile(change: PendingRemoteWorkspaceChange, temporary: string): Promise<void> {
    const target = this.absolutePath(change.path);
    const document = this.openDocument(change.path);
    if (document?.isDirty) throw new LocalFileChangedError(change.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await removeDirectoryAtTarget(target);
    await fs.chmod(temporary, modeOr(change.mode, 0o644));
    await atomicReplace(temporary, target);
  }

  private async enqueuePreparedSnapshot(relativePath: string, prepared: PreparedLocalState): Promise<void> {
    const inlineData = prepared.dataBase64 == null ? undefined : Buffer.from(prepared.dataBase64, "base64");
    const operation = await this.journal.enqueue({ path: relativePath, ...(inlineData ? { inlineData } : {}), sizeHint: prepared.size });
    await this.journal.markPrepared(relativePath, operation.version, prepared);
    this.scheduleOutbox();
  }

  private async waitForOutbox(): Promise<void> {
    while (!this.disposed && this.journal.hasPending()) {
      this.scheduleOutbox();
      await (this.outboxPromise || delay(250));
      if (this.journal.hasPending()) await delay(250);
    }
  }

  private async waitForInbound(): Promise<void> {
    while (!this.disposed && this.journal.pendingRemoteChanges().length) {
      this.scheduleInbound();
      await (this.inboundPromise || delay(100));
      if (this.journal.pendingRemoteChanges().length && this.journal.hasPending()) await this.waitForOutbox();
    }
  }

  private showConflictNotice(originalPath: string, conflictPath: string): void {
    console.warn(`[chat.dev] Preserved concurrent edits to ${originalPath} in ${conflictPath}`);
    if (Date.now() - this.lastConflictNotice < 10_000) return;
    this.lastConflictNotice = Date.now();
    void vscode.window.showWarningMessage(`Both copies of ${originalPath} were kept because it changed locally and on chat.dev.`);
  }

  private async rpc<T extends RpcResult = RpcResult>(event: string, payload: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket?.connected) throw new Error("chat.dev workspace mirror is reconnecting");
    const result = await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`chat.dev ${event} timed out`)), 180_000);
      socket.emit(event, { agentId: this.agentId, ...payload }, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
    if (!result.ok) throw syncError(result.code, String(result.error || `chat.dev ${event} failed`), result);
    return result;
  }

  private openDocumentData(relativePath: string): Uint8Array | undefined {
    const document = this.openDocument(relativePath);
    return document && !document.isClosed ? Buffer.from(document.getText(), "utf8") : undefined;
  }

  private dirtyDocumentData(relativePath: string): Uint8Array | undefined {
    const document = this.openDocument(relativePath);
    return document?.isDirty ? Buffer.from(document.getText(), "utf8") : undefined;
  }

  private openDocument(relativePath: string): vscode.TextDocument | undefined {
    const uri = vscode.Uri.file(this.absolutePath(relativePath)).toString();
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri);
  }

  private relativePath(uri: vscode.Uri): string {
    if (uri.scheme !== "file") return "";
    const value = path.relative(this.workspacePath, uri.fsPath).split(path.sep).join(path.posix.sep);
    return value.startsWith("../") || path.isAbsolute(value) ? "" : value;
  }

  private absolutePath(relativePath: string): string {
    const target = path.resolve(this.workspacePath, relativePath);
    if (!target.startsWith(`${this.workspacePath}${path.sep}`)) throw new Error(`Invalid project path: ${relativePath}`);
    return target;
  }

  private ignored(relativePath: string): boolean {
    return ignoredWorkspacePath(relativePath, configuredUploadExcludes());
  }

  private async portableSymlink(absolutePath: string): Promise<boolean> {
    try { return this.validSymlinkTarget(absolutePath, await fs.readlink(absolutePath)); }
    catch { return false; }
  }

  private validSymlinkTarget(absolutePath: string, target: string): boolean {
    if (!target || path.isAbsolute(target)) return false;
    const resolved = path.resolve(path.dirname(absolutePath), target);
    return resolved === this.workspacePath || resolved.startsWith(`${this.workspacePath}${path.sep}`);
  }

  private async localPathExists(relativePath: string): Promise<boolean> {
    try { await fs.lstat(this.absolutePath(relativePath)); return true; }
    catch { return false; }
  }
}

class LocalFileChangedError extends Error {
  constructor(relativePath: string) {
    super(`Local file kept changing while it was read: ${relativePath}`);
  }
}

function operationPayload(
  journal: WorkspaceSyncJournal,
  operation: PendingWorkspaceOperation,
  prepared: PreparedLocalState,
): Record<string, unknown> {
  return {
    generation: journal.generation,
    clientId: journal.clientId,
    version: operation.version,
    opId: operation.opId,
    path: operation.path,
    kind: prepared.kind,
    baseRevision: operation.baseRevision,
    mergeResponseVersion: 1,
    size: prepared.size,
    mode: prepared.mode,
    ...(prepared.contentHash ? { contentHash: prepared.contentHash } : {}),
    ...(prepared.target != null ? { target: prepared.target } : {}),
    ...(prepared.dataBase64 != null ? { dataBase64: prepared.dataBase64 } : {}),
  };
}

function remoteEntryFromResult(value: unknown): RemoteWorkspaceEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (!new Set(["file", "directory", "symlink"]).has(String(entry.type || "")) || !entry.revision) return null;
  return {
    type: entry.type as RemoteWorkspaceEntry["type"],
    revision: String(entry.revision),
    size: Math.max(0, Number(entry.size) || 0),
    mode: Math.max(0, Number(entry.mode) || 0),
    ...(entry.target != null ? { target: String(entry.target) } : {}),
  };
}

function changeFromEntry(entry: { path: string } & RemoteWorkspaceEntry): RemoteWorkspaceChange {
  return {
    path: entry.path,
    kind: entry.type,
    revision: entry.revision,
    size: entry.size,
    mode: entry.mode,
    target: entry.target,
  };
}

function deletedChange(entryPath: string): RemoteWorkspaceChange {
  return { path: entryPath, kind: "deleted", revision: null, size: 0, mode: null };
}

function sameFileStat(left: Awaited<ReturnType<typeof fs.lstat>>, right: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function localStatFingerprint(metadata: Awaited<ReturnType<typeof fs.lstat>>): string {
  const kind = metadata.isDirectory() ? "d" : metadata.isSymbolicLink() ? "l" : "f";
  return `${kind}:${metadata.size}:${Number(metadata.mode) & 0o777}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

function hash(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function modeOr(value: number | null, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) & 0o777 : fallback;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function replaceNonDirectory(target: string): Promise<void> {
  try {
    const metadata = await fs.lstat(target);
    if (!metadata.isDirectory()) await fs.rm(target, { recursive: true, force: true });
  } catch {}
}

async function removeDirectoryAtTarget(target: string): Promise<void> {
  try {
    const metadata = await fs.lstat(target);
    if (metadata.isDirectory()) await fs.rm(target, { recursive: true, force: true });
  } catch {}
}

async function atomicReplace(temporary: string, target: string): Promise<void> {
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM", "EACCES"]).has(String((error as NodeJS.ErrnoException).code || ""))) throw error;
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(temporary, target);
  }
}

function syncError(code: unknown, message: string, detail: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), detail, { code: code == null ? undefined : String(code) });
}

function isGenerationConflict(error: unknown): boolean {
  return String((error as Error & { code?: string })?.code || "").includes("generation_conflict")
    || String((error as Error & { code?: string })?.code || "").includes("client_conflict");
}

function isChecksumMismatch(error: unknown): boolean {
  return (error as Error & { code?: string })?.code === "workspace_sync_checksum_mismatch";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeReport(report: StartOptions["report"], message: string): Promise<void> {
  try { await report?.(message); }
  catch (error) { console.warn("[chat.dev] Could not update workspace sync progress:", error); }
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
  return Object.assign(new Error("Agent not found"), { status: 404 });
}

function mirrorKey(serverUrl: string, workspacePath: string): string {
  return `${serverUrl}:${path.resolve(workspacePath)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
}

function configuredUploadExcludes(): Set<string> {
  return new Set(vscode.workspace.getConfiguration("chatdev").get<string[]>("uploadExcludes", []));
}
