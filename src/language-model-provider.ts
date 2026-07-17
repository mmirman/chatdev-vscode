import * as vscode from "vscode";
import { ChatDevApi, type EditorLanguageModel } from "./api";

type EditorContentPart =
  | { type: "text"; text: string }
  | { type: "data"; mimeType: string; dataBase64: string }
  | { type: "tool_call"; callId: string; name: string; input: object }
  | { type: "tool_result"; callId: string; content: EditorContentPart[] };

export class ChatDevLanguageModelProvider implements vscode.LanguageModelChatProvider<EditorLanguageModel>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  constructor(private readonly api: ChatDevApi) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<EditorLanguageModel[]> {
    if (!(await this.api.isSignedIn())) {
      if (options.silent) return [];
      await this.api.ensureSignedIn();
    }
    return this.api.listEditorLanguageModels();
  }

  async provideLanguageModelChatResponse(
    model: EditorLanguageModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    await this.api.ensureSignedIn();
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      await this.api.streamEditorLanguageModelChat({
        model: model.id,
        messages: messages.map((message) => ({
          role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user",
          ...(message.name ? { name: message.name } : {}),
          content: message.content.flatMap(serializePart),
        })),
        options: {
          tools: options.tools?.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto",
          ...(typeof options.modelOptions?.temperature === "number" ? { temperature: options.modelOptions.temperature } : {}),
          ...(typeof options.modelOptions?.maxOutputTokens === "number" ? { maxOutputTokens: options.modelOptions.maxOutputTokens } : {}),
        },
      }, (event) => {
        if (event.type === "text") progress.report(new vscode.LanguageModelTextPart(event.text));
        else if (event.type === "tool_call") progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, event.input));
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  async provideTokenCount(
    _model: EditorLanguageModel,
    value: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const text = typeof value === "string"
      ? value
      : value.content.flatMap(serializePart).map(partText).join("\n");
    return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
  }
}

function serializePart(part: unknown): EditorContentPart[] {
  if (part instanceof vscode.LanguageModelTextPart) return [{ type: "text", text: part.value }];
  if (part instanceof vscode.LanguageModelDataPart) {
    return [{ type: "data", mimeType: part.mimeType, dataBase64: Buffer.from(part.data).toString("base64") }];
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return [{ type: "tool_call", callId: part.callId, name: part.name, input: part.input }];
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return [{ type: "tool_result", callId: part.callId, content: part.content.flatMap(serializePart) }];
  }
  return [];
}

function partText(part: EditorContentPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "data") return Buffer.from(part.dataBase64, "base64").toString("utf8");
  if (part.type === "tool_call") return `${part.name} ${JSON.stringify(part.input)}`;
  return part.content.map(partText).join("\n");
}
