import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureWorkspaceSourceManifest,
  workspaceSourceManifestDigest,
} from "../src/workspace-source-manifest.ts";

test("captures one sealed, sorted inventory before workspace transfer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chatdev-source-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "ignored"), { recursive: true });
  await writeFile(join(root, "README.md"), "project\n");
  await writeFile(join(root, "src", "main.ts"), "export {};\n");
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, "ignored", "private.txt"), "ignored\n");
  await writeFile(join(root, ".chatdev-sync-manifest.json"), "old protocol file\n");
  await symlink("main.ts", join(root, "src", "current.ts"));

  const manifest = await captureWorkspaceSourceManifest(root, ["ignored"]);

  assert.deepEqual(manifest.entries.map((entry) => entry.path), [
    ".git",
    ".git/HEAD",
    "README.md",
    "src",
    "src/current.ts",
    "src/main.ts",
  ]);
  assert.equal(manifest.entryCount, manifest.entries.length);
  assert.equal(manifest.digest, workspaceSourceManifestDigest(manifest.entries));
  assert.ok(Date.parse(manifest.capturedAt) >= Date.parse(manifest.snapshotStartedAt));
  assert.equal(manifest.entries.find((entry) => entry.path === "src/current.ts")?.target, "main.ts");
  assert.equal(manifest.entries.some((entry) => entry.path.includes("chatdev-sync")), false);
});
