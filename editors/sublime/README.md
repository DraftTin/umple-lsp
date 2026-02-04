# Umple LSP for Sublime Text

This guide explains how to set up the Umple Language Server with Sublime Text.

## Prerequisites

- Sublime Text 4 (or 3 with LSP package)
- [LSP package](https://packagecontrol.io/packages/LSP) installed
- Node.js 18+
- Java 11+ (for umplesync.jar)

## Installation

### 1. Build the LSP server

From the umple-lsp directory:

```bash
npm install
npm run compile
npm run download-jar
```

### 2. Install LSP package

Open Sublime Text and install the LSP package via Package Control:
1. `Cmd+Shift+P` (or `Ctrl+Shift+P` on Linux/Windows)
2. Type "Package Control: Install Package"
3. Search for "LSP" and install it

### 3. Add Umple syntax definition

Copy the syntax file to your Sublime `Packages/User` directory:

```bash
cp editors/sublime/Umple.sublime-syntax \
  ~/Library/Application\ Support/Sublime\ Text/Packages/User/
```

Or create `Packages/User/Umple.sublime-syntax` manually with:

```yaml
%YAML 1.2
---
name: Umple
file_extensions: [ump]
scope: source.umple

contexts:
  main:
    - match: '\b(class|interface|trait|enum|association|namespace|use)\b'
      scope: keyword.control.umple
    - match: '\b(isA|singleton|immutable|abstract|lazy|const)\b'
      scope: keyword.other.umple
    - match: '\b(Integer|String|Boolean|Double|Float|Date|Time)\b'
      scope: storage.type.umple
    - match: '//.*$'
      scope: comment.line.umple
    - match: '/\*'
      push: block_comment
    - match: '"[^"]*"'
      scope: string.quoted.double.umple

  block_comment:
    - meta_scope: comment.block.umple
    - match: '\*/'
      pop: true
```

### 4. Configure LSP

Open LSP settings: `Preferences` > `Package Settings` > `LSP` > `Settings`

Add the Umple client configuration:

```json
{
  "clients": {
    "umple": {
      "enabled": true,
      "command": ["node", "/path/to/umple-lsp/server/out/server.js", "--stdio"],
      "selector": "source.umple",
      "initializationOptions": {
        "umpleSyncJarPath": "/path/to/umple-lsp/umplesync.jar",
        "umpleSyncPort": 5558
      }
    }
  }
}
```

**Important:** Update `/path/to/umple-lsp` to your actual installation path.

### 5. Restart Sublime Text

Close and reopen Sublime Text for all changes to take effect.

## Vim keybindings (Vintage mode)

If you use Vintage mode, add this to your keybindings (`Preferences` > `Key Bindings`) for `gd` go-to-definition:

```json
[
  {
    "keys": ["g", "d"],
    "command": "lsp_symbol_definition",
    "context": [
      { "key": "setting.command_mode", "operand": true }
    ]
  }
]
```

## Features

- **Syntax highlighting**: Basic regex-based highlighting for keywords, types, comments, and strings
- **Diagnostics**: Real-time error and warning detection
- **Go-to-definition**: Jump to class, attribute, state definitions
- **Code completion**: Context-aware keyword and symbol completion

## Troubleshooting

### LSP not starting

1. Verify Java is installed: `java -version`
2. Test the server manually:
   ```bash
   node "/path/to/umple-lsp/server/out/server.js" --stdio
   ```
3. Open the Sublime console (`View` > `Show Console`) for errors
4. Check the LSP log panel: `Cmd+Shift+P` > "LSP: Toggle Log Panel"

### No syntax highlighting

1. Ensure the `.sublime-syntax` file is in the `Packages/User` directory
2. Check the status bar shows "Umple" when a `.ump` file is open
3. Restart Sublime Text

### Go-to-definition not working

1. Check if the LSP is running (status bar should show "umple" as a running server)
2. Make sure the file is recognized as Umple (check status bar)
3. Open the LSP log panel to see if the server is responding

## Updating

After pulling updates:

```bash
cd /path/to/umple-lsp
npm run compile
```

Then restart Sublime Text.
