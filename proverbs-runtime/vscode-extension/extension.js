"use strict";

const vscode = require("vscode");
const http = require("http");

const PROVERBS_URL = "http://localhost:11435";
const DEFAULT_MODEL = "proverbs";

/**
 * POST to /api/chat (Ollama-compatible, stream:false) and return the reply text.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 */
function callProverbs(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: DEFAULT_MODEL, messages, stream: false });
    const url = new URL("/api/chat", PROVERBS_URL);
    const options = {
      hostname: url.hostname,
      port: parseInt(url.port, 10) || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.message?.content;
          if (typeof content === "string") {
            resolve(content);
          } else {
            reject(new Error("Unexpected response: " + data));
          }
        } catch (e) {
          reject(new Error("JSON parse error: " + e.message));
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.write(body);
    req.end();
  });
}

/**
 * Open the given text in a new editor tab with the specified language.
 * @param {string} text
 * @param {string} language
 */
async function showInNewEditor(text, language) {
  const doc = await vscode.workspace.openTextDocument({ content: text, language });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Strip leading/trailing markdown code fences from a string.
 * Handles ``` and ```<lang> style fences.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
  return text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // ── proverbs.ask ──────────────────────────────────────────────────────────
  const askCmd = vscode.commands.registerCommand("proverbs.ask", async () => {
    const question = await vscode.window.showInputBox({ prompt: "Ask Proverbs" });
    if (!question) return;

    let reply;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Proverbs is thinking..." },
      async () => {
        reply = await callProverbs([{ role: "user", content: question }]);
      }
    );

    await showInNewEditor(reply, "markdown");
  });

  // ── proverbs.fix ──────────────────────────────────────────────────────────
  const fixCmd = vscode.commands.registerCommand("proverbs.fix", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Proverbs: no active editor.");
      return;
    }

    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    const range = hasSelection ? selection : new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length)
    );
    const code = editor.document.getText(range);
    const language = editor.document.languageId;

    let reply;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Proverbs is thinking..." },
      async () => {
        reply = await callProverbs([
          { role: "user", content: `Fix this ${language} code:\n\n${code}` },
        ]);
      }
    );

    const fixed = stripCodeFences(reply);
    await editor.edit((editBuilder) => {
      editBuilder.replace(range, fixed);
    });
  });

  // ── proverbs.explain ──────────────────────────────────────────────────────
  const explainCmd = vscode.commands.registerCommand("proverbs.explain", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Proverbs: no active editor.");
      return;
    }

    const selection = editor.selection;
    const code = editor.document.getText(
      selection.isEmpty ? undefined : selection
    );
    if (!code.trim()) {
      vscode.window.showWarningMessage("Proverbs: select some code to explain.");
      return;
    }

    let reply;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Proverbs is thinking..." },
      async () => {
        reply = await callProverbs([
          { role: "user", content: `Explain this code:\n\n${code}` },
        ]);
      }
    );

    await showInNewEditor(reply, "markdown");
  });

  context.subscriptions.push(askCmd, fixCmd, explainCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };
