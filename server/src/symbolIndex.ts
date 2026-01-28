/**
 * Symbol Index for fast go-to-definition lookups.
 *
 * Uses tree-sitter (via WASM) for incremental parsing and maintains an
 * in-memory index of all symbol definitions in the workspace.
 */

import * as fs from "fs";
import * as path from "path";

// web-tree-sitter types and module
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("web-tree-sitter");
type Language = InstanceType<typeof TreeSitter.Language>;
type Tree = InstanceType<typeof TreeSitter.Tree>;
type SyntaxNode = InstanceType<typeof TreeSitter.Node>;

export type SymbolKind =
  | "class"
  | "interface"
  | "trait"
  | "enum"
  | "attribute"
  | "state"
  | "statemachine"
  | "method"
  | "association";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number; // 0-indexed
  column: number; // 0-indexed
  endLine: number;
  endColumn: number;
  parent?: string; // For nested symbols (attributes in class, states in statemachine)
}

export interface FileIndex {
  symbols: SymbolEntry[];
  tree: Tree | null;
  contentHash: string;
}

export class SymbolIndex {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parser: any = null;
  private language: Language | null = null;
  private files: Map<string, FileIndex> = new Map();
  private symbolsByName: Map<string, SymbolEntry[]> = new Map();
  private initialized = false;

  /**
   * Initialize the tree-sitter parser with the Umple grammar.
   * @param wasmPath Path to the tree-sitter-umple.wasm file
   */
  async initialize(wasmPath: string): Promise<boolean> {
    try {
      // Initialize the WASM module first
      await TreeSitter.Parser.init();

      // Create parser instance
      this.parser = new TreeSitter.Parser();

      // Load the WASM language
      this.language = await TreeSitter.Language.load(wasmPath);
      this.parser.setLanguage(this.language);

      this.initialized = true;
      console.log("Symbol index initialized with tree-sitter");
      return true;
    } catch (err) {
      console.error("Failed to initialize tree-sitter parser:", err);
      this.parser = null;
      this.language = null;
      return false;
    }
  }

  /**
   * Check if the symbol index is ready to use.
   */
  isReady(): boolean {
    return this.initialized && this.parser !== null;
  }

  /**
   * Index a file or update its index if content changed.
   * @param filePath Absolute path to the file
   * @param content File content (optional, will be read from disk if not provided)
   * @returns true if the file was (re)indexed, false if cache hit
   */
  indexFile(filePath: string, content?: string): boolean {
    if (!this.parser) return false;

    const fileContent = content ?? this.readFileSafe(filePath);
    if (fileContent === null) return false;

    const hash = this.hashContent(fileContent);

    const existing = this.files.get(filePath);
    if (existing && existing.contentHash === hash) {
      // Content unchanged, skip re-indexing
      return false;
    }

    // Remove old symbols for this file from the name index
    if (existing) {
      this.removeFileSymbols(filePath);
    }

    // Parse the file
    const tree = this.parser.parse(fileContent);

    // Extract symbols from the AST
    const symbols = this.extractSymbols(filePath, tree.rootNode);

    // Store the file index
    this.files.set(filePath, {
      symbols,
      tree,
      contentHash: hash,
    });

    // Add symbols to the name index
    for (const symbol of symbols) {
      const existing = this.symbolsByName.get(symbol.name) ?? [];
      existing.push(symbol);
      this.symbolsByName.set(symbol.name, existing);
    }

    return true;
  }

  /**
   * Update a file with new content.
   * For web-tree-sitter, we do a full reparse but the index diffing is still efficient.
   */
  updateFile(filePath: string, content: string): boolean {
    return this.indexFile(filePath, content);
  }

  /**
   * Find definition of a symbol by name.
   * @param name Symbol name to look up
   * @param kind Optional kind filter
   * @returns Array of matching symbol entries
   */
  findDefinition(name: string, kind?: SymbolKind): SymbolEntry[] {
    const symbols = this.symbolsByName.get(name) ?? [];
    if (kind) {
      return symbols.filter((s) => s.kind === kind);
    }
    return symbols;
  }

  /**
   * Find definition with context (for resolving attributes/states within a class/statemachine).
   * @param name Symbol name
   * @param parentName Parent symbol name (class or statemachine name)
   */
  findDefinitionInContext(name: string, parentName: string): SymbolEntry[] {
    const symbols = this.symbolsByName.get(name) ?? [];
    return symbols.filter((s) => s.parent === parentName);
  }

  /**
   * Get all symbols in a file.
   */
  getFileSymbols(filePath: string): SymbolEntry[] {
    return this.files.get(filePath)?.symbols ?? [];
  }

  /**
   * Get all indexed files.
   */
  getIndexedFiles(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * Get all symbol names.
   */
  getAllSymbolNames(): string[] {
    return Array.from(this.symbolsByName.keys());
  }

  /**
   * Remove a file from the index.
   */
  removeFile(filePath: string): void {
    this.removeFileSymbols(filePath);
    this.files.delete(filePath);
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.files.clear();
    this.symbolsByName.clear();
  }

  /**
   * Index all .ump files in a directory.
   */
  indexDirectory(dirPath: string): number {
    let count = 0;
    const files = this.findUmpFiles(dirPath);
    for (const file of files) {
      try {
        if (this.indexFile(file)) {
          count++;
        }
      } catch (err) {
        console.error(`Failed to index ${file}:`, err);
      }
    }
    return count;
  }

  /**
   * Get index statistics.
   */
  getStats(): { files: number; symbols: number; uniqueNames: number } {
    let totalSymbols = 0;
    for (const fileIndex of this.files.values()) {
      totalSymbols += fileIndex.symbols.length;
    }
    return {
      files: this.files.size,
      symbols: totalSymbols,
      uniqueNames: this.symbolsByName.size,
    };
  }

  /**
   * Check if a position is inside a comment.
   * @param filePath Path to the file
   * @param content File content (if available, otherwise reads from disk)
   * @param line 0-indexed line number
   * @param column 0-indexed column number
   */
  isPositionInComment(
    filePath: string,
    content: string | null,
    line: number,
    column: number,
  ): boolean {
    if (!this.initialized || !this.parser) {
      return false;
    }

    // Get or create tree
    let tree: Tree | null = null;
    const fileIndex = this.files.get(filePath);
    if (fileIndex?.tree) {
      tree = fileIndex.tree;
    } else if (content) {
      tree = this.parser.parse(content);
    } else {
      const fileContent = this.readFileSafe(filePath);
      if (fileContent) {
        tree = this.parser.parse(fileContent);
      }
    }

    if (!tree) {
      return false;
    }

    // Get the node at the position
    const node = tree.rootNode.descendantForPosition({ row: line, column });
    if (!node) {
      return false;
    }

    // Check if the node or any ancestor is a comment
    let current = node;
    while (current) {
      if (current.type === "line_comment" || current.type === "block_comment") {
        return true;
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Extract use statement paths from a file using tree-sitter.
   * @param filePath Path to the file
   * @param content File content (optional, will be read from disk if not provided)
   * @returns Array of use paths (without quotes)
   */
  extractUseStatements(filePath: string, content?: string): string[] {
    if (!this.initialized || !this.parser) {
      return [];
    }

    const fileContent = content ?? this.readFileSafe(filePath);
    if (!fileContent) {
      return [];
    }

    // Use cached tree if available and content matches
    const fileIndex = this.files.get(filePath);
    let tree: Tree;
    if (fileIndex?.tree && !content) {
      tree = fileIndex.tree;
    } else {
      tree = this.parser.parse(fileContent);
    }

    const usePaths: string[] = [];
    const visit = (node: SyntaxNode) => {
      if (node.type === "use_statement") {
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
          let pathText = pathNode.text;
          // Remove quotes if present
          if (
            (pathText.startsWith('"') && pathText.endsWith('"')) ||
            (pathText.startsWith("'") && pathText.endsWith("'"))
          ) {
            pathText = pathText.slice(1, -1);
          }
          usePaths.push(pathText);
        }
      } else {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child);
        }
      }
    };

    visit(tree.rootNode);
    return usePaths;
  }

  /**
   * Get the use path at a specific position, if the cursor is on a use statement.
   * @param filePath Path to the file
   * @param content File content
   * @param line 0-indexed line number
   * @param column 0-indexed column number
   * @returns The use path (without quotes) or null if not on a use statement
   */
  getUsePathAtPosition(
    filePath: string,
    content: string,
    line: number,
    column: number,
  ): string | null {
    if (!this.initialized || !this.parser) {
      return null;
    }

    // Use cached tree if available
    const fileIndex = this.files.get(filePath);
    let tree: Tree;
    if (
      fileIndex?.tree &&
      fileIndex.contentHash === this.hashContent(content)
    ) {
      tree = fileIndex.tree;
    } else {
      tree = this.parser.parse(content);
    }

    // Get the node at the position
    const node = tree.rootNode.descendantForPosition({ row: line, column });
    if (!node) {
      return null;
    }

    // Walk up to find if we're inside a use_statement
    let current = node;
    while (current) {
      if (current.type === "use_statement") {
        const pathNode = current.childForFieldName("path");
        if (pathNode) {
          let pathText = pathNode.text;
          // Remove quotes if present
          if (
            (pathText.startsWith('"') && pathText.endsWith('"')) ||
            (pathText.startsWith("'") && pathText.endsWith("'"))
          ) {
            pathText = pathText.slice(1, -1);
          }
          return pathText;
        }
        return null;
      }
      current = current.parent;
    }

    return null;
  }

  // =====================
  // Private methods
  // =====================

  private readFileSafe(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private removeFileSymbols(filePath: string): void {
    const fileIndex = this.files.get(filePath);
    if (!fileIndex) return;

    for (const symbol of fileIndex.symbols) {
      const symbols = this.symbolsByName.get(symbol.name);
      if (symbols) {
        const filtered = symbols.filter((s) => s.file !== filePath);
        if (filtered.length === 0) {
          this.symbolsByName.delete(symbol.name);
        } else {
          this.symbolsByName.set(symbol.name, filtered);
        }
      }
    }
  }

  private hashContent(content: string): string {
    // Simple hash for change detection
    // For production, consider using crypto.createHash('sha256')
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  private findUmpFiles(dirPath: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          results.push(...this.findUmpFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ump")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore errors (permission denied, etc.)
    }
    return results;
  }

  private extractSymbols(
    filePath: string,
    rootNode: SyntaxNode,
  ): SymbolEntry[] {
    const symbols: SymbolEntry[] = [];

    const visit = (node: SyntaxNode, parent?: string) => {
      switch (node.type) {
        case "class_definition":
        case "interface_definition":
        case "trait_definition":
        case "enum_definition":
        case "external_definition": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let kind: SymbolKind = node.type.replace(
              "_definition",
              "",
            ) as SymbolKind;
            if (node.type === "external_definition") {
              kind = "class";
            }
            symbols.push({
              name: nameNode.text,
              kind,
              file: filePath,
              line: nameNode.startPosition.row,
              column: nameNode.startPosition.column,
              endLine: nameNode.endPosition.row,
              endColumn: nameNode.endPosition.column,
            });

            // Visit children with this class as parent
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child) visit(child, nameNode.text);
            }
          }
          break;
        }

        case "attribute_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode && parent) {
            symbols.push({
              name: nameNode.text,
              kind: "attribute",
              file: filePath,
              line: nameNode.startPosition.row,
              column: nameNode.startPosition.column,
              endLine: nameNode.endPosition.row,
              endColumn: nameNode.endPosition.column,
              parent,
            });
          }
          break;
        }

        case "state_machine": {
          const nameNode = node.childForFieldName("name");
          if (nameNode && parent) {
            symbols.push({
              name: nameNode.text,
              kind: "statemachine",
              file: filePath,
              line: nameNode.startPosition.row,
              column: nameNode.startPosition.column,
              endLine: nameNode.endPosition.row,
              endColumn: nameNode.endPosition.column,
              parent,
            });

            // Visit states with this statemachine as parent
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child && child.type === "state") {
                visit(child, nameNode.text);
              }
            }
          }
          break;
        }

        case "state": {
          const nameNode = node.childForFieldName("name");
          if (nameNode && parent) {
            symbols.push({
              name: nameNode.text,
              kind: "state",
              file: filePath,
              line: nameNode.startPosition.row,
              column: nameNode.startPosition.column,
              endLine: nameNode.endPosition.row,
              endColumn: nameNode.endPosition.column,
              parent,
            });

            // Visit nested states
            for (let i = 0; i < node.childCount; i++) {
              const child = node.child(i);
              if (child && child.type === "state") {
                visit(child, nameNode.text);
              }
            }
          }
          break;
        }

        case "method_declaration":
        case "method_signature": {
          const nameNode = node.childForFieldName("name");
          if (nameNode && parent) {
            symbols.push({
              name: nameNode.text,
              kind: "method",
              file: filePath,
              line: nameNode.startPosition.row,
              column: nameNode.startPosition.column,
              endLine: nameNode.endPosition.row,
              endColumn: nameNode.endPosition.column,
              parent,
            });
          }
          break;
        }

        case "association_definition": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "association",
              file: filePath,
              line: nameNode.startPosition.row,
              column: nameNode.startPosition.column,
              endLine: nameNode.endPosition.row,
              endColumn: nameNode.endPosition.column,
            });
          }
          break;
        }

        default:
          // Visit all children for other node types
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) visit(child, parent);
          }
      }
    };

    visit(rootNode);
    return symbols;
  }
}

// Singleton instance
export const symbolIndex = new SymbolIndex();
