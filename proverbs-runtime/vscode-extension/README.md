# Proverbs AI — VS Code Extension

VS Code extension for the Proverbs local LLM coding assistant.

## Requirements

The Proverbs server must be running before using the extension:

```
proverbs start
```

Or manually:

```
python -m inference.server
```

The server listens on `http://localhost:11434` by default.

## Installation

**Option A — copy the folder directly (no build step):**

```
cp -r vscode-extension ~/.vscode/extensions/proverbs-ai-1.0.0
```

Restart VS Code. The extension activates automatically on startup.

**Option B — install a packaged `.vsix`:**

```
code --install-extension proverbs-ai-1.0.0.vsix
```

To build the `.vsix` yourself, install `vsce` and run:

```
npm install -g @vscode/vsce
cd vscode-extension
vsce package
```

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Ask Proverbs | `Ctrl+Shift+P` / `Cmd+Shift+P` | Open a prompt, get a response in a new Markdown tab |
| Fix with Proverbs | `Ctrl+Shift+F` / `Cmd+Shift+F` | Fix selected code (or full file) in-place |
| Explain with Proverbs | _(command palette)_ | Explain selected code in a new Markdown tab |

All commands are also available in the VS Code Command Palette (`Ctrl+Shift+P`): search for **Proverbs**.
