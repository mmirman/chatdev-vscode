import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

export type RemoteWorkspaceEntry = {
  type: "file" | "directory" | "symlink";
  revision: string;
  size: number;
  mode: number;
  target?: string | null;
};

export type PreparedLocalState = {
  kind: "file" | "directory" | "symlink" | "deleted";
  revision: string | null;
  size: number;
  mode: number;
  contentHash?: string;
  target?: string;
  dataBase64?: string;
  sourcePath?: string;
  localFingerprint?: string;
};

export type PendingWorkspaceOperation = {
  path: string;
  version: number;
  opId: string;
  status: "queued" | "inflight";
  baseKnown: boolean;
  baseRevision: string | null;
  dependsOnVersion?: number;
  prepared?: PreparedLocalState;
  inlineDataBase64?: string;
  sizeHint: number;
  attempts: number;
  retryAt: number;
  lastError?: string;
  createdAt: string;
};

export type RemoteWorkspaceChange = {
  sequence?: number;
  path: string;
  kind: "file" | "directory" | "symlink" | "deleted";
  revision: string | null;
  size: number;
  mode: number | null;
  target?: string | null;
  originClientId?: string | null;
  originOperationId?: string | null;
};

export type PendingRemoteWorkspaceChange = RemoteWorkspaceChange & {
  id: number;
  status: "staged" | "applying";
  expectedLocalRevision?: string | null;
};

type PersistedJournal = {
  version: 1;
  serverUrl: string;
  agentId: string;
  workspacePath: string;
  clientId: string;
  generation: string;
  phase: "syncing" | "live";
  nextVersion: number;
  highestRemoteVersion: number;
  remoteCursor: number;
  remoteManifestLoaded: boolean;
  knownRemote: Record<string, RemoteWorkspaceEntry>;
  remotePathSequences: Record<string, number>;
  managedPaths: Record<string, true>;
  localFingerprints: Record<string, string>;
  operations: Record<string, PendingWorkspaceOperation[]>;
  nextInboundId: number;
  inboundChanges: PendingRemoteWorkspaceChange[];
  updatedAt: string;
};

export class WorkspaceSyncJournal {
  private persistence = Promise.resolve();
  readonly filePath: string;
  private state: PersistedJournal;

  private constructor(filePath: string, state: PersistedJournal) {
    this.filePath = filePath;
    this.state = state;
  }

  static async open(input: {
    storageDirectory: string;
    serverUrl: string;
    agentId: string;
    workspacePath: string;
    clientId: string;
  }): Promise<WorkspaceSyncJournal> {
    const identity = `${input.serverUrl}\0${input.agentId}\0${path.resolve(input.workspacePath)}`;
    const filename = `${crypto.createHash("sha256").update(identity).digest("hex")}.json`;
    const filePath = path.join(input.storageDirectory, "workspace-sync", filename);
    let state: PersistedJournal | undefined;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as PersistedJournal;
      if (parsed.version === 1
        && parsed.serverUrl === input.serverUrl
        && parsed.agentId === input.agentId
        && path.resolve(parsed.workspacePath) === path.resolve(input.workspacePath)) {
        state = parsed;
      }
    } catch {}
    state ||= {
      version: 1,
      serverUrl: input.serverUrl,
      agentId: input.agentId,
      workspacePath: path.resolve(input.workspacePath),
      clientId: input.clientId,
      generation: `generation-${crypto.randomUUID()}`,
      phase: "syncing",
      nextVersion: 1,
      highestRemoteVersion: 0,
      remoteCursor: 0,
      remoteManifestLoaded: false,
      knownRemote: {},
      remotePathSequences: {},
      managedPaths: {},
      localFingerprints: {},
      operations: {},
      nextInboundId: 1,
      inboundChanges: [],
      updatedAt: new Date().toISOString(),
    };
    state.remoteManifestLoaded ||= false;
    state.highestRemoteVersion ||= 0;
    state.remotePathSequences ||= {};
    state.localFingerprints ||= {};
    state.nextInboundId ||= 1;
    state.inboundChanges ||= [];
    for (const operations of Object.values(state.operations)) {
      for (const operation of operations) {
        if (operation.status === "inflight") operation.status = "queued";
      }
    }
    const journal = new WorkspaceSyncJournal(filePath, state);
    await journal.persist();
    return journal;
  }

  get clientId(): string { return this.state.clientId; }
  get generation(): string { return this.state.generation; }
  get phase(): "syncing" | "live" { return this.state.phase; }
  get remoteCursor(): number { return this.state.remoteCursor; }
  get lastLocalVersion(): number { return this.state.nextVersion - 1; }
  get lastAppliedVersion(): number { return this.state.highestRemoteVersion; }
  get remoteManifestLoaded(): boolean { return this.state.remoteManifestLoaded; }

  known(path: string): RemoteWorkspaceEntry | undefined {
    return this.state.knownRemote[path];
  }

  knownSequence(path: string): number {
    return this.state.remotePathSequences[path] || 0;
  }

  effectiveRemoteEntries(): Array<{ path: string } & RemoteWorkspaceEntry> {
    const entries: Record<string, RemoteWorkspaceEntry> = structuredClone(this.state.knownRemote);
    for (const change of this.state.inboundChanges) {
      const entry = remoteEntryFromChange(change);
      if (entry) entries[change.path] = entry;
      else delete entries[change.path];
    }
    return Object.entries(entries).map(([entryPath, entry]) => ({ path: entryPath, ...entry }));
  }

  isManaged(path: string): boolean {
    return this.state.managedPaths[path] === true;
  }

  localFingerprint(path: string): string | undefined {
    return this.state.localFingerprints[path];
  }

  hasPending(path?: string): boolean {
    if (path) return (this.state.operations[path]?.length || 0) > 0;
    return Object.values(this.state.operations).some((operations) => operations.length > 0);
  }

  async setGeneration(generation: string): Promise<void> {
    if (this.state.generation === generation) return;
    this.state.generation = generation;
    this.state.phase = "syncing";
    this.state.remoteCursor = 0;
    this.state.remoteManifestLoaded = false;
    this.state.knownRemote = {};
    this.state.remotePathSequences = {};
    this.state.managedPaths = {};
    this.state.localFingerprints = {};
    this.state.operations = {};
    this.state.inboundChanges = [];
    this.state.highestRemoteVersion = 0;
    await this.persist();
  }

  async markSyncing(): Promise<void> {
    this.state.phase = "syncing";
    await this.persist();
  }

  async markLive(cursor: number): Promise<void> {
    this.state.phase = "live";
    this.state.remoteCursor = Math.max(this.state.remoteCursor, cursor);
    await this.persist();
  }

  async replaceRemoteManifest(entries: Array<{ path: string } & RemoteWorkspaceEntry>, cursor: number): Promise<void> {
    this.state.knownRemote = Object.fromEntries(entries.map(({ path: entryPath, ...entry }) => [entryPath, entry]));
    this.state.remoteCursor = cursor;
    this.state.remoteManifestLoaded = true;
    for (const operations of Object.values(this.state.operations)) {
      const first = operations[0];
      if (!first || first.baseKnown || first.dependsOnVersion) continue;
      first.baseKnown = true;
      first.baseRevision = this.state.knownRemote[first.path]?.revision || null;
    }
    await this.persist();
  }

  async recordRemote(path: string, entry: RemoteWorkspaceEntry | null, cursor?: number): Promise<void> {
    if (entry) this.state.knownRemote[path] = entry;
    else delete this.state.knownRemote[path];
    if (cursor != null) this.state.remoteCursor = Math.max(this.state.remoteCursor, cursor);
    await this.persist();
  }

  async setRemoteCursor(cursor: number): Promise<void> {
    if (cursor <= this.state.remoteCursor) return;
    this.state.remoteCursor = cursor;
    await this.persist();
  }

  pendingRemoteChanges(): PendingRemoteWorkspaceChange[] {
    return this.state.inboundChanges.map((change) => structuredClone(change));
  }

  async stageRemoteChanges(changes: RemoteWorkspaceChange[], cursor: number): Promise<PendingRemoteWorkspaceChange[]> {
    const existingSequences = new Set(this.state.inboundChanges
      .map((change) => change.sequence)
      .filter((sequence): sequence is number => sequence != null));
    const staged: PendingRemoteWorkspaceChange[] = [];
    for (const change of changes) {
      if (change.sequence != null && existingSequences.has(change.sequence)) continue;
      const pending: PendingRemoteWorkspaceChange = {
        ...structuredClone(change),
        id: this.state.nextInboundId++,
        status: "staged",
      };
      this.state.inboundChanges.push(pending);
      staged.push(structuredClone(pending));
    }
    this.state.remoteCursor = Math.max(this.state.remoteCursor, cursor);
    await this.persist();
    return staged;
  }

  async beginRemoteApply(id: number, expectedLocalRevision: string | null): Promise<PendingRemoteWorkspaceChange | undefined> {
    const change = this.state.inboundChanges.find((item) => item.id === id);
    if (!change) return undefined;
    change.status = "applying";
    change.expectedLocalRevision = expectedLocalRevision;
    const entry = remoteEntryFromChange(change);
    if (entry) this.state.knownRemote[change.path] = entry;
    else delete this.state.knownRemote[change.path];
    if (change.sequence != null) {
      this.state.remotePathSequences[change.path] = Math.max(this.state.remotePathSequences[change.path] || 0, change.sequence);
    }
    await this.persist();
    return structuredClone(change);
  }

  async stageRemoteMaterializations(changes: RemoteWorkspaceChange[]): Promise<void> {
    for (const change of changes) {
      const pending: PendingRemoteWorkspaceChange = {
        ...structuredClone(change),
        id: this.state.nextInboundId++,
        status: "applying",
        expectedLocalRevision: null,
      };
      this.state.inboundChanges.push(pending);
    }
    await this.persist();
  }

  async acknowledgeRemoteChange(id: number, updateManaged = true): Promise<void> {
    const index = this.state.inboundChanges.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [change] = this.state.inboundChanges.splice(index, 1);
    if (updateManaged) {
      if (change.kind === "deleted") delete this.state.managedPaths[change.path];
      else this.state.managedPaths[change.path] = true;
      delete this.state.localFingerprints[change.path];
    }
    await this.persist();
  }

  async enqueue(input: { path: string; inlineData?: Uint8Array; sizeHint?: number }): Promise<PendingWorkspaceOperation> {
    return (await this.enqueueMany([input]))[0];
  }

  async enqueueMany(inputs: Array<{ path: string; inlineData?: Uint8Array; sizeHint?: number }>): Promise<PendingWorkspaceOperation[]> {
    const queued: PendingWorkspaceOperation[] = [];
    for (const input of inputs) {
      const operations = this.state.operations[input.path] ||= [];
      const tail = operations.at(-1);
      const version = this.state.nextVersion++;
      const replacementBase = tail && tail.status === "queued"
        ? {
          baseKnown: tail.baseKnown,
          baseRevision: tail.baseRevision,
          ...(tail.dependsOnVersion ? { dependsOnVersion: tail.dependsOnVersion } : {}),
        }
        : tail
          ? { baseKnown: false, baseRevision: null, dependsOnVersion: tail.version }
          : {
            baseKnown: this.state.remoteManifestLoaded,
            baseRevision: this.state.knownRemote[input.path]?.revision || null,
          };
      const operation: PendingWorkspaceOperation = {
        path: input.path,
        version,
        opId: `op-${crypto.randomUUID()}`,
        status: "queued",
        ...replacementBase,
        ...(input.inlineData ? { inlineDataBase64: Buffer.from(input.inlineData).toString("base64") } : {}),
        sizeHint: Math.max(0, Number(input.sizeHint) || input.inlineData?.byteLength || 0),
        attempts: 0,
        retryAt: 0,
        createdAt: new Date().toISOString(),
      };
      if (tail?.status === "queued") operations[operations.length - 1] = operation;
      else operations.push(operation);
      queued.push(structuredClone(operation));
    }
    await this.persist();
    return queued;
  }

  nextReadyOperations(limit: number): PendingWorkspaceOperation[] {
    const now = Date.now();
    return Object.values(this.state.operations)
      .map((operations) => operations[0])
      .filter((operation): operation is PendingWorkspaceOperation => !!operation
        && operation.status === "queued"
        && operation.retryAt <= now
        && operation.baseKnown
        && !operation.dependsOnVersion)
      .sort((left, right) => left.sizeHint - right.sizeHint || left.version - right.version)
      .slice(0, limit)
      .map((operation) => structuredClone(operation));
  }

  async markPrepared(path: string, version: number, prepared: PreparedLocalState): Promise<PendingWorkspaceOperation | undefined> {
    const operation = this.find(path, version);
    if (!operation) return undefined;
    operation.prepared = prepared;
    await this.persist();
    return structuredClone(operation);
  }

  async markInflight(path: string, version: number): Promise<PendingWorkspaceOperation | undefined> {
    const operation = this.find(path, version);
    if (!operation) return undefined;
    operation.status = "inflight";
    await this.persist();
    return structuredClone(operation);
  }

  async acknowledge(input: {
    path: string;
    version: number;
    revision: string | null;
    entry: RemoteWorkspaceEntry | null;
    conflict?: boolean;
    serverCursor?: number;
    remotelyApplied?: boolean;
  }): Promise<void> {
    const operations = this.state.operations[input.path];
    const operation = operations?.find((item) => item.version === input.version);
    if (!operations || !operation) return;
    const index = operations.indexOf(operation);
    operations.splice(index, 1);
    if (!operations.length) delete this.state.operations[input.path];
    if (input.entry) this.state.knownRemote[input.path] = input.entry;
    else delete this.state.knownRemote[input.path];
    if (input.serverCursor != null) {
      this.state.remotePathSequences[input.path] = Math.max(this.state.remotePathSequences[input.path] || 0, input.serverCursor);
    }
    if (input.remotelyApplied) {
      this.state.highestRemoteVersion = Math.max(this.state.highestRemoteVersion, input.version);
    }
    if (operation.prepared?.kind === "deleted") {
      delete this.state.managedPaths[input.path];
      delete this.state.localFingerprints[input.path];
    } else {
      this.state.managedPaths[input.path] = true;
      if (!input.conflict && operation.prepared?.localFingerprint) this.state.localFingerprints[input.path] = operation.prepared.localFingerprint;
      else delete this.state.localFingerprints[input.path];
    }
    const next = operations[0];
    if (next?.dependsOnVersion === input.version) {
      next.dependsOnVersion = undefined;
      next.baseKnown = true;
      next.baseRevision = input.revision;
    }
    await this.persist();
  }

  async fail(path: string, version: number, error: unknown): Promise<void> {
    const operation = this.find(path, version);
    if (!operation) return;
    operation.status = "queued";
    operation.attempts += 1;
    operation.lastError = error instanceof Error ? error.message : String(error);
    operation.retryAt = Date.now() + Math.min(30_000, 500 * (2 ** Math.min(6, operation.attempts)));
    await this.persist();
  }

  async discard(path: string, version: number): Promise<void> {
    const operations = this.state.operations[path];
    const operation = operations?.find((item) => item.version === version);
    if (!operations || !operation) return;
    const index = operations.indexOf(operation);
    operations.splice(index, 1);
    if (!operations.length) delete this.state.operations[path];
    const next = operations[0];
    if (next?.dependsOnVersion === version) {
      next.dependsOnVersion = undefined;
      next.baseKnown = operation.baseKnown;
      next.baseRevision = operation.baseRevision;
    }
    await this.persist();
  }

  async queueManagedDeletions(seen: Set<string>, ignored: (path: string) => boolean): Promise<void> {
    const deleted = Object.keys(this.state.managedPaths)
      .filter((managedPath) => !seen.has(managedPath) && !ignored(managedPath) && !this.hasPending(managedPath))
      .map((managedPath) => ({ path: managedPath }));
    if (deleted.length) await this.enqueueMany(deleted);
  }

  private find(path: string, version: number): PendingWorkspaceOperation | undefined {
    return this.state.operations[path]?.find((operation) => operation.version === version);
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(this.state);
    const write = this.persistence.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, serialized, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    });
    this.persistence = write;
    await write;
  }
}

function remoteEntryFromChange(change: RemoteWorkspaceChange): RemoteWorkspaceEntry | null {
  if (change.kind === "deleted" || !change.revision) return null;
  return {
    type: change.kind,
    revision: change.revision,
    size: Math.max(0, Number(change.size) || 0),
    mode: Math.max(0, Number(change.mode) || 0),
    ...(change.target != null ? { target: change.target } : {}),
  };
}
