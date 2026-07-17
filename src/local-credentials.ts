import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

export type LocalProviderCredentials = {
  provider: "codex" | "claude" | "cursor";
  values: Record<string, string>;
  sources: string[];
};

const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function findLocalProviderCredentials(provider: "codex" | "claude" | "cursor"): Promise<LocalProviderCredentials> {
  const values: Record<string, string> = {};
  const sources: string[] = [];

  if (provider === "codex") {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const auth = await readJsonCredential(path.join(codexHome, "auth.json"));
    if (auth) {
      values.CODEX_AUTH_JSON = auth;
      sources.push("Codex login");
    }
    addEnvironmentCredential(values, sources, "OPENAI_API_KEY");
  } else if (provider === "claude") {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const credentials = await readJsonCredential(path.join(claudeHome, ".credentials.json"));
    if (credentials) {
      values.CLAUDE_CREDENTIALS_JSON = credentials;
      sources.push("Claude Code login");
    }
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      addEnvironmentCredential(values, sources, key);
    }
  } else if (provider === "cursor") {
    const cursorAuth = await readFirstCursorCredential(cursorAuthPaths()) || await readCursorEditorCredential();
    if (cursorAuth) {
      values.CURSOR_AUTH_JSON = cursorAuth;
      sources.push("Cursor login");
    }
    addEnvironmentCredential(values, sources, "CURSOR_API_KEY");
  }

  return { provider, values, sources };
}

async function readCursorEditorCredential(): Promise<string | undefined> {
  const query = "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken')";
  for (const databasePath of cursorStateDatabasePaths()) {
    try {
      const metadata = await fs.stat(databasePath);
      if (!metadata.isFile()) continue;
      const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", databasePath, query], { maxBuffer: MAX_CREDENTIAL_FILE_BYTES });
      const rows = JSON.parse(stdout || "[]") as Array<{ key?: string; value?: string }>;
      const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      const accessToken = decodeStoredString(values["cursorAuth/accessToken"]);
      const refreshToken = decodeStoredString(values["cursorAuth/refreshToken"]);
      if (accessToken && refreshToken) return JSON.stringify({ accessToken, refreshToken });
    } catch {
      // Cursor CLI auth.json and CURSOR_API_KEY remain portable fallbacks.
    }
  }
  return undefined;
}

function decodeStoredString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(value);
    return typeof decoded === "string" && decoded.trim() ? decoded.trim() : value.trim() || undefined;
  } catch {
    return value.trim() || undefined;
  }
}

function cursorStateDatabasePaths(): string[] {
  const home = os.homedir();
  const paths = [
    process.env.APPDATA && path.join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  return [...new Set(paths.filter((item): item is string => !!item))];
}

async function readJsonCredential(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return undefined;
    const content = await fs.readFile(filePath, "utf8");
    JSON.parse(content);
    return content;
  } catch {
    return undefined;
  }
}

async function readFirstCursorCredential(filePaths: string[]): Promise<string | undefined> {
  for (const filePath of filePaths) {
    const content = await readJsonCredential(filePath);
    if (!content) continue;
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const hasLogin = typeof parsed.accessToken === "string" && !!parsed.accessToken
      && typeof parsed.refreshToken === "string" && !!parsed.refreshToken;
    if (hasLogin || (typeof parsed.apiKey === "string" && !!parsed.apiKey)) return content;
  }
  return undefined;
}

function cursorAuthPaths(): string[] {
  const paths = [
    process.env.CURSOR_AUTH_FILE,
    path.join(os.homedir(), ".cursor", "auth.json"),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "cursor", "auth.json"),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor", "auth.json"),
  ];
  if (process.env.APPDATA) {
    paths.push(path.join(process.env.APPDATA, "Cursor", "auth.json"));
    paths.push(path.join(process.env.APPDATA, "cursor", "auth.json"));
  }
  return [...new Set(paths.filter((item): item is string => !!item))];
}

function addEnvironmentCredential(values: Record<string, string>, sources: string[], key: string): void {
  const value = process.env[key];
  if (!value) return;
  values[key] = value;
  sources.push(key);
}
