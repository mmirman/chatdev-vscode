import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type DatabaseSync = {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
};

type NodeSqlite = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
};

let nodeSqlite: NodeSqlite | null | undefined;

export async function querySqlite<T>(dbPath: string, sql: string, maxBuffer = 32 * 1024 * 1024): Promise<T[]> {
  const sqlite = loadNodeSqlite();
  if (sqlite) {
    try {
      const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        return database.prepare(sql).all() as T[];
      } finally {
        database.close();
      }
    } catch (nodeError) {
      try {
        return await querySqliteCommand<T>(dbPath, sql, maxBuffer);
      } catch {
        throw nodeError;
      }
    }
  }

  return querySqliteCommand<T>(dbPath, sql, maxBuffer);
}

async function querySqliteCommand<T>(dbPath: string, sql: string, maxBuffer: number): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    timeout: 8_000,
    maxBuffer,
  });
  return stdout.trim() ? JSON.parse(stdout) as T[] : [];
}

function loadNodeSqlite(): NodeSqlite | undefined {
  if (nodeSqlite !== undefined) return nodeSqlite || undefined;
  try {
    // Cursor and current VS Code use a Node runtime with the built-in SQLite API.
    // Keep the command-line fallback for older compatible editor releases.
    const runtimeRequire = eval("require") as NodeRequire;
    nodeSqlite = runtimeRequire("node:sqlite") as NodeSqlite;
  } catch {
    nodeSqlite = null;
  }
  return nodeSqlite || undefined;
}
