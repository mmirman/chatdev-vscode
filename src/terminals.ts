import * as vscode from "vscode";
import type { Socket } from "socket.io-client";
import { ChatDevApi } from "./api";

abstract class RemotePseudoterminal implements vscode.Pseudoterminal {
  protected readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  protected readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;
  protected socket: Socket | undefined;
  protected dimensions = { columns: 120, rows: 30 };

  constructor(protected readonly api: ChatDevApi, protected readonly agentId: string) {}

  abstract open(): void;
  abstract handleInput(data: string): void;

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    this.resize();
  }

  protected abstract resize(): void;

  close(): void {
    this.socket?.disconnect();
    this.socket = undefined;
  }
}

export class AgentTerminal extends RemotePseudoterminal {
  constructor(api: ChatDevApi, agentId: string, private readonly threadId = agentId) {
    super(api, agentId);
  }

  open(): void {
    void this.connect().catch((error) => {
      this.writeEmitter.fire(`\r\n[chat.dev] ${error.message || error}\r\n`);
      this.closeEmitter.fire(1);
    });
  }

  handleInput(data: string): void {
    this.socket?.emit("stdin", { agentId: this.agentId, sessionId: this.threadId, threadId: this.threadId, data });
  }

  protected resize(): void {
    this.socket?.emit("resize", { agentId: this.agentId, sessionId: this.threadId, threadId: this.threadId, cols: this.dimensions.columns, rows: this.dimensions.rows });
  }

  private async connect(): Promise<void> {
    this.socket = await this.api.connectSocket();
    const render = (message: { agentId: string; sessionId?: string; threadId?: string; content?: string }) => {
      if (message.agentId === this.agentId && (message.sessionId || message.threadId || this.agentId) === this.threadId && message.content) this.writeEmitter.fire(message.content);
    };
    this.socket.on("output", render);
    this.socket.on("scrollback", ({ agentId, sessionId, threadId, messages }: { agentId: string; sessionId?: string; threadId?: string; messages: Array<{ content: string }> }) => {
      if (agentId === this.agentId && (sessionId || threadId || this.agentId) === this.threadId) for (const message of messages) if (message.content) this.writeEmitter.fire(message.content);
    });
    this.socket.on("scrollback_chunk", ({ agentId, sessionId, threadId, messages }: { agentId: string; sessionId?: string; threadId?: string; messages: Array<{ content: string }> }) => {
      if (agentId === this.agentId && (sessionId || threadId || this.agentId) === this.threadId) for (const message of messages) if (message.content) this.writeEmitter.fire(message.content);
    });
    this.socket.emit("join", { agentId: this.agentId, sessionId: this.threadId, threadId: this.threadId });
    this.resize();
    this.socket.emit("refresh_terminal", { agentId: this.agentId, sessionId: this.threadId, threadId: this.threadId });
  }
}

export class ShellTerminal extends RemotePseudoterminal {
  private sessionId: string | undefined;

  open(): void {
    void this.connect().catch((error) => {
      this.writeEmitter.fire(`\r\n[chat.dev] ${error.message || error}\r\n`);
      this.closeEmitter.fire(1);
    });
  }

  handleInput(data: string): void {
    if (this.sessionId) this.socket?.emit("shell_stdin", { agentId: this.agentId, sessionId: this.sessionId, data });
  }

  protected resize(): void {
    if (this.sessionId) this.socket?.emit("shell_resize", {
      agentId: this.agentId,
      sessionId: this.sessionId,
      cols: this.dimensions.columns,
      rows: this.dimensions.rows,
    });
  }

  override close(): void {
    if (this.sessionId) this.socket?.emit("shell_close", { agentId: this.agentId, sessionId: this.sessionId });
    super.close();
  }

  private async connect(): Promise<void> {
    this.socket = await this.api.connectSocket();
    this.socket.on("shell_output", ({ sessionId, data }: { sessionId: string; data: string }) => {
      if (sessionId === this.sessionId) this.writeEmitter.fire(data);
    });
    this.socket.on("shell_exit", ({ sessionId, exitCode }: { sessionId: string; exitCode?: number }) => {
      if (sessionId === this.sessionId) this.closeEmitter.fire(exitCode || 0);
    });
    const result = await emitAck<{ ok: boolean; sessionId?: string; error?: string }>(this.socket, "shell_open", {
      agentId: this.agentId,
      cols: this.dimensions.columns,
      rows: this.dimensions.rows,
      term: "xterm-256color",
    });
    if (!result.ok || !result.sessionId) throw new Error(result.error || "Could not open remote shell.");
    this.sessionId = result.sessionId;
  }
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chat.dev terminal request timed out.")), 15_000);
    socket.emit(event, payload, (result: T) => { clearTimeout(timer); resolve(result); });
  });
}
