import * as vscode from "vscode";
import { sendChatParticipantRequest } from "@vscode/chat-extension-utils";
import { ChatDevApi } from "./api";

const PARTICIPANT_ID = "chatdev.agent";

export function registerChatDevParticipant(context: vscode.ExtensionContext, api: ChatDevApi): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token) => {
    try {
      const model = await selectChatDevModel(request.model, api);
      const result = sendChatParticipantRequest(request, chatContext, {
        model,
        prompt: "Work on the user's current editor task. Use the available editor tools when they are useful, and report the concrete result.",
        tools: vscode.lm.tools,
        requestJustification: "Use chat.dev to work on the current editor request",
        responseStreamOptions: { stream: response, references: true, responseText: true },
        extensionMode: context.extensionMode,
      }, token);
      return await result.result;
    } catch (error) {
      if (token.isCancellationRequested) return;
      return { errorDetails: { message: error instanceof Error ? error.message : String(error) } };
    }
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  return participant;
}

async function selectChatDevModel(selected: vscode.LanguageModelChat, api: ChatDevApi): Promise<vscode.LanguageModelChat> {
  if (selected.vendor === "chatdev") return selected;
  await api.ensureSignedIn();
  const models = await vscode.lm.selectChatModels({ vendor: "chatdev" });
  if (!models.length) throw new Error("No chat.dev model is available in this editor. Choose chat.dev from Manage Models and try again.");
  return models[0];
}
