# Editor Integrations

This directory contains setup guides and configuration files for using the Umple Language Server with various editors.

## Supported Editors

| Editor | Status | Diagnostics | Go-to-def | Completion | Syntax Highlighting |
|--------|--------|-------------|-----------|------------|---------------------|
| [VS Code](../README.md) | Full support | ✅ | ✅ | ✅ | ✅ (TextMate + tree-sitter) |
| [Neovim](neovim/) | Full support | ✅ | ✅ | ✅ | ✅ (tree-sitter) |
| [Sublime Text](sublime/) | LSP only | ✅ | ✅ | ✅ | ⚠️ (basic regex) |

## Prerequisites (All Editors)

Before setting up any editor, ensure you have:

1. **Node.js 18+**: Required to run the LSP server
2. **Java 11+**: Required for umplesync.jar (Umple compiler)

## Quick Start

```bash
# 1. Build the LSP server (from umple-lsp directory)
npm install
npm run compile
npm run download-jar

# 2. Follow the setup guide for your editor
```

## Architecture

All editors connect to the same LSP server (`server/out/server.js`). The server:

- Runs as a Node.js process
- Communicates via stdio
- Uses umplesync.jar for diagnostics
- Uses tree-sitter for symbol indexing (lazy - indexes on file open)
- Only indexes files reachable via `use` statements for fast startup

```
Your Editor
    │
    └─ (stdio) ─→ server.js ─→ umplesync.jar (diagnostics)
                     │
                     └─ tree-sitter (go-to-definition, lazy indexing)
```

## Adding Support for a New Editor

To add support for a new editor:

1. Create a new folder: `editors/<editor-name>/`
2. Add a `README.md` with setup instructions
3. Include any editor-specific configuration files
4. Test all features: diagnostics, go-to-definition, completion

The LSP server is editor-agnostic and follows the LSP specification, so any editor with LSP support should work.

## Initialization Options

When configuring the LSP client, you can pass these initialization options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `umpleSyncJarPath` | string | required | Path to umplesync.jar |
| `umpleSyncPort` | number | 5556 | Port for umplesync socket server |
| `umpleSyncHost` | string | "localhost" | Host for umplesync connection |
| `umpleSyncTimeoutMs` | number | 30000 | Timeout for umplesync requests |

**Note:** Use different ports for each editor if running multiple instances simultaneously.
