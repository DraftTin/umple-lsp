# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Umple Language Reference

Before working on this project, familiarize yourself with Umple syntax:
- **User Manual**: https://cruise.umple.org/umple/GettingStarted.html
- **Try Online**: https://try.umple.org

Key syntax patterns:
```umple
class Person {
  name;                      // Attribute (String by default)
  Integer age;               // Typed attribute
  1 -- * Address addresses;  // Inline association with role name
}

class Student {
  isA Person;                // Inheritance
}

association {                // Standalone association block
  0..1 Mentor -- * Student;
}

class GarageDoor {
  status {                   // State machine
    Open { buttonOrObstacle -> Closing; }
    Closing { buttonOrObstacle -> Opening; reachBottom -> Closed; }
    Closed { buttonOrObstacle -> Opening; }
    Opening { buttonOrObstacle -> Closing; reachTop -> Open; }
  }
}

use "OtherFile.ump";         // Include another Umple file
```

## Project Overview

This is a VS Code Language Server Protocol (LSP) extension for the Umple modeling language. It provides IDE features including diagnostics, code completion, and go-to-definition for `.ump` files. Also includes a tree-sitter grammar for syntax highlighting in editors like Neovim.

## Build Commands

```bash
# Compile both client and server
npm run compile

# Watch mode for development
npm run watch

# Install all dependencies (runs automatically via postinstall)
npm run postinstall
```

### Tree-sitter Grammar

```bash
cd tree-sitter-umple

# Regenerate parser after grammar.js changes
npx tree-sitter generate

# Build WebAssembly version (used by LSP server)
npx tree-sitter build --wasm

# Test parsing
npx tree-sitter parse ../test/Student.ump
```

## Testing

No automated test framework is configured. Testing is done manually via VS Code's Extension Development Host:
- Press F5 in VS Code to launch a new window with the extension loaded
- Open `.ump` files in the test window to verify functionality

Sample test files are in the `/test/` directory.

## Architecture

```
Client (client/src/extension.ts)
    │
    └─ Launches → Server (server/src/server.ts)
                      │
                      ├─ Diagnostics   → UmpleSync.jar (socket server, port 5556)
                      ├─ Completion    → Keywords (keywords.ts) + context detection
                      └─ Go-To-Def     → SymbolIndex (tree-sitter based)

Tree-sitter Grammar (tree-sitter-umple/)
    │
    ├─ grammar.js           → Grammar definition (manually written)
    ├─ queries/highlights.scm → Syntax highlighting (manually written)
    ├─ src/parser.c         → Generated parser
    └─ tree-sitter-umple.wasm → WebAssembly parser for LSP
```

### Key Components

**Client (`client/src/extension.ts`)**: VS Code extension entry point. Launches the language server and passes initialization options (JAR paths, port configuration).

**Server (`server/src/server.ts`)**: Core LSP implementation handling:
- Document synchronization (open/change/close events)
- Diagnostics via UmpleSync.jar socket connection with debounced validation
- Context-aware code completion (detects if cursor is in class/statemachine/association/enum)
- Go-to-definition using tree-sitter symbol index with transitive `use` statement resolution

**Symbol Index (`server/src/symbolIndex.ts`)**: Tree-sitter based symbol indexing:
- Parses `.ump` files incrementally using web-tree-sitter (WASM)
- Maintains in-memory index of all symbol definitions (classes, interfaces, traits, enums, attributes, methods, state machines, states, associations)
- Content hash caching for efficient re-indexing
- Comment detection to prevent go-to-definition inside comments

**Keywords (`server/src/keywords.ts`)**: Keyword database organized by context (topLevel, classLevel, statemachine, etc.) for context-aware completion.

**Tree-sitter Grammar (`tree-sitter-umple/`)**: Custom tree-sitter grammar for Umple:
- `grammar.js` - Grammar rules (manually written)
- `queries/highlights.scm` - Syntax highlighting queries (manually written)
- `queries/locals.scm` - Scope tracking (manually written)
- `src/` - Generated parser files (auto-generated)
- `tree-sitter-umple.wasm` - WebAssembly parser (auto-generated)

### External Dependencies

- `umplesync.jar`: Compiler wrapper running as socket server for diagnostics
- `umple.jar`: Core Umple compiler for code generation

### Go-To-Definition

The go-to-definition feature uses tree-sitter for fast, accurate symbol lookup:

1. **Symbol Indexing**: On workspace open, all `.ump` files are parsed and symbols extracted
2. **Transitive Use Resolution**: When validating, `use` statements are resolved transitively to find all dependent files
3. **Scoped Lookup**: Go-to-definition only returns symbols from files reachable via `use` statements from the current file
4. **Comment Detection**: Go-to-definition is disabled when cursor is inside a comment

### Diagnostics with Stub Insertion

For accurate diagnostics, the server replaces `use` statements with stub declarations:

1. Extracts `use` statements from the current file
2. Recursively resolves transitive dependencies
3. Collects class/interface/trait/enum symbols from all reachable files
4. Replaces `use` statements with stub declarations (e.g., `external Foo {}`)
5. Tracks line offset to adjust diagnostic line numbers back to original positions

## Configuration

Server initialization options (passed from client):
- `umpleSyncJarPath`, `umpleJarPath`: JAR locations
- `umpleSyncPort` (default 5556), `umpleSyncHost`, `umpleSyncTimeoutMs`: Socket configuration

Environment variable overrides: `UMPLESYNC_HOST`, `UMPLESYNC_PORT`, `UMPLESYNC_TIMEOUT_MS`

## Neovim Integration

To use the tree-sitter grammar with Neovim:

1. Register the parser in your Neovim config:
```lua
local parser_config = require("nvim-treesitter.parsers").get_parser_configs()
parser_config.umple = {
  install_info = {
    url = "/path/to/umple-lsp/tree-sitter-umple",
    files = { "src/parser.c" },
  },
  filetype = "umple",
}
```

2. Symlink queries to Neovim runtime:
```bash
ln -s /path/to/umple-lsp/tree-sitter-umple/queries ~/.local/share/nvim/queries/umple
```

3. Set filetype for `.ump` files:
```lua
vim.filetype.add({ extension = { ump = "umple" } })
```
