import { createHash } from "node:crypto";

export type CursorSyncMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string | null;
  sourceId?: string;
  turnId?: string;
};

const nativeTurnByBubble = new Map<string, Map<string, string>>();
const remoteBubbles = new Map<string, Set<string>>();
const remoteSnapshots = new Map<string, Set<string>>();
const VALID_ID = /^[a-zA-Z0-9_.:-]{8,100}$/;

function validId(value: unknown): string | undefined {
  const id = String(value || "").trim();
  return VALID_ID.test(id) ? id : undefined;
}

export function cursorNativeRequestId(requestId: unknown, userBubbleId: unknown, fallback: string): string {
  return validId(requestId) || validId(userBubbleId) || fallback;
}

export function recordCursorNativeTurn(
  sessionId: string,
  userBubbleId: unknown,
  requestId: string,
): void {
  const bubbleId = validId(userBubbleId);
  const turnId = validId(requestId);
  if (!sessionId || !bubbleId || !turnId) return;
  let mappings = nativeTurnByBubble.get(sessionId);
  if (!mappings) {
    mappings = new Map();
    nativeTurnByBubble.set(sessionId, mappings);
  }
  mappings.set(bubbleId, turnId);
  while (mappings.size > 500) mappings.delete(mappings.keys().next().value!);
}

export function recordCursorRemoteBubbles(sessionId: string, bubbles: Array<Record<string, unknown>>): void {
  if (!sessionId) return;
  let ids = remoteBubbles.get(sessionId);
  if (!ids) {
    ids = new Set();
    remoteBubbles.set(sessionId, ids);
  }
  let snapshots = remoteSnapshots.get(sessionId);
  if (!snapshots) {
    snapshots = new Set();
    remoteSnapshots.set(sessionId, snapshots);
  }
  for (const bubble of bubbles) {
    const id = validId(bubble?.bubbleId);
    if (id) ids.add(id);
    const role = bubble?.type === 1 || bubble?.type === "1" || bubble?.type === "user"
      ? "user"
      : bubble?.type === 2 || bubble?.type === "2" || bubble?.type === "assistant"
        ? "assistant"
        : "";
    const snapshot = logicalSnapshotKey({
      role,
      content: typeof bubble?.text === "string" ? bubble.text : "",
      createdAt: typeof bubble?.createdAt === "string" ? bubble.createdAt : null,
    });
    if (role && snapshot) snapshots.add(snapshot);
  }
  while (ids.size > 5_000) ids.delete(ids.values().next().value!);
  while (snapshots.size > 5_000) snapshots.delete(snapshots.values().next().value!);
}

export function dedupeCursorTranscriptMessages<T extends CursorSyncMessage>(messages: T[]): T[] {
  const keys = messages.map((message, index) => {
    const turnId = validId(message.turnId);
    const sourceId = validId(message.sourceId);
    const createdAt = String(message.createdAt || "").trim();
    const content = String(message.content || "").trim();
    return createdAt
      ? `snapshot\0${message.role}\0${createdAt}\0${content}`
      : turnId
        ? `turn\0${message.role}\0${turnId}`
        : sourceId
          ? `source\0${message.role}\0${sourceId}`
          : `unidentified\0${index}`;
  });
  const firstIndexByKey = new Map<string, number>();
  keys.forEach((key, index) => {
    if (!firstIndexByKey.has(key)) firstIndexByKey.set(key, index);
  });
  return messages.filter((_message, index) => firstIndexByKey.get(keys[index]) === index);
}

export function reconcileCursorTranscriptMessages<T extends CursorSyncMessage>(sessionId: string, messages: T[]): T[] {
  const nativeMappings = nativeTurnByBubble.get(sessionId);
  const remoteIds = remoteBubbles.get(sessionId);
  const injectedSnapshots = remoteSnapshots.get(sessionId);
  const reconciled = messages.flatMap((message) => {
    const sourceId = validId(message.sourceId);
    if ((sourceId && remoteIds?.has(sourceId)) || injectedSnapshots?.has(logicalSnapshotKey(message))) return [];
    const nativeTurnId = sourceId ? nativeMappings?.get(sourceId) : undefined;
    return [{ ...message, ...(nativeTurnId ? { turnId: nativeTurnId } : {}) } as T];
  });
  return dedupeCursorTranscriptMessages(reconciled);
}

type RemoteCursorMessage = {
  role?: string;
  content?: string;
  createdAt?: string | null;
  sourceKey?: string | null;
};

function cursorExpectedSourceKey(sessionId: string, message: CursorSyncMessage): string {
  const role = message.role === "user" ? "user" : "agent";
  const turnId = validId(message.turnId);
  const sourceId = validId(message.sourceId);
  const createdAt = String(message.createdAt || "").trim();
  const prefix = `editor:cursor:${sessionId}:${role}:`;
  if (createdAt) {
    const fingerprint = createHash("sha256")
      .update(`${role}\0${createdAt}\0${String(message.content || "").trim()}`)
      .digest("hex")
      .slice(0, 32);
    return `${prefix}fingerprint:${fingerprint}`;
  }
  if (turnId) return `turn:${turnId}:${role === "user" ? "user" : "final"}`;
  return sourceId ? `${prefix}source:${sourceId}` : "";
}

function logicalSnapshotKey(message: { role?: string; content?: string; createdAt?: string | null }): string {
  const role = message.role === "user" ? "user" : message.role === "agent" || message.role === "assistant" ? "agent" : "";
  return `${role}\0${String(message.createdAt || "").trim()}\0${String(message.content || "").trim()}`;
}

export function cursorMessagesNeedingReconciliation<T extends CursorSyncMessage>(
  sessionId: string,
  local: T[],
  remote: RemoteCursorMessage[],
): T[] {
  const remoteSourceKeys = new Set(remote.map((message) => String(message.sourceKey || "")).filter(Boolean));
  const remoteCounts = new Map<string, number>();
  const localCounts = new Map<string, number>();
  for (const message of remote) {
    const key = logicalSnapshotKey(message);
    remoteCounts.set(key, (remoteCounts.get(key) || 0) + 1);
  }
  for (const message of local) {
    const key = logicalSnapshotKey(message);
    localCounts.set(key, (localCounts.get(key) || 0) + 1);
  }
  return local.filter((message) => {
    const expected = cursorExpectedSourceKey(sessionId, message);
    const logicalKey = logicalSnapshotKey(message);
    const remoteCount = remoteCounts.get(logicalKey) || 0;
    const localCount = localCounts.get(logicalKey) || 0;
    const role = message.role === "user" ? "user" : "agent";
    const editorPrefix = `editor:cursor:${sessionId}:${role}:`;
    const matchingEditorRows = remote.filter((candidate) => (
      logicalSnapshotKey(candidate) === logicalKey
      && String(candidate.sourceKey || "").startsWith(editorPrefix)
    ));

    // A remote row injected into Cursor survives extension reloads, while the
    // in-memory bubble provenance does not. An exact non-editor snapshot is
    // already represented remotely and must not be echoed back. Old editor
    // rows still get sent once so the server can canonicalize and collapse them.
    if (matchingEditorRows.length > 0) {
      return remoteCount > localCount || !expected || !remoteSourceKeys.has(expected);
    }
    if (expected && remoteSourceKeys.has(expected)) return false;
    return remoteCount < localCount;
  });
}

export function clearCursorSyncIdentityState(): void {
  nativeTurnByBubble.clear();
  remoteBubbles.clear();
  remoteSnapshots.clear();
}
