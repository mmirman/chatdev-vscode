import assert from "node:assert/strict";
import test from "node:test";
import {
  APPEND_COMPOSER_MESSAGES_COMMAND,
  PRUNE_COMPOSER_MESSAGES_COMMAND,
  PRUNE_COMPOSER_MESSAGES_PATCH_MARKER,
  patchCursorWorkbenchSource,
} from "../src/cursor-workbench-patch.ts";

const cursorFixture = [
  'isModelCompatibleWithClaudeCodeBackend(x){return x==="chat.dev"||this.isModelInOverrideList(x)}',
  'getAgentBackendForFirstSubmit(x){if(x.modelName==="chat.dev")return{agentBackend:"claude-code",applyAgentBackendTypeRestrictions:false,restrictAgentModeSwitching:true};const y=1}',
  'registry.registerCommand("existing",()=>{});',
  'var ComposerHandleCommand=class extends CommandBase{constructor(){super({title:{value:"Get Composer Handle By Id",original:"Get Composer Handle By Id"}})}async run(accessor,id){return accessor.get(ComposerService).getComposerHandleById(id)}};',
  'decorate(ComposerHandleCommand);',
  'const chatdevOnDiskChecksumV2=true;',
].join("");

test("adds idempotent append and duplicate-pruning composer commands", () => {
  const patched = patchCursorWorkbenchSource(cursorFixture);

  assert.ok(patched.includes(APPEND_COMPOSER_MESSAGES_COMMAND));
  assert.ok(patched.includes(PRUNE_COMPOSER_MESSAGES_COMMAND));
  assert.ok(patched.includes(PRUNE_COMPOSER_MESSAGES_PATCH_MARKER));
  assert.ok(patched.includes("getConversationFromBubble"));
  assert.ok(patched.includes("fullConversationHeadersOnly"));
  assert.ok(patched.includes("deleteComposerBubbles"));
  assert.equal(patchCursorWorkbenchSource(patched), patched);
});

test("replaces an older duplicate-pruning command", () => {
  const legacy = cursorFixture.replace(
    "decorate(ComposerHandleCommand);",
    `decorate(ComposerHandleCommand);registry.registerCommand("${PRUNE_COMPOSER_MESSAGES_COMMAND}",async()=>0);`,
  );
  const patched = patchCursorWorkbenchSource(legacy);

  assert.ok(patched.includes(PRUNE_COMPOSER_MESSAGES_PATCH_MARKER));
  assert.ok(patched.includes("getConversationFromBubble"));
  assert.ok(!patched.includes(`${PRUNE_COMPOSER_MESSAGES_COMMAND}",async()=>0`));
  assert.equal(patched.match(new RegExp(PRUNE_COMPOSER_MESSAGES_COMMAND.replaceAll(".", "\\."), "g"))?.length, 2);
});
