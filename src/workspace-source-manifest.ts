import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

export const SYNC_MANIFEST = ".chatdev-sync-manifest.json";
export const SYNC_STATUS = ".chatdev-sync-status.json";
export const PARTIAL_SUFFIX = ".chatdev-downloading";
export const INTERNAL_TEMP_PREFIX = ".chatdev-sync-part-";

export type WorkspaceSourceManifestEntry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  modifiedAtMs: number;
  sourceRevision: string;
  target?: string;
};

export type WorkspaceSourceManifest = {
  version: 1;
  manifestId: string;
  snapshotStartedAt: string;
  capturedAt: string;
  entryCount: number;
  digest: string;
  entries: WorkspaceSourceManifestEntry[];
};

export async function captureWorkspaceSourceManifest(
  workspacePath: string,
  excludedNames: Iterable<string> = [],
): Promise<WorkspaceSourceManifest> {
  const root = path.resolve(workspacePath);
  const excluded = new Set(excludedNames);
  const snapshotStartedAt = new Date().toISOString();
  const entries: WorkspaceSourceManifestEntry[] = [];

  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const children = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (ignoredWorkspacePath(relativePath, excluded)) continue;
      const absolutePath = path.join(absoluteDirectory, child.name);
      let metadata: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        metadata = await fs.lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (metadata.isDirectory()) {
        entries.push(sourceEntry(relativePath, "directory", metadata));
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        entries.push(sourceEntry(relativePath, "file", metadata));
      } else if (metadata.isSymbolicLink()) {
        const target = await fs.readlink(absolutePath);
        if (!portableSymlink(root, absolutePath, target)) continue;
        entries.push(sourceEntry(relativePath, "symlink", metadata, target));
      }
    }
  };

  await visit(root, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const capturedAt = new Date().toISOString();
  return {
    version: 1,
    manifestId: `manifest-${crypto.randomUUID()}`,
    snapshotStartedAt,
    capturedAt,
    entryCount: entries.length,
    digest: workspaceSourceManifestDigest(entries),
    entries,
  };
}

export function workspaceSourceManifestDigest(entries: WorkspaceSourceManifestEntry[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function ignoredWorkspacePath(relativePath: string, excludedNames: ReadonlySet<string>): boolean {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  return relativePath === SYNC_MANIFEST
    || relativePath === SYNC_STATUS
    || segments.some((segment) => segment === ".chatdev"
      || segment.endsWith(PARTIAL_SUFFIX)
      || segment.startsWith(INTERNAL_TEMP_PREFIX)
      || excludedNames.has(segment));
}

function sourceEntry(
  relativePath: string,
  kind: WorkspaceSourceManifestEntry["kind"],
  metadata: Awaited<ReturnType<typeof fs.lstat>>,
  target?: string,
): WorkspaceSourceManifestEntry {
  const mode = Number(metadata.mode) & 0o777;
  const size = kind === "file" ? Number(metadata.size) : 0;
  const modifiedAtMs = Math.trunc(Number(metadata.mtimeMs));
  const identity = kind === "symlink"
    ? `${kind}:${hash(target || "")}:${mode}`
    : `${kind}:${size}:${mode}:${modifiedAtMs}:${Math.trunc(Number(metadata.ctimeMs))}`;
  return {
    path: relativePath.split(path.sep).join(path.posix.sep),
    kind,
    size,
    mode,
    modifiedAtMs,
    sourceRevision: identity,
    ...(target !== undefined ? { target } : {}),
  };
}

function portableSymlink(root: string, absolutePath: string, target: string): boolean {
  if (!target || path.isAbsolute(target)) return false;
  const resolved = path.resolve(path.dirname(absolutePath), target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
