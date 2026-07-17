import * as vscode from "vscode";
import { type Agent, ChatDevApi } from "./api";
import { currentMirroredAgentId } from "./workspace-mirror";

type ActionDefinition = {
  label: string;
  description: string;
  tooltip: string;
  command: string;
  icon: string;
};

export class ActionsViewProvider implements vscode.TreeDataProvider<ActionItem> {
  private readonly changed = new vscode.EventEmitter<ActionItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly api: ChatDevApi) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: ActionItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<ActionItem[]> {
    if (!(await this.api.isSignedIn())) {
      return [new ActionItem({
        label: "Sign in to chat.dev",
        description: "Connect VS Code or Cursor",
        tooltip: "Open chat.dev in your browser and connect this editor.",
        command: "chatdev.signIn",
        icon: "sign-in",
      })];
    }
    const connectedWorkspace = (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === "chatdev") ?? false)
      || !!currentMirroredAgentId(this.api.serverUrl);
    if (connectedWorkspace) {
      const cursorActions = /cursor/i.test(vscode.env.appName) ? [
        new ActionItem({
          label: "Cursor Agent",
          description: "Open a shared session",
          tooltip: "Open a chat.dev session as a real conversation in Cursor's Agent panel.",
          command: "chatdev.openCursorAgentSession",
          icon: "comment-discussion",
        }),
      ] : [];
      return [
        new ActionItem({
          label: "New",
          description: "Create another agent from this project",
          tooltip: "Choose a Default local session and machine, then create another chat.dev agent and connect this project to it.",
          command: "chatdev.moveSession",
          icon: "add",
        }),
        new ActionItem({
          label: "Open",
          description: "Switch to another agent",
          tooltip: "Choose another chat.dev agent and open its live project and sessions in this editor.",
          command: "chatdev.openAgent",
          icon: "remote-explorer",
        }),
        ...cursorActions,
        new ActionItem({
          label: /cursor/i.test(vscode.env.appName) ? "Terminal" : "Agent",
          description: "Open a coding CLI",
          tooltip: "Choose and open a live coding-agent terminal running on this chat.dev machine.",
          command: "chatdev.openAgentTerminal",
          icon: "terminal",
        }),
        new ActionItem({
          label: "Shell",
          description: "Open the agent machine",
          tooltip: "Open a separate shell on this chat.dev machine.",
          command: "chatdev.openShell",
          icon: "terminal-bash",
        }),
        new ActionItem({
          label: "Sign out",
          description: "Disconnect this editor",
          tooltip: "Sign this VS Code or Cursor installation out of chat.dev.",
          command: "chatdev.signOut",
          icon: "sign-out",
        }),
      ];
    }
    return [
      new ActionItem({
        label: "Continue",
        description: "Make this project available on chat.dev",
        tooltip: "Choose the Default local session, machine, and provider login settings, then create the remote agent with every local session.",
        command: "chatdev.moveSession",
        icon: "cloud-upload",
      }),
      new ActionItem({
        label: "Open",
        description: "Bring an agent into this editor",
        tooltip: "Choose an agent, then open its live project in this editor window.",
        command: "chatdev.openAgent",
        icon: "remote-explorer",
      }),
      new ActionItem({
        label: "Native shortcuts",
        description: "Ctrl/Cmd+Alt+Shift+C or O",
        tooltip: "Stay inside the editor: Ctrl+Alt+Shift+C (Cmd+Alt+Shift+C on macOS) continues a project; Ctrl+Alt+Shift+O (Cmd+Alt+Shift+O on macOS) opens an agent.",
        command: "chatdev.openGuide",
        icon: "keyboard",
      }),
      new ActionItem({
        label: "Sign out",
        description: "Disconnect this editor",
        tooltip: "Sign this VS Code or Cursor installation out of chat.dev.",
        command: "chatdev.signOut",
        icon: "sign-out",
      }),
    ];
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(definition: ActionDefinition) {
    super(definition.label, vscode.TreeItemCollapsibleState.None);
    this.description = definition.description;
    this.tooltip = definition.tooltip;
    this.iconPath = new vscode.ThemeIcon(definition.icon);
    this.command = { command: definition.command, title: definition.label };
  }
}

export class AgentsViewProvider implements vscode.TreeDataProvider<AgentItem> {
  private readonly changed = new vscode.EventEmitter<AgentItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly api: ChatDevApi) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: AgentItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<AgentItem[]> {
    if (!(await this.api.isSignedIn())) return [];
    try {
      const agents = (await this.api.listAgents())
        .filter((agent) => agent.status !== "deleted" && agent.agentRuntime !== "tool-agent")
        .sort((left, right) => left.name.localeCompare(right.name));
      return agents.map((agent) => new AgentItem(agent));
    } catch (error) {
      return [new AgentItem(undefined, error instanceof Error ? error.message : String(error))];
    }
  }
}

export class AgentItem extends vscode.TreeItem {
  constructor(readonly agent?: Agent, error?: string) {
    super(agent?.name || "Could not load agents", vscode.TreeItemCollapsibleState.None);
    if (!agent) {
      this.iconPath = new vscode.ThemeIcon("error");
      this.tooltip = error;
      return;
    }
    this.contextValue = "chatdevAgent";
    this.description = `${agent.status} · ${agent.machineSize || "standard"} · ${runtimeLabel(agent.agentRuntime)}`;
    this.iconPath = new vscode.ThemeIcon(agent.status === "running" ? "vm-running" : "vm-outline");
    this.tooltip = new vscode.MarkdownString([
      `**${agent.name}**`,
      "",
      `${this.description}`,
      "",
      "Click to open the agent's live project and coding sessions together. File changes sync in both directions.",
    ].join("\n"));
    this.command = {
      command: "chatdev.openAgentItem",
      title: "Open Agent",
      arguments: [agent],
    };
  }
}

function runtimeLabel(runtime?: string | null): string {
  if (runtime === "claude-code-tmux") return "Claude Code";
  if (runtime === "cursor-agent-tmux") return "Cursor Agent";
  if (runtime === "codex-tmux") return "Codex";
  return runtime || "coding agent";
}
