# Umple LSP for Neovim

This guide explains how to set up the Umple Language Server with Neovim.

## Prerequisites

- Neovim 0.8+ (with built-in LSP support)
- Node.js 18+
- Java 11+ (for umplesync.jar)
- [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig) (recommended)
- [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter) (for syntax highlighting)

## Installation

### 1. Build the LSP server

From the umple-lsp directory:

```bash
npm install
npm run compile
npm run download-jar
```

### 2. Add LSP configuration to Neovim

Add the following to your `init.lua` (or create a separate file in `~/.config/nvim/lua/`):

```lua
-- Option A: Copy the contents of umple.lua to your config
-- Option B: Source this file directly:
-- dofile('/path/to/umple-lsp/editors/neovim/umple.lua')
```

See `umple.lua` for the complete configuration.

### 3. Install the tree-sitter parser (for syntax highlighting)

```lua
-- Add to your nvim-treesitter config
local parser_config = require("nvim-treesitter.parsers").get_parser_configs()
parser_config.umple = {
  install_info = {
    url = "/path/to/umple-lsp/tree-sitter-umple",
    files = { "src/parser.c" },
  },
  filetype = "umple",
}
```

Then run `:TSInstall umple` in Neovim.

### 4. Symlink highlight queries

```bash
mkdir -p ~/.local/share/nvim/queries
ln -s /path/to/umple-lsp/tree-sitter-umple/queries ~/.local/share/nvim/queries/umple
```

## Features

- **Diagnostics**: Real-time error and warning detection
- **Go-to-definition**: Jump to class, attribute, state definitions
- **Code completion**: Context-aware keyword and symbol completion
- **Syntax highlighting**: Via tree-sitter grammar

## Troubleshooting

### LSP not starting

1. Check if Java is installed: `java -version`
2. Check if the server runs manually:
   ```bash
   node /path/to/umple-lsp/server/out/server.js --stdio
   ```
3. Check Neovim LSP logs: `:LspLog`

### No syntax highlighting

1. Ensure tree-sitter parser is installed: `:TSInstallInfo`
2. Check if queries are symlinked correctly
3. Verify filetype is set: `:set filetype?` (should show `umple`)

## Updating

```bash
cd /path/to/umple-lsp
git pull
npm install
npm run compile
npm run download-jar
```

In Neovim, reinstall the tree-sitter parser if grammar changed:
```vim
:TSInstall umple
```
