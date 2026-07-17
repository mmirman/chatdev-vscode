const vscode = require("vscode");

let providerRegistration;
let refreshTimer;
let mainReady = false;

async function refreshProvider() {
  let enabled = false;
  try {
    enabled = !!(await vscode.commands.executeCommand("chatdev.internal.cursorProviderEnabled"));
  } catch {}

  if (!enabled) {
    providerRegistration?.dispose();
    providerRegistration = undefined;
    mainReady = false;
    return false;
  }
  if (!providerRegistration) {
    if (!vscode.cursor || typeof vscode.cursor.registerAgentProvider !== "function") {
      throw new Error("This Cursor build does not expose its native Agent provider API.");
    }

    providerRegistration = vscode.cursor.registerAgentProvider({
      createAgent(sessionId, options) {
        void vscode.commands.executeCommand(
          "chatdev.internal.cursorAgentCreated",
          { sessionId, state: options?.state || {} },
        );
        const handlePromise = vscode.commands.executeCommand(
          "chatdev.internal.createCursorAgentHandle",
          { sessionId, options },
        );
        return {
          async *run(runOptions) {
            const handle = await handlePromise;
            if (!handle || typeof handle.run !== "function") {
              throw new Error("The chat.dev extension did not return a Cursor Agent session.");
            }
            for await (const update of handle.run(runOptions)) yield update;
          },
        };
      },
    });
  }
  if (!mainReady) {
    await vscode.commands.executeCommand("chatdev.internal.cursorBridgeReady");
    mainReady = true;
  }
  return true;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("chatdev.cursorBridge.refresh", refreshProvider),
    { dispose: () => providerRegistration?.dispose() },
  );
  void refreshProvider();
  refreshTimer = setInterval(() => { void refreshProvider(); }, 5_000);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

function deactivate() {
  if (refreshTimer) clearInterval(refreshTimer);
  providerRegistration?.dispose();
  providerRegistration = undefined;
  mainReady = false;
}

module.exports = { activate, deactivate };
