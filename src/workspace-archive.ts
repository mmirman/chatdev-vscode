import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { create as createTar } from "tar";

export async function createWorkspaceArchive(
  root: vscode.Uri,
  excludes: Set<string>,
  relativePaths: string[],
): Promise<{ path: string; dispose(): Promise<void> }> {
  if (root.scheme !== "file") throw new Error("The initial workspace upload requires a local project folder.");
  if (!relativePaths.length) throw new Error("The selected project has no files to upload.");

  const archivePath = path.join(os.tmpdir(), `chatdev-workspace-${crypto.randomUUID()}.tar.gz`);
  await createTar({
    cwd: root.fsPath,
    file: archivePath,
    gzip: true,
    portable: true,
    follow: false,
    noDirRecurse: true,
    filter: (entryPath, stat) => {
      if (entryPath.split(/[\\/]+/).some((part) => excludes.has(part))) return false;
      const symbolicLink = "isSymbolicLink" in stat
        ? stat.isSymbolicLink()
        : stat.type === "SymbolicLink";
      if (!symbolicLink) return true;
      try {
        return !path.isAbsolute(fs.readlinkSync(path.resolve(root.fsPath, entryPath)));
      } catch {
        return false;
      }
    },
  }, relativePaths);
  return {
    path: archivePath,
    async dispose() {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(archivePath), { recursive: false, useTrash: false });
      } catch {}
    },
  };
}

export async function isPortableWorkspaceSymlink(uri: vscode.Uri): Promise<boolean> {
  try {
    return !path.isAbsolute(await fs.promises.readlink(uri.fsPath));
  } catch {
    return false;
  }
}
