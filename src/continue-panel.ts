import * as crypto from "crypto";
import * as vscode from "vscode";

export type ContinuePanelConversation = {
  id: string;
  title: string;
  provider: "codex" | "claude" | "cursor";
  model?: string;
  mtime: number;
  credentialSources: string[];
  remoteLabel: string;
};

export type ContinuePanelMachineTier = {
  id: ContinuePanelSettings["machineSize"];
  label: string;
  cpuKind: "shared" | "performance";
  cpus: number;
  memoryMb: number;
  volumeGb: number;
  monthlyUsd: number;
  gpuKind?: string;
};

export type ContinuePanelSettings = {
  mainSessionId: string;
  name: string;
  machineSize: "standard" | "pro" | "max" | "gpu";
  volumeGb?: number;
  credentialScope: "global" | "agent" | "none";
  model?: string;
  maxBudgetUsd?: number;
  systemPrompt?: string;
};

type PanelOptions = {
  projectName: string;
  conversations: ContinuePanelConversation[];
  machineTiers: ContinuePanelMachineTier[];
  initialSettings?: ContinuePanelSettings;
  existingAgentName?: string;
};

export type ContinuePanelIntent = "continue" | "replace";

export async function showContinueProjectPanel<T>(
  options: PanelOptions,
  submit: (
    settings: ContinuePanelSettings,
    report: (message: string) => void,
    dismiss: () => void,
    intent: ContinuePanelIntent,
  ) => Promise<T>,
): Promise<T | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "chatdevContinueProject",
    "Continue on chat.dev",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderPanel(panel.webview.cspSource, options);

  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    let submitting = false;
    let dismissed = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      panel.dispose();
    };

    panel.onDidDispose(() => {
      dismissed = true;
      if (!submitting) finish(undefined);
    });
    panel.webview.onDidReceiveMessage(async (message: { type?: string; settings?: ContinuePanelSettings; intent?: ContinuePanelIntent }) => {
      if (message.type === "cancel") {
        panel.dispose();
        return;
      }
      if (message.type !== "submit" || !message.settings || submitting) return;
      submitting = true;
      panel.webview.postMessage({ type: "busy", message: message.intent === "replace" ? "Creating a new agent" : "Preparing the agent" });
      try {
        const value = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Continuing ${options.projectName} on chat.dev`,
          cancellable: false,
        }, async (progress) => submit(message.settings!, (status) => {
          progress.report({ message: status });
          if (!dismissed) void panel.webview.postMessage({ type: "progress", message: status });
        }, dismiss, message.intent === "replace" ? "replace" : "continue"));
        if (!dismissed) {
          await panel.webview.postMessage({ type: "complete", message: "Project and sessions ready" });
          await delay(300);
        }
        finish(value);
        dismiss();
      } catch (error) {
        submitting = false;
        if (dismissed) {
          finish(undefined);
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        } else {
          void panel.webview.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  });
}

function renderPanel(cspSource: string, options: PanelOptions): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const state = JSON.stringify(options).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.45 var(--vscode-font-family); }
    main { width: min(760px, calc(100% - 40px)); margin: 0 auto; padding: 28px 0 44px; }
    header { padding-bottom: 18px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0; }
    .project { margin-top: 5px; color: var(--vscode-descriptionForeground); }
    section { padding: 20px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    h2 { margin: 0 0 14px; font-size: 13px; font-weight: 600; letter-spacing: 0; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .field { min-width: 0; }
    .wide { grid-column: 1 / -1; }
    label, legend { display: block; margin: 0 0 6px; color: var(--vscode-foreground); font-weight: 500; }
    input, select, textarea { width: 100%; min-height: 34px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 7px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; outline: none; }
    input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    textarea { min-height: 76px; resize: vertical; }
    .hint { margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .notice { margin-top: 16px; border-left: 3px solid var(--vscode-notificationsWarningIcon-foreground); padding: 9px 11px; color: var(--vscode-foreground); background: var(--vscode-textBlockQuote-background); }
    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    .segments { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--vscode-panel-border); }
    .segment { position: relative; min-width: 0; border-right: 1px solid var(--vscode-panel-border); }
    .segment:last-child { border-right: 0; }
    .segment input { position: absolute; opacity: 0; pointer-events: none; }
    .segment label { min-height: 72px; margin: 0; padding: 9px; cursor: pointer; background: var(--vscode-editor-background); }
    .segment input:checked + label { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .segment strong, .segment small { display: block; overflow-wrap: anywhere; }
    .segment small { margin-top: 2px; color: var(--vscode-descriptionForeground); font-weight: 400; }
    .segment input:checked + label small { color: inherit; opacity: .82; }
    .credentials { display: grid; gap: 8px; }
    .choice { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; margin: 0; font-weight: 400; cursor: pointer; }
    .choice input { width: 16px; min-height: 16px; margin: 2px 0 0; }
    details { padding-top: 18px; }
    summary { cursor: pointer; font-weight: 600; }
    details .grid { margin-top: 14px; }
    footer { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    #status { min-width: 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    #status.error { color: var(--vscode-errorForeground); }
    .actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    button { min-height: 34px; border: 1px solid transparent; border-radius: 2px; padding: 7px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-button-secondaryBackground, var(--vscode-panel-border)); }
    button:disabled { opacity: .55; cursor: default; }
    [hidden] { display: none !important; }
    @media (max-width: 620px) { main { width: calc(100% - 24px); padding-top: 18px; } .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } .segments { grid-template-columns: repeat(2, minmax(0, 1fr)); } .segment:nth-child(2) { border-right: 0; } .segment:nth-child(-n+2) { border-bottom: 1px solid var(--vscode-panel-border); } footer { align-items: flex-start; flex-direction: column; } .actions { width: 100%; } .actions button { flex: 1; } }
  </style>
</head>
<body>
  <main>
    <header><h1>Continue on chat.dev</h1><div class="project" id="project-name"></div>${options.existingAgentName ? `<div class="notice">${escapeHtml(options.existingAgentName)} was not fully connected. You can finish it or start a new agent and move this project's connection.</div>` : ""}</header>
    <form id="form">
      <section>
        <div class="grid">
          <div class="field wide"><label for="conversation">Main session</label><select id="conversation"></select><div class="hint" id="conversation-meta"></div><div class="hint">All ${options.conversations.length} local session${options.conversations.length === 1 ? "" : "s"} will be transferred. New messages normally go to the Main session.</div></div>
          <div class="field"><label for="name">Agent name</label><input id="name" maxlength="100" required pattern="[a-zA-Z0-9_.\\/-]+"></div>
          <div class="field"><label for="model">Model</label><input id="model" maxlength="200" placeholder="Use the conversation default"></div>
        </div>
      </section>
      <section>
        <fieldset><legend>Machine</legend><div class="segments" id="machine-tiers"></div></fieldset>
        <div class="grid" style="margin-top:14px"><div class="field"><label for="disk">Workspace disk (GB)</label><input id="disk" type="number" min="1" max="100" step="1" value="1"></div></div>
      </section>
      <section id="credential-section">
        <fieldset><legend>Local provider logins</legend><div class="credentials">
          <label class="choice"><input type="radio" name="credential" value="global" checked><span>Available to all my chat.dev agents</span></label>
          <label class="choice"><input type="radio" name="credential" value="agent"><span>This agent only</span></label>
          <label class="choice"><input type="radio" name="credential" value="none"><span>Use the provider connection already on chat.dev</span></label>
        </div><div class="hint" id="credential-sources"></div></fieldset>
      </section>
      <details>
        <summary>More settings</summary>
        <div class="grid">
          <div class="field"><label for="budget">Budget limit (USD)</label><input id="budget" type="number" min="0" max="1000" step="1" value="10"></div>
          <div class="field wide"><label for="system-prompt">Starting instructions</label><textarea id="system-prompt" maxlength="10000" placeholder="Use the chat.dev account default"></textarea></div>
        </div>
      </details>
      <footer><div id="status" role="status" aria-live="polite"></div><div class="actions"><button class="secondary" id="start-new" type="button"${options.initialSettings ? "" : " hidden"}>Start New Agent and Move Connection</button><button class="secondary" id="cancel" type="button">Cancel</button><button id="submit" type="submit">${options.initialSettings ? "Finish Connecting Existing Agent" : "Create New Agent"}</button></div></footer>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const options = ${state};
    const form = document.getElementById('form');
    const conversation = document.getElementById('conversation');
    const name = document.getElementById('name');
    const model = document.getElementById('model');
    const disk = document.getElementById('disk');
    const budget = document.getElementById('budget');
    const systemPrompt = document.getElementById('system-prompt');
    const submit = document.getElementById('submit');
    const startNew = document.getElementById('start-new');
    const cancel = document.getElementById('cancel');
    const status = document.getElementById('status');
    const credentialSection = document.getElementById('credential-section');
    const defaults = Object.fromEntries(options.machineTiers.map((tier) => [tier.id, tier.volumeGb]));
    document.getElementById('project-name').textContent = options.projectName;
    const initial = options.initialSettings || {};
    name.value = initial.name || options.projectName.toLowerCase().replace(/[^a-z0-9_.\/-]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'remote-workspace';
    for (const item of options.conversations) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      conversation.appendChild(option);
    }
    const machineTiers = document.getElementById('machine-tiers');
    for (const [index, tier] of options.machineTiers.entries()) {
      const wrapper = document.createElement('div');
      wrapper.className = 'segment';
      const input = document.createElement('input');
      input.id = 'machine-' + tier.id;
      input.type = 'radio';
      input.name = 'machine';
      input.value = tier.id;
      input.checked = initial.machineSize ? tier.id === initial.machineSize : index === 0;
      const label = document.createElement('label');
      label.htmlFor = input.id;
      const title = document.createElement('strong');
      title.textContent = tier.label;
      const memory = tier.memoryMb >= 1024 ? (tier.memoryMb / 1024) + ' GB' : tier.memoryMb + ' MB';
      const specs = document.createElement('small');
      specs.textContent = tier.cpus + (tier.cpuKind === 'performance' ? ' dedicated' : ' shared') + ' vCPU · ' + memory;
      const price = document.createElement('small');
      price.textContent = tier.volumeGb + ' GB disk · $' + tier.monthlyUsd.toLocaleString() + '/mo';
      label.append(title, specs, price);
      wrapper.append(input, label);
      machineTiers.appendChild(wrapper);
    }
    const allCredentialSources = [...new Set(options.conversations.flatMap((item) => item.credentialSources))];
    function selectedConversation() { return options.conversations.find((item) => item.id === conversation.value); }
    function updateConversation() {
      const item = selectedConversation();
      if (!item) return;
      const provider = item.provider === 'claude' ? 'Claude Code' : item.provider === 'cursor' ? 'Cursor Agent' : 'Codex';
      document.getElementById('conversation-meta').textContent = provider + ' · ' + item.remoteLabel + ' · ' + new Date(item.mtime).toLocaleString();
      model.value = item.model || '';
      credentialSection.hidden = allCredentialSources.length === 0;
      document.getElementById('credential-sources').textContent = allCredentialSources.join(' · ');
      const global = document.querySelector('input[name="credential"][value="global"]');
      const none = document.querySelector('input[name="credential"][value="none"]');
      if (allCredentialSources.length) global.checked = true;
      else none.checked = true;
    }
    conversation.addEventListener('change', updateConversation);
    document.querySelectorAll('input[name="machine"]').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) {
        disk.min = String(defaults[input.value]);
        disk.value = String(defaults[input.value]);
      }
    }));
    if (initial.mainSessionId && options.conversations.some((item) => item.id === initial.mainSessionId)) conversation.value = initial.mainSessionId;
    updateConversation();
    const selectedMachine = document.querySelector('input[name="machine"]:checked');
    disk.min = String(defaults[selectedMachine.value] || 1);
    disk.value = String(initial.volumeGb || defaults[selectedMachine.value] || 1);
    if (initial.model !== undefined) model.value = initial.model || '';
    if (initial.credentialScope) {
      const savedCredential = document.querySelector('input[name="credential"][value="' + initial.credentialScope + '"]');
      if (savedCredential) savedCredential.checked = true;
    }
    if (initial.maxBudgetUsd !== undefined) budget.value = String(initial.maxBudgetUsd);
    if (initial.systemPrompt !== undefined) systemPrompt.value = initial.systemPrompt || '';
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    function currentSettings() {
      if (!form.reportValidity()) return;
      const item = selectedConversation();
      const machine = document.querySelector('input[name="machine"]:checked');
      const credential = document.querySelector('input[name="credential"]:checked');
      vscode.setState({ mainSessionId: conversation.value, name: name.value, model: model.value, disk: disk.value, budget: budget.value });
      return {
        mainSessionId: item.id,
        name: name.value.trim(),
        machineSize: machine.value,
        volumeGb: Number(disk.value),
        credentialScope: allCredentialSources.length ? credential.value : 'none',
        model: model.value.trim() || undefined,
        maxBudgetUsd: budget.value === '' ? undefined : Number(budget.value),
        systemPrompt: systemPrompt.value.trim() || undefined,
      };
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const settings = currentSettings();
      if (settings) vscode.postMessage({ type: 'submit', intent: 'continue', settings });
    });
    startNew.addEventListener('click', () => {
      const settings = currentSettings();
      if (settings) vscode.postMessage({ type: 'submit', intent: 'replace', settings });
    });
    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'busy' || message.type === 'progress') {
        submit.disabled = true; startNew.disabled = true; cancel.disabled = true; status.className = ''; status.textContent = message.message || 'Working';
      } else if (message.type === 'complete') {
        status.className = ''; status.textContent = message.message || 'Ready';
      } else if (message.type === 'error') {
        submit.disabled = false; startNew.disabled = false; startNew.hidden = false; cancel.disabled = false; submit.textContent = 'Try Again'; status.className = 'error'; status.textContent = message.message || 'Could not continue this project';
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
