import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceSyncJournal } from "../src/workspace-sync-journal.ts";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "chatdev-sync-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    storageDirectory: directory,
    serverUrl: "https://api.chat.dev",
    agentId: "agent-test",
    workspacePath: join(directory, "workspace"),
    clientId: "client-original",
  };
  return { directory, input, journal: await WorkspaceSyncJournal.open(input) };
}

test("persists an inflight operation and resumes it as queued with the original client identity", async (t) => {
  const value = await fixture(t);
  await value.journal.replaceRemoteManifest([], 0);
  const operation = await value.journal.enqueue({ path: "src/main.ts", inlineData: Buffer.from("first\n") });
  await value.journal.markInflight(operation.path, operation.version);

  const reopened = await WorkspaceSyncJournal.open({ ...value.input, clientId: "client-from-reinstalled-extension" });
  assert.equal(reopened.clientId, "client-original");
  assert.equal(reopened.nextReadyOperations(1)[0]?.opId, operation.opId);
});

test("does not release local operations until a remote baseline is durable", async (t) => {
  const { journal } = await fixture(t);
  const operation = await journal.enqueue({ path: "README.md" });
  assert.deepEqual(journal.nextReadyOperations(1), []);

  await journal.replaceRemoteManifest([{
    path: "README.md",
    type: "file",
    revision: "f:remote:420",
    size: 6,
    mode: 0o644,
  }], 4);
  assert.equal(journal.nextReadyOperations(1)[0]?.baseRevision, "f:remote:420");
  assert.equal(journal.nextReadyOperations(1)[0]?.version, operation.version);
});

test("coalesces queued edits but keeps a later edit behind an inflight operation", async (t) => {
  const { journal } = await fixture(t);
  await journal.replaceRemoteManifest([], 0);
  const first = await journal.enqueue({ path: "notes.txt", inlineData: Buffer.from("one") });
  const replacement = await journal.enqueue({ path: "notes.txt", inlineData: Buffer.from("two") });
  assert.equal(journal.nextReadyOperations(1)[0]?.version, replacement.version);
  assert.notEqual(first.version, replacement.version);

  await journal.markInflight(replacement.path, replacement.version);
  const later = await journal.enqueue({ path: "notes.txt", inlineData: Buffer.from("three") });
  assert.equal(journal.nextReadyOperations(2).length, 0);
  await journal.acknowledge({
    path: replacement.path,
    version: replacement.version,
    revision: "f:two:420",
    entry: { type: "file", revision: "f:two:420", size: 3, mode: 0o644 },
    remotelyApplied: true,
    serverCursor: 8,
  });
  assert.equal(journal.nextReadyOperations(1)[0]?.version, later.version);
  assert.equal(journal.nextReadyOperations(1)[0]?.baseRevision, "f:two:420");
  assert.equal(journal.lastAppliedVersion, replacement.version);
});

test("persists received remote events before advancing the cursor", async (t) => {
  const value = await fixture(t);
  await value.journal.replaceRemoteManifest([], 0);
  await value.journal.stageRemoteChanges([{
    sequence: 11,
    path: "remote.txt",
    kind: "file",
    revision: "f:new:420",
    size: 3,
    mode: 0o644,
  }], 11);

  let reopened = await WorkspaceSyncJournal.open(value.input);
  assert.equal(reopened.remoteCursor, 11);
  const pending = reopened.pendingRemoteChanges()[0];
  assert.equal(pending.sequence, 11);
  await reopened.beginRemoteApply(pending.id, null);

  reopened = await WorkspaceSyncJournal.open(value.input);
  assert.equal(reopened.pendingRemoteChanges()[0].status, "applying");
  assert.equal(reopened.known("remote.txt")?.revision, "f:new:420");
  assert.equal(reopened.knownSequence("remote.txt"), 11);
});

test("discarding a changed large-file attempt releases its successor with the original baseline", async (t) => {
  const { journal } = await fixture(t);
  await journal.replaceRemoteManifest([{
    path: "large.bin",
    type: "file",
    revision: "f:old:420",
    size: 10,
    mode: 0o644,
  }], 2);
  const first = await journal.enqueue({ path: "large.bin", sizeHint: 10 });
  await journal.markInflight(first.path, first.version);
  const successor = await journal.enqueue({ path: "large.bin", sizeHint: 20 });
  await journal.discard(first.path, first.version);
  assert.equal(journal.nextReadyOperations(1)[0]?.version, successor.version);
  assert.equal(journal.nextReadyOperations(1)[0]?.baseRevision, "f:old:420");
});
