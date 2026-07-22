# Changelog

## 0.1.8

- Find current Cursor conversations from every supported transcript layout instead of dropping transcript-only conversations when older database entries exist.
- Keep a valid Cursor transcript when the editor database has metadata but no decoded messages.
- Read Cursor conversations and editor login data through the editor's built-in SQLite runtime, with the system SQLite command retained as a fallback for older editors.

## 0.1.7

- Automatically merge non-overlapping text edits made concurrently in the local editor and on chat.dev, then update the open Cursor or VS Code document with the combined file.
- Keep true overlaps, binary files, unusually large files, and edits whose common revision is no longer available as explicit conflict copies.

## 0.1.6

- Finish editor connection setup after conversations are attached while durable project-file synchronization continues in the background.
- Prevent the setup notification from remaining open until the last large project file transfers.

## 0.1.5

- Preserve the chat.dev origin and turn identity on messages mirrored into Cursor so transcript scans cannot send them back as new requests.
- Exclude chat.dev's generated Cursor conversation rule and its conflict copies from project file synchronization while continuing to synchronize user-authored Cursor rules.

## 0.1.4

- Use one deterministic path order for project listings on every operating system.
- Point live transfer progress at `.chatdev-sync-status.json`; `.chatdev-sync-manifest.json` remains the complete file list.

## 0.1.3

- Build and record a complete timestamped project listing before transferring the first workspace object.
- Make the browser's Create New Agent action wait for Cursor or VS Code to finish that manifest before creating the agent.
- Keep the expected-object snapshot in `.chatdev-sync-manifest.json` and mutable transfer progress in `.chatdev-sync-status.json`.
- Start workspace copying alongside conversation import instead of making either phase wait for the other.
- Retain remote file notifications through autosave races so the chat.dev editor refreshes clean files and automatically rebases pending text edits.

## 0.1.2

- Start the remote harness immediately and make each project object available as soon as that object is synchronized.
- Resume outbound operations and inbound changes from durable editor and worker journals after disconnects or restarts.
- Reconcile missed watcher events with per-path revisions, ordered cursors, idempotent operations, and compare-and-swap conflict copies.
- Keep `.chatdev-sync-manifest.json` as an explicit progress record and use `.chatdev-downloading` siblings until transferred files are verified and atomically installed.

## 0.1.1

- Resume unfinished project connections after Cursor, VS Code, agent, or worker restarts.
- Start live file and conversation mirroring only after the initial workspace and session transfer completes.
- Keep newer unsaved editor text from being overwritten by delayed remote file events.
- Recover stale agent startup attempts without waiting for the previous attempt to time out.

## 0.1.0

- Continue local Cursor, Codex, and Claude Code projects on a chat.dev agent while preserving detected conversations, models, harnesses, and session names.
- Mirror workspace files in both directions between the editor and chat.dev, including hidden files, Git data, empty directories, executable modes, symlinks, large files, deletes, and unsaved editor changes.
- Open a chat.dev agent as a VS Code or Cursor project with its remote filesystem, coding-agent session, terminal, and shell.
- Connect chat.dev sessions to Cursor's Agent panel, synchronize new turns with Simplify, and discover new local Cursor conversations as independent sessions on the shared machine.
- Choose the Default session, machine size, disk, model, budget, starting instructions, skills, and whether detected provider credentials are installed on one agent or made available account-wide.
- Use chat.dev models and tools from VS Code Chat through the `@chatdev` participant and language-model provider.
- Create or choose agents through editor panels and browser-led flows, with explicit recovery when an agent was deleted or project setup did not finish.
- Import conversation history before machine startup, retry unsupported local Cursor model aliases with the account default, and preserve actionable startup errors.
- Prevent transcript replay loops with durable turn identities, idempotent imports, and reconciliation of Cursor-generated replay records.
- Include illustrated installation and usage guides plus the proposed REST, realtime, OpenAPI, and MCP contracts required from chat.dev.
