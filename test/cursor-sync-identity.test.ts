import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCursorSyncIdentityState,
  cursorMessagesNeedingReconciliation,
  cursorNativeRequestId,
  dedupeCursorTranscriptMessages,
  reconcileCursorTranscriptMessages,
  recordCursorNativeTurn,
  recordCursorRemoteBubbles,
} from "../src/cursor-sync-identity.ts";

test.beforeEach(() => clearCursorSyncIdentityState());

test("uses Cursor's request id as the native transaction id", () => {
  assert.equal(cursorNativeRequestId("request-123", "bubble-456", "fallback-789"), "request-123");
  assert.equal(cursorNativeRequestId("bad", "bubble-456", "fallback-789"), "bubble-456");
});

test("collapses replay clones with new bubble ids and the same original timestamp", () => {
  const messages = dedupeCursorTranscriptMessages([
    { role: "assistant" as const, content: "same answer", createdAt: "2026-07-17T02:31:49.156Z", sourceId: "bubble-111" },
    { role: "assistant" as const, content: "same answer", createdAt: "2026-07-17T02:31:49.156Z", sourceId: "bubble-222" },
  ]);
  assert.equal(messages.length, 1);
});

test("collapses replay clones even when Cursor regenerates their request ids", () => {
  const messages = dedupeCursorTranscriptMessages([
    {
      role: "user" as const,
      content: "zomg",
      createdAt: "2026-07-17T02:31:49.156Z",
      sourceId: "bubble-111",
      turnId: "request-111",
    },
    {
      role: "user" as const,
      content: "zomg",
      createdAt: "2026-07-17T02:31:49.156Z",
      sourceId: "bubble-222",
      turnId: "request-222",
    },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].turnId, "request-111");
});

test("preserves intentional repeated messages from different times", () => {
  const messages = dedupeCursorTranscriptMessages([
    { role: "user" as const, content: "retry", createdAt: "2026-07-17T02:31:49.156Z", sourceId: "bubble-111" },
    { role: "user" as const, content: "retry", createdAt: "2026-07-17T02:32:49.156Z", sourceId: "bubble-222" },
  ]);
  assert.equal(messages.length, 2);
});

test("maps the native user bubble to its request id before transcript import", () => {
  recordCursorNativeTurn("session-123", "bubble-123", "request-123");
  const [message] = reconcileCursorTranscriptMessages("session-123", [
    { role: "user" as const, content: "zomg", createdAt: "2026-07-17T02:31:49.156Z", sourceId: "bubble-123" },
  ]);
  assert.equal(message.turnId, "request-123");
});

test("does not send a server-originated bubble back through transcript import", () => {
  recordCursorRemoteBubbles("session-123", [{
    bubbleId: "bubble-remote-123",
    type: 1,
    text: "from chat.dev",
    createdAt: "2026-07-17T02:31:49.156Z",
  }]);
  const messages = reconcileCursorTranscriptMessages("session-123", [
    { role: "user" as const, content: "from chat.dev", createdAt: "2026-07-17T02:31:49.156Z", sourceId: "bubble-remote-123" },
  ]);
  assert.deepEqual(messages, []);
});

test("does not echo a remote bubble cloned under a new Cursor id", () => {
  recordCursorRemoteBubbles("session-123", [{
    bubbleId: "bubble-remote-123",
    type: 2,
    text: "remote answer",
    createdAt: "2026-07-17T02:31:49.156Z",
  }]);
  const messages = reconcileCursorTranscriptMessages("session-123", [
    { role: "assistant" as const, content: "remote answer", createdAt: "2026-07-17T02:31:49.156Z", sourceId: "bubble-clone-456" },
  ]);
  assert.deepEqual(messages, []);
});

test("reconciles old unstable source keys even when their text is already remote", () => {
  const local = [{
    role: "assistant" as const,
    content: "same answer",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceId: "bubble-new-123",
  }];
  const pending = cursorMessagesNeedingReconciliation("session-123", local, [{
    role: "agent",
    content: "same answer",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceKey: "editor:cursor:session-123:agent:source:bubble-old-123",
  }]);
  assert.deepEqual(pending, local);
});

test("does not resend a transcript event after its canonical identity is remote", () => {
  const local = [{
    role: "user" as const,
    content: "zomg",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceId: "bubble-123",
    turnId: "request-123",
  }];
  const pending = cursorMessagesNeedingReconciliation("session-123", local, [{
    role: "user",
    content: "zomg",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceKey: "turn:request-123:user",
  }]);
  assert.deepEqual(pending, []);
});

test("does not echo an injected server event after the extension reloads", () => {
  const local = [{
    role: "assistant" as const,
    content: "remote answer",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceId: "bubble-clone-456",
  }];
  const pending = cursorMessagesNeedingReconciliation("session-123", local, [{
    role: "agent",
    content: "remote answer",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceKey: "turn:request-123:final",
  }]);
  assert.deepEqual(pending, []);
});

test("sends a native event once when an old editor clone also exists", () => {
  const local = [{
    role: "user" as const,
    content: "zomg",
    createdAt: "2026-07-17T02:31:49.156Z",
    sourceId: "bubble-123",
    turnId: "request-123",
  }];
  const pending = cursorMessagesNeedingReconciliation("session-123", local, [
    {
      role: "user",
      content: "zomg",
      createdAt: "2026-07-17T02:31:49.156Z",
      sourceKey: "turn:request-123:user",
    },
    {
      role: "user",
      content: "zomg",
      createdAt: "2026-07-17T02:31:49.156Z",
      sourceKey: "editor:cursor:session-123:user:source:bubble-old-123",
    },
  ]);
  assert.deepEqual(pending, local);
});
