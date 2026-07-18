import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureWorkspaceSourceManifest } from "../src/workspace-source-manifest.ts";
import {
  deleteWorkspaceSourceManifest,
  persistWorkspaceSourceManifest,
  readWorkspaceSourceManifest,
  workspaceSourceManifestPath,
} from "../src/workspace-manifest-store.ts";

test("persists the Create-time manifest atomically across editor restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chatdev-manifest-store-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "project\n");
  const manifest = await captureWorkspaceSourceManifest(workspace);
  const token = "../handoff/token";

  await persistWorkspaceSourceManifest(storage, token, manifest);

  const persistedPath = workspaceSourceManifestPath(storage, token);
  assert.ok(persistedPath.startsWith(join(storage, "handoff-manifests")));
  assert.equal((await stat(persistedPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readWorkspaceSourceManifest(storage, token, manifest.manifestId), manifest);
  assert.equal(await readWorkspaceSourceManifest(storage, token, "different-manifest"), undefined);
  assert.equal(JSON.parse(await readFile(persistedPath, "utf8")).digest, manifest.digest);

  await deleteWorkspaceSourceManifest(storage, token);
  assert.equal(await readWorkspaceSourceManifest(storage, token), undefined);
});
