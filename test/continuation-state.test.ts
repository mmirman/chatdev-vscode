import assert from "node:assert/strict";
import test from "node:test";
import { continuationFailureMessage, isAgentNotFoundError, replacementAgentName } from "../src/continuation-state.ts";

test("chooses a new non-conflicting name when moving a project connection", () => {
  assert.equal(replacementAgentName("payments", [
    { name: "payments", status: "errored" },
    { name: "payments-2", status: "running" },
  ]), "payments-3");
});

test("deleted agents do not reserve a replacement name", () => {
  assert.equal(replacementAgentName("payments", [
    { name: "payments", status: "deleted" },
  ]), "payments");
});

test("recognizes stale agent failures without swallowing unrelated errors", () => {
  const notFound = Object.assign(new Error("request failed"), { status: 404 });
  assert.equal(isAgentNotFoundError(notFound), true);
  assert.equal(isAgentNotFoundError(new Error("Agent was deleted")), true);
  assert.equal(isAgentNotFoundError(new Error("Network unavailable")), false);
});

test("turns stale-agent retries into an explicit replacement action", () => {
  assert.equal(
    continuationFailureMessage(Object.assign(new Error("Agent not found"), { status: 404 })),
    "The previous chat.dev agent no longer exists. In the browser, choose Start New Agent and Move Connection.",
  );
  assert.match(
    continuationFailureMessage(new Error("Upload timed out")),
    /Try Again in Editor or Start New Agent and Move Connection/,
  );
});
