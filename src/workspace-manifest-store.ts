import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { WorkspaceSourceManifest } from "./workspace-source-manifest";

export async function persistWorkspaceSourceManifest(
  storagePath: string,
  token: string,
  manifest: WorkspaceSourceManifest,
): Promise<void> {
  const destination = workspaceSourceManifestPath(storagePath, token);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readWorkspaceSourceManifest(
  storagePath: string,
  token: string,
  expectedManifestId?: string | null,
): Promise<WorkspaceSourceManifest | undefined> {
  try {
    const candidate = JSON.parse(await fs.readFile(workspaceSourceManifestPath(storagePath, token), "utf8")) as WorkspaceSourceManifest;
    if (candidate.version !== 1
      || !Array.isArray(candidate.entries)
      || candidate.entryCount !== candidate.entries.length
      || candidate.digest !== crypto.createHash("sha256").update(JSON.stringify(candidate.entries)).digest("hex")
      || (expectedManifestId && candidate.manifestId !== expectedManifestId)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

export async function deleteWorkspaceSourceManifest(storagePath: string, token: string): Promise<void> {
  await fs.rm(workspaceSourceManifestPath(storagePath, token), { force: true }).catch(() => undefined);
}

export function workspaceSourceManifestPath(storagePath: string, token: string): string {
  const fileName = token.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(storagePath, "handoff-manifests", `${fileName}.json`);
}
