import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  InitializeParams,
  InitializeResult,
  Location,
  ProposedFeatures,
  TextDocumentSyncKind,
  Position,
  Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ALL_KEYWORDS, KEYWORDS } from "./keywords";
import { symbolIndex, UseStatementWithPosition } from "./symbolIndex";

const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();
const pendingIndexUpdates = new Map<string, NodeJS.Timeout>();
const modelCache = new Map<
  string,
  { version: number; items: CompletionItem[] }
>();
let workspaceRoots: string[] = [];

/**
 * Normalize a file URI to a consistent key for the documents map.
 * Converts URI to file path and back to ensure consistent encoding.
 */
function normalizeUri(uri: string): string {
  if (!uri.startsWith("file:")) {
    return uri;
  }
  try {
    // Convert to path and back to normalize encoding
    const filePath = fileURLToPath(uri);
    return pathToFileURL(filePath).toString();
  } catch {
    return uri;
  }
}

/**
 * Get a document by URI, using normalized lookup.
 */
function getDocument(uri: string): TextDocument | undefined {
  return documents.get(normalizeUri(uri));
}

/**
 * Set a document by URI, using normalized key.
 */
function setDocument(uri: string, document: TextDocument): void {
  documents.set(normalizeUri(uri), document);
}

/**
 * Delete a document by URI, using normalized key.
 */
function deleteDocument(uri: string): void {
  documents.delete(normalizeUri(uri));
}

/**
 * Safely read a file, returning null if it fails.
 */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

let umpleSyncJarPath: string | undefined;
let umpleSyncHost = "localhost";
let umpleSyncPort = 5555;
let umpleSyncTimeoutMs = 50000;
let jarWarningShown = false;
let serverProcess: ChildProcess | undefined;
let treeSitterWasmPath: string | undefined;
let symbolIndexReady = false;
const pendingDocumentsToIndex: Array<{ filePath: string; text: string }> = [];

const DEFAULT_UMPLESYNC_TIMEOUT_MS = 50000;

const KEYWORD_COMPLETIONS: CompletionItem[] =
  buildKeywordCompletions(ALL_KEYWORDS);

type CompletionContext =
  | "top"
  | "class"
  | "statemachine"
  | "association"
  | "enum"
  | "unknown";

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initOptions = params.initializationOptions as
    | {
        umpleSyncJarPath?: string;
        umpleSyncHost?: string;
        umpleSyncPort?: number;
        umpleSyncTimeoutMs?: number;
      }
    | undefined;
  umpleSyncJarPath = initOptions?.umpleSyncJarPath;
  umpleSyncHost =
    initOptions?.umpleSyncHost || process.env.UMPLESYNC_HOST || "localhost";
  if (typeof initOptions?.umpleSyncPort === "number") {
    umpleSyncPort = initOptions.umpleSyncPort;
  } else if (process.env.UMPLESYNC_PORT) {
    const parsed = Number(process.env.UMPLESYNC_PORT);
    if (!Number.isNaN(parsed)) {
      umpleSyncPort = parsed;
    }
  }
  if (typeof initOptions?.umpleSyncTimeoutMs === "number") {
    umpleSyncTimeoutMs = initOptions.umpleSyncTimeoutMs;
  } else if (process.env.UMPLESYNC_TIMEOUT_MS) {
    const parsed = Number(process.env.UMPLESYNC_TIMEOUT_MS);
    if (!Number.isNaN(parsed)) {
      umpleSyncTimeoutMs = parsed;
    }
  } else {
    umpleSyncTimeoutMs = DEFAULT_UMPLESYNC_TIMEOUT_MS;
  }

  workspaceRoots = resolveWorkspaceRoots(params);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [" ", "."],
      },
      definitionProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  connection.console.info("Umple language server initialized.");

  // Initialize tree-sitter symbol index for fast go-to-definition
  treeSitterWasmPath =
    treeSitterWasmPath ||
    path.join(
      __dirname,
      "..",
      "..",
      "tree-sitter-umple",
      "tree-sitter-umple.wasm",
    );

  if (fs.existsSync(treeSitterWasmPath)) {
    try {
      symbolIndexReady = await symbolIndex.initialize(treeSitterWasmPath);
      if (symbolIndexReady) {
        connection.console.info("Symbol index initialized with tree-sitter.");

        // Process documents that were opened before index was ready
        for (const pending of pendingDocumentsToIndex) {
          indexDocumentAndReferences(pending.filePath, pending.text);
        }
        pendingDocumentsToIndex.length = 0;
      }
    } catch (err) {
      connection.console.warn(`Failed to initialize symbol index: ${err}`);
    }
  } else {
    connection.console.info(
      `Tree-sitter WASM not found at ${treeSitterWasmPath}, using fallback go-to-definition.`,
    );
  }
});

// Create
connection.onDidOpenTextDocument((params) => {
  const document = TextDocument.create(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    params.textDocument.text,
  );
  setDocument(params.textDocument.uri, document);
  scheduleValidation(document);

  // Update symbol index for this file and all files it references
  try {
    const filePath = fileURLToPath(params.textDocument.uri);
    if (symbolIndexReady) {
      indexDocumentAndReferences(filePath, params.textDocument.text);
    } else {
      // Queue for processing once symbol index is ready
      pendingDocumentsToIndex.push({
        filePath,
        text: params.textDocument.text,
      });
    }
  } catch {
    // Ignore errors for non-file URIs
  }
});

/**
 * Index a document and all files it references via use statements.
 */
function indexDocumentAndReferences(filePath: string, text: string): void {
  const docDir = path.dirname(filePath);

  // Index the current file
  symbolIndex.updateFile(filePath, text);

  // Index all files reachable via use statements (for go-to-definition)
  const reachableFiles = collectReachableFiles(filePath, text, docDir);
  for (const reachableFile of reachableFiles) {
    if (!fs.existsSync(reachableFile)) continue;
    symbolIndex.indexFile(reachableFile);
  }
}

connection.onDidChangeTextDocument((params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document) {
    return;
  }
  const updated = TextDocument.update(
    document,
    params.contentChanges,
    params.textDocument.version,
  );
  setDocument(params.textDocument.uri, updated);
  modelCache.delete(normalizeUri(params.textDocument.uri));
  scheduleValidation(updated);

  // Update symbol index (debounced)
  scheduleIndexUpdate(params.textDocument.uri, updated);

  // Re-validate other open documents that might depend on this file
  scheduleDependentValidation(params.textDocument.uri);
});

connection.onDidCloseTextDocument((params) => {
  const normalizedUri = normalizeUri(params.textDocument.uri);
  deleteDocument(params.textDocument.uri);
  modelCache.delete(normalizedUri);
  // Cancel any pending updates for this document
  const pendingIndex = pendingIndexUpdates.get(normalizedUri);
  if (pendingIndex) {
    clearTimeout(pendingIndex);
    pendingIndexUpdates.delete(normalizedUri);
  }
  const pendingValidation = pendingValidations.get(normalizedUri);
  if (pendingValidation) {
    clearTimeout(pendingValidation);
    pendingValidations.delete(normalizedUri);
  }
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const document = getDocument(params.textDocument.uri);
  if (!document) {
    return KEYWORD_COMPLETIONS;
  }

  // Check for use statement file completion
  const docPath = getDocumentFilePath(document);
  if (docPath && symbolIndexReady) {
    const usePrefix = symbolIndex.getUseCompletionPrefix(
      docPath,
      document.getText(),
      params.position.line,
      Math.max(0, params.position.character - 1),
    );
    if (usePrefix !== null) {
      return getUseFileCompletions(
        document,
        usePrefix,
        params.position.line,
        params.position.character,
      );
    }
  }

  const context = detectContext(
    document,
    params.position.line,
    params.position.character,
  );
  const prefix = getCompletionPrefix(
    document,
    params.position.line,
    params.position.character,
  );
  const keywordItems = filterCompletions(
    buildKeywordCompletions(getKeywordsForContext(context)),
    prefix,
  );
  const modelItems = await getModelCompletions(document);
  return dedupeCompletions([
    ...keywordItems,
    ...filterCompletions(modelItems, prefix),
  ]);
});

connection.onDefinition(async (params) => {
  const document = getDocument(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const useLocation = resolveUseDefinitionFromLine(document, params.position);
  if (useLocation) {
    return [useLocation];
  }

  // Fast path: try symbol index first, filtered by reachable files
  if (symbolIndexReady) {
    // Skip if cursor is inside a comment
    const docPath = getDocumentFilePath(document);
    if (
      docPath &&
      symbolIndex.isPositionInComment(
        docPath,
        document.getText(),
        params.position.line,
        Math.max(0, params.position.character - 1),
      )
    ) {
      return [];
    }

    const word = getWordAtPosition(document, params.position);
    if (word) {
      const allSymbols = symbolIndex.findDefinition(word);
      if (allSymbols.length > 0) {
        // Get the set of files reachable via use statements
        const docPath = getDocumentFilePath(document);
        const reachableFiles = docPath
          ? collectReachableFiles(
              docPath,
              document.getText(),
              path.dirname(docPath),
            )
          : new Set<string>();

        // Also include the current file
        if (docPath) {
          reachableFiles.add(path.normalize(docPath));
        }

        // Filter symbols to only those in reachable files
        const filteredSymbols = allSymbols.filter((sym) =>
          reachableFiles.has(path.normalize(sym.file)),
        );

        if (filteredSymbols.length > 0) {
          const results: Location[] = filteredSymbols.map((sym) => {
            const uri = pathToFileURL(sym.file).toString();
            return Location.create(
              uri,
              Range.create(
                Position.create(sym.line, sym.column),
                Position.create(sym.endLine, sym.endColumn),
              ),
            );
          });
          connection.console.info(
            `Fast go-to-definition for "${word}": found ${results.length} result(s) (filtered from ${allSymbols.length})`,
          );
          return results;
        }
      }
    }
  }

  // No definition found in symbol index
  return [];
});

function scheduleValidation(document: TextDocument): void {
  const existing = pendingValidations.get(document.uri);
  if (existing) {
    clearTimeout(existing);
  }
  const handle = setTimeout(() => {
    pendingValidations.delete(document.uri);
    void validateTextDocument(document);
  }, 300);
  pendingValidations.set(document.uri, handle);
}

/**
 * Schedule a debounced symbol index update.
 * This avoids re-parsing the file on every keystroke.
 */
function scheduleIndexUpdate(uri: string, document: TextDocument): void {
  if (!symbolIndexReady) {
    return;
  }

  const existing = pendingIndexUpdates.get(uri);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    pendingIndexUpdates.delete(uri);
    try {
      const filePath = fileURLToPath(uri);
      symbolIndex.updateFile(filePath, document.getText());
    } catch {
      // Ignore errors for non-file URIs
    }
  }, 200); // Slightly shorter than validation since it's faster

  pendingIndexUpdates.set(uri, handle);
}

// Debounce key for dependent validation
const dependentValidationKey = "__dependent__";

/**
 * Schedule re-validation for open documents that actually import the changed file.
 * Uses a longer debounce time to avoid excessive re-validation.
 */
function scheduleDependentValidation(changedUri: string): void {
  // Clear any existing dependent validation timer
  const existing = pendingValidations.get(dependentValidationKey);
  if (existing) {
    clearTimeout(existing);
  }

  const normalizedChangedUri = normalizeUri(changedUri);

  const handle = setTimeout(() => {
    pendingValidations.delete(dependentValidationKey);

    // Get the changed file's basename for matching
    let changedFilename: string | null = null;
    try {
      const changedPath = fileURLToPath(changedUri);
      changedFilename = path.basename(changedPath);
    } catch {
      return; // Can't process non-file URIs
    }

    // Re-validate open documents that import the changed file
    for (const [uri, doc] of documents) {
      if (uri === normalizedChangedUri || !uri.endsWith(".ump")) {
        continue;
      }

      // Check if this document imports the changed file
      if (documentImportsFile(doc, changedFilename)) {
        scheduleValidation(doc);
      }
    }
  }, 500); // Longer debounce for dependent files

  pendingValidations.set(dependentValidationKey, handle);
}

/**
 * Check if a document imports a specific file (directly or transitively).
 */
function documentImportsFile(
  document: TextDocument,
  targetFilename: string,
): boolean {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return false;
  }

  const docDir = path.dirname(docPath);
  const reachableFiles = collectReachableFiles(
    docPath,
    document.getText(),
    docDir,
  );

  // Check if any reachable file matches the target filename
  for (const filePath of reachableFiles) {
    if (path.basename(filePath) === targetFilename) {
      return true;
    }
  }

  return false;
}

async function validateTextDocument(document: TextDocument): Promise<void> {
  const jarPath = resolveJarPath();
  if (!jarPath) {
    return;
  }

  try {
    const diagnostics = await runUmpleSyncAndParseDiagnostics(
      jarPath,
      document,
    );
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  } catch (error) {
    connection.console.error(`Diagnostics failed: ${String(error)}`);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  }
}

function resolveJarPath(): string | undefined {
  if (!umpleSyncJarPath) {
    if (!jarWarningShown) {
      connection.window.showWarningMessage(
        "UmpleSync jar path not set. Configure initializationOptions.umpleSyncJarPath or UMPLESYNC_JAR.",
      );
      jarWarningShown = true;
    }
    return undefined;
  }

  if (!fs.existsSync(umpleSyncJarPath)) {
    if (!jarWarningShown) {
      connection.window.showWarningMessage(
        `UmpleSync jar not found at ${umpleSyncJarPath}. Update the path or UMPLESYNC_JAR.`,
      );
      jarWarningShown = true;
    }
    return undefined;
  }

  return umpleSyncJarPath;
}

async function runUmpleSyncAndParseDiagnostics(
  jarPath: string,
  document: TextDocument,
): Promise<Diagnostic[]> {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return [];
  }

  // Create shadow workspace with all unsaved documents
  const shadow = await createShadowWorkspace(docPath);
  if (!shadow) {
    return [];
  }

  try {
    // Write current document to shadow workspace with trailing newlines
    let text = document.getText();
    if (!text.endsWith("\n\n")) {
      text = text.replace(/\n?$/, "\n\n");
    }
    await fs.promises.writeFile(shadow.targetFile, text, "utf8");

    const commandLine = `-generate nothing ${formatUmpleArg(shadow.targetFile)}`;
    const { stdout, stderr } = await sendUmpleSyncCommand(jarPath, commandLine);
    const tempFilename = path.basename(shadow.targetFile);
    const documentDir = getDocumentDirectory(document);
    return parseUmpleDiagnostics(
      stderr,
      stdout,
      document,
      tempFilename,
      documentDir,
    );
  } finally {
    await shadow.cleanup();
  }
}

interface ShadowWorkspace {
  shadowDir: string;
  targetFile: string; // Path to the main document in shadow workspace
  cleanup: () => Promise<void>;
}

/**
 * Create a shadow workspace with only the files needed for compilation:
 * the current document and all files it imports via `use` statements.
 */
async function createShadowWorkspace(
  documentPath: string,
): Promise<ShadowWorkspace | null> {
  const documentDir = path.dirname(documentPath);
  const documentName = path.basename(documentPath);

  // Get document content (from open doc or disk)
  const fileUri = pathToFileURL(documentPath).toString();
  const openDoc = getDocument(fileUri);
  const documentContent = openDoc?.getText() ?? readFileSafe(documentPath);

  if (!documentContent) {
    return null;
  }

  // Create shadow directory
  const shadowDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "umple-shadow-"),
  );

  try {
    // Find only files reachable via use statements (lazy approach)
    const reachableFiles = collectReachableFiles(
      documentPath,
      documentContent,
      documentDir,
    );

    // Also include the current document
    reachableFiles.add(path.normalize(documentPath));

    // Create directory structure and symlink/copy files
    for (const filePath of reachableFiles) {
      if (!fs.existsSync(filePath)) continue;

      const relativePath = path.relative(documentDir, filePath);
      const shadowPath = path.join(shadowDir, relativePath);
      const shadowFileDir = path.dirname(shadowPath);

      // Create directory structure
      await fs.promises.mkdir(shadowFileDir, { recursive: true });

      // Check if this file is open in the editor with unsaved changes
      const uri = pathToFileURL(filePath).toString();
      const doc = getDocument(uri);

      if (doc) {
        // Write unsaved content
        await fs.promises.writeFile(shadowPath, doc.getText(), "utf8");
      } else {
        // Symlink to original file
        await fs.promises.symlink(filePath, shadowPath);
      }
    }

    const targetFile = path.join(shadowDir, documentName);

    return {
      shadowDir,
      targetFile,
      cleanup: async () => {
        await fs.promises.rm(shadowDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    // Cleanup on error
    await fs.promises.rm(shadowDir, { recursive: true, force: true });
    throw error;
  }
}

async function sendUmpleSyncCommand(
  jarPath: string,
  commandLine: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await connectAndSend(commandLine);
  } catch (error) {
    if (!isConnectionError(error)) {
      throw error;
    }

    const started = await startUmpleSyncServer(jarPath);
    if (!started) {
      throw error;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await connectAndSend(commandLine);
      } catch (retryError) {
        if (!isConnectionError(retryError)) {
          throw retryError;
        }
        await delay(150);
      }
    }

    throw error;
  }
}

// Send command to UmpleSync.jar socket server and receive the output
function connectAndSend(
  commandLine: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: string[] = [];
    let settled = false;

    const finishSuccess = (raw: string) => {
      if (settled) {
        return;
      }
      settled = true;
      const { stdout, stderr } = splitUmpleSyncOutput(raw);
      resolve({ stdout, stderr });
    };

    const finishError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(umpleSyncTimeoutMs);

    socket.on("data", (chunk) => {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      } else {
        chunks.push(chunk.toString("utf8"));
      }
    });

    socket.on("end", () => {
      finishSuccess(chunks.join(""));
    });

    socket.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      finishError(error);
    });

    socket.on("timeout", () => {
      finishError(new Error("umplesync socket timeout"));
    });

    socket.connect(umpleSyncPort, umpleSyncHost, () => {
      socket.end(commandLine);
    });
  });
}

async function startUmpleSyncServer(jarPath: string): Promise<boolean> {
  if (serverProcess) {
    return true;
  }

  return new Promise((resolve) => {
    const child = spawn(
      "java",
      ["-jar", jarPath, "-server", String(umpleSyncPort)],
      {
        detached: true,
        stdio: "ignore",
      },
    );

    child.on("error", (err) => {
      connection.console.error(`Failed to start umplesync: ${String(err)}`);
      resolve(false);
    });

    child.unref();
    serverProcess = child;
    resolve(true);
  });
}

function splitUmpleSyncOutput(raw: string): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let index = 0;

  while (index < raw.length) {
    const start = raw.indexOf("ERROR!!", index);
    if (start === -1) {
      stdout += raw.slice(index);
      break;
    }

    stdout += raw.slice(index, start);
    const end = raw.indexOf("!!ERROR", start + 7);
    if (end === -1) {
      stderr += raw.slice(start + 7);
      break;
    }

    stderr += raw.slice(start + 7, end);
    index = end + 7;
  }

  return { stdout, stderr };
}

/**
 * Collect all file paths reachable via transitive use statements.
 * Used to filter go-to-definition results to only show symbols from imported files.
 */
function collectReachableFiles(
  filePath: string,
  content: string,
  documentDir: string,
): Set<string> {
  const visited = new Set<string>();
  collectReachableFilesRecursive(filePath, content, documentDir, visited);
  return visited;
}

/**
 * Recursively collect reachable file paths.
 */
function collectReachableFilesRecursive(
  filePath: string,
  content: string,
  documentDir: string,
  visited: Set<string>,
): void {
  const useStatements = symbolIndex.extractUseStatements(filePath, content);
  for (const usePath of useStatements) {
    // Resolve the file path
    let resolvedPath: string;
    if (path.isAbsolute(usePath)) {
      resolvedPath = usePath;
    } else {
      resolvedPath = path.resolve(documentDir, usePath);
    }

    // Ensure .ump extension
    if (!resolvedPath.endsWith(".ump")) {
      resolvedPath += ".ump";
    }

    const normalizedPath = path.normalize(resolvedPath);
    if (visited.has(normalizedPath)) {
      continue; // Already visited, skip to avoid cycles
    }
    visited.add(normalizedPath);

    // Recursively process this file's use statements
    if (fs.existsSync(resolvedPath)) {
      try {
        const fileContent = fs.readFileSync(resolvedPath, "utf8");
        const fileDir = path.dirname(resolvedPath);
        collectReachableFilesRecursive(
          resolvedPath,
          fileContent,
          fileDir,
          visited,
        );
      } catch {
        // Ignore read errors
      }
    }
  }
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as { code?: string; message?: string };
  return (
    maybeError.code === "ECONNREFUSED" ||
    maybeError.code === "ECONNRESET" ||
    maybeError.code === "EPIPE" ||
    maybeError.code === "ETIMEDOUT" ||
    (maybeError.message || "").includes("umplesync socket timeout")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUmpleDiagnostics(
  stderr: string,
  stdout: string,
  document: TextDocument,
  tempFilename: string,
  documentDir: string | null,
): Diagnostic[] {
  const jsonDiagnostics = parseUmpleJsonDiagnostics(
    stderr,
    document,
    tempFilename,
    documentDir,
  );

  if (jsonDiagnostics.length === 0 && stdout.includes("Success")) {
    connection.console.info("Umple compile succeeded.");
  }

  return jsonDiagnostics;
}

type UmpleJsonResult = {
  errorCode?: string;
  severity?: string;
  url?: string;
  line?: string;
  filename?: string;
  message?: string;
};

/**
 * Build a map of direct import filename → use statement line number.
 * Also builds a transitive map: direct filename → set of all transitive filenames.
 */
function buildImportMaps(
  useStatements: UseStatementWithPosition[],
  documentDir: string,
): {
  directImports: Map<string, number>;
  transitiveMap: Map<string, Set<string>>;
} {
  const directImports = new Map<string, number>();
  const transitiveMap = new Map<string, Set<string>>();

  for (const useStmt of useStatements) {
    // Resolve the use path to a filename
    let resolvedPath = useStmt.path;
    if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(documentDir, resolvedPath);
    }
    if (!resolvedPath.endsWith(".ump")) {
      resolvedPath += ".ump";
    }
    const filename = path.basename(resolvedPath);

    // Map direct import filename to line
    directImports.set(filename, useStmt.line);

    // Collect transitive imports for this direct import
    const transitiveFiles = new Set<string>();
    transitiveFiles.add(filename); // Include the direct import itself
    collectTransitiveFilenames(resolvedPath, transitiveFiles);
    transitiveMap.set(filename, transitiveFiles);
  }

  return { directImports, transitiveMap };
}

/**
 * Recursively collect all filenames transitively imported by a file.
 */
function collectTransitiveFilenames(
  filePath: string,
  collected: Set<string>,
  visited: Set<string> = new Set(),
): void {
  const normalizedPath = path.normalize(filePath);
  if (visited.has(normalizedPath)) {
    return; // Avoid cycles
  }
  visited.add(normalizedPath);

  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const fileDir = path.dirname(filePath);
    const useStatements = symbolIndex.extractUseStatements(filePath, content);

    for (const usePath of useStatements) {
      let resolvedPath = usePath;
      if (!path.isAbsolute(resolvedPath)) {
        resolvedPath = path.resolve(fileDir, resolvedPath);
      }
      if (!resolvedPath.endsWith(".ump")) {
        resolvedPath += ".ump";
      }
      const filename = path.basename(resolvedPath);
      collected.add(filename);
      collectTransitiveFilenames(resolvedPath, collected, visited);
    }
  } catch {
    // Ignore read errors
  }
}

/**
 * Find the use statement line for an error from an imported file.
 * Returns the line number if found, or undefined if the error doesn't match any import.
 */
function findUseLineForError(
  errorFilename: string,
  directImports: Map<string, number>,
  transitiveMap: Map<string, Set<string>>,
): number | undefined {
  // Check if it's a direct import
  if (directImports.has(errorFilename)) {
    return directImports.get(errorFilename);
  }

  // Check transitive imports
  for (const [directFilename, transitiveFiles] of transitiveMap) {
    if (transitiveFiles.has(errorFilename)) {
      return directImports.get(directFilename);
    }
  }

  return undefined;
}

function parseUmpleJsonDiagnostics(
  stderr: string,
  document: TextDocument,
  tempFilename: string,
  documentDir: string | null,
): Diagnostic[] {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return [];
  }

  const jsonText = extractJson(trimmed);
  if (!jsonText) {
    return [];
  }

  try {
    // Sanitize invalid JSON escapes from umplesync (e.g. \' is not valid JSON)
    const sanitized = jsonText.replace(/\\'/g, "'");
    const parsed = JSON.parse(sanitized) as { results?: UmpleJsonResult[] };
    if (!Array.isArray(parsed.results)) {
      return [];
    }

    const lines = document.getText().split(/\r?\n/);
    const diagnostics: Diagnostic[] = [];

    // Build import maps for mapping imported file errors to use statement lines
    const docPath = getDocumentFilePath(document);
    let directImports = new Map<string, number>();
    let transitiveMap = new Map<string, Set<string>>();

    if (docPath && documentDir) {
      const useStatements = symbolIndex.extractUseStatementsWithPositions(
        docPath,
        document.getText(),
      );
      const maps = buildImportMaps(useStatements, documentDir);
      directImports = maps.directImports;
      transitiveMap = maps.transitiveMap;
    }

    for (const result of parsed.results) {
      const severityValue = Number(result.severity ?? "3");
      const severity =
        severityValue > 2
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Error;

      // Check if error is from an imported file
      if (result.filename && result.filename !== tempFilename) {
        // Find the use statement line for this imported file error
        const useLine = findUseLineForError(
          result.filename,
          directImports,
          transitiveMap,
        );
        if (useLine !== undefined) {
          const useLineText = lines[useLine] ?? "";
          const errorCode = result.errorCode
            ? (severity === DiagnosticSeverity.Warning ? "W" : "E") +
              result.errorCode
            : "";
          const message = errorCode
            ? `In imported file (${result.filename}:${result.line}): ${errorCode}: ${result.message}`
            : `In imported file (${result.filename}:${result.line}): ${result.message}`;

          diagnostics.push({
            severity,
            range: Range.create(
              Position.create(useLine, 0),
              Position.create(useLine, useLineText.length),
            ),
            message,
            source: "umple",
          });
        }
        continue;
      }

      // Error in current file
      const lineNumber = Math.max(Number(result.line ?? "1") - 1, 0);
      const lineText = lines[lineNumber] ?? "";
      const firstNonSpace = lineText.search(/\S/);
      const startChar = firstNonSpace === -1 ? 0 : firstNonSpace;

      const details = [
        result.errorCode
          ? (severity === DiagnosticSeverity.Warning ? "W" : "E") +
            result.errorCode
          : undefined,
        result.message,
      ].filter(Boolean);

      diagnostics.push({
        severity,
        range: Range.create(
          Position.create(lineNumber, startChar),
          Position.create(lineNumber, lineText.length),
        ),
        message: details.join(": "),
        source: "umple",
      });
    }

    return diagnostics;
  } catch {
    return [];
  }
}

function resolveWorkspaceRoots(params: InitializeParams): string[] {
  const roots: string[] = [];
  if (Array.isArray(params.workspaceFolders)) {
    for (const folder of params.workspaceFolders) {
      if (folder.uri.startsWith("file:")) {
        try {
          roots.push(path.resolve(fileURLToPath(folder.uri)));
        } catch {
          // ignore invalid workspace uri
        }
      }
    }
  }
  if (
    roots.length === 0 &&
    params.rootUri &&
    params.rootUri.startsWith("file:")
  ) {
    try {
      roots.push(path.resolve(fileURLToPath(params.rootUri)));
    } catch {
      // ignore invalid root uri
    }
  }
  return roots;
}

async function writeTempUmpleFile(
  document: TextDocument,
  label: string,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const baseDir = getDocumentDirectory(document);
  if (baseDir) {
    const filePath = path.join(
      baseDir,
      `.umple-lsp-${label}-${process.pid}-${Date.now()}.ump`,
    );
    return {
      filePath,
      cleanup: async () => {
        await fs.promises.rm(filePath, { force: true });
      },
    };
  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `umple-lsp-${label}-`),
  );
  const filePath = path.join(tempDir, "document.ump");
  return {
    filePath,
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    },
  };
}

function getDocumentDirectory(document: TextDocument): string | null {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return null;
  }
  return path.dirname(docPath);
}

function getDocumentFilePath(document: TextDocument): string | null {
  if (!document.uri.startsWith("file:")) {
    return null;
  }
  try {
    return fileURLToPath(document.uri);
  } catch {
    return null;
  }
}

function resolveUseDefinitionFromLine(
  document: TextDocument,
  position: Position,
): Location | null {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return null;
  }

  // Use tree-sitter to find the use path at this position
  const usePath = symbolIndex.getUsePathAtPosition(
    docPath,
    document.getText(),
    position.line,
    Math.max(0, position.character - 1),
  );

  if (!usePath) {
    return null;
  }

  // Ensure .ump extension
  let fileRef = usePath;
  if (!fileRef.endsWith(".ump")) {
    fileRef += ".ump";
  }

  const baseDir = path.dirname(docPath);
  const targetPath = path.isAbsolute(fileRef)
    ? fileRef
    : path.join(baseDir, fileRef);
  const uri = pathToFileURL(targetPath).toString();
  return Location.create(
    uri,
    Range.create(Position.create(0, 0), Position.create(0, 0)),
  );
}

function getCompletionPrefix(
  document: TextDocument,
  line: number,
  character: number,
): string {
  const lineText = document.getText(
    Range.create(Position.create(line, 0), Position.create(line, character)),
  );
  const match = lineText.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  return match ? match[0] : "";
}

/**
 * Get the word (identifier) at the given position.
 * Used for go-to-definition symbol lookup.
 */
function getWordAtPosition(
  document: TextDocument,
  position: Position,
): string | null {
  const lineText = document.getText(
    Range.create(
      Position.create(position.line, 0),
      Position.create(position.line + 1, 0),
    ),
  );

  // Find word boundaries around the cursor
  let start = position.character;
  let end = position.character;

  // Expand left to find start of word
  while (start > 0 && /[A-Za-z0-9_]/.test(lineText[start - 1])) {
    start--;
  }

  // Expand right to find end of word
  while (end < lineText.length && /[A-Za-z0-9_]/.test(lineText[end])) {
    end++;
  }

  if (start === end) {
    return null;
  }

  const word = lineText.substring(start, end);
  // Only return valid identifiers (must start with letter or underscore)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
    return word;
  }
  return null;
}

function filterCompletions(
  items: CompletionItem[],
  prefix: string,
): CompletionItem[] {
  if (!prefix) {
    return items;
  }
  const lowerPrefix = prefix.toLowerCase();
  return items.filter((item) =>
    item.label.toLowerCase().startsWith(lowerPrefix),
  );
}

function buildKeywordCompletions(keywords: string[]): CompletionItem[] {
  return Array.from(new Set(keywords)).map((label) => ({
    label,
    kind: CompletionItemKind.Keyword,
  }));
}

function getKeywordsForContext(context: CompletionContext): string[] {
  switch (context) {
    case "top":
      return [
        ...KEYWORDS.topLevel,
        ...KEYWORDS.testing,
        ...KEYWORDS.tracing,
        ...KEYWORDS.misc,
      ];
    case "class":
      return [
        ...KEYWORDS.classLevel,
        ...KEYWORDS.attribute,
        ...KEYWORDS.method,
        ...KEYWORDS.constraints,
        ...KEYWORDS.modelConstraints,
        ...KEYWORDS.tracing,
        ...KEYWORDS.testing,
      ];
    case "statemachine":
      return [...KEYWORDS.statemachine, ...KEYWORDS.constraints];
    case "association":
      return [...KEYWORDS.constraints];
    case "enum":
      return [];
    default:
      return ALL_KEYWORDS;
  }
}

function detectContext(
  document: TextDocument,
  line: number,
  character: number,
): CompletionContext {
  const range = Range.create(
    Position.create(0, 0),
    Position.create(line, character),
  );
  let text = document.getText(range);
  if (text.length > 20000) {
    text = text.slice(text.length - 20000);
  }

  const stack: string[] = [];
  const keywordContext: Record<string, CompletionContext> = {
    class: "class",
    trait: "class",
    interface: "class",
    association: "association",
    associationClass: "class",
    statemachine: "statemachine",
    enum: "enum",
    mixset: "top",
    filter: "top",
  };

  let lastKeyword: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) {
        j += 1;
      }
      const word = text.slice(i, j);
      if (word in keywordContext) {
        lastKeyword = word;
      }
      // lastKeyword = keywordContext[word] ? word : null;
      i = j - 1;
      continue;
    }

    if (ch === "{") {
      if (lastKeyword && keywordContext[lastKeyword]) {
        stack.push(keywordContext[lastKeyword]);
      } else {
        stack.push("block");
      }
      lastKeyword = null;
      continue;
    }

    if (ch === "}") {
      if (stack.length > 0) {
        stack.pop();
      }
      lastKeyword = null;
    }
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const ctx = stack[i];
    if (
      ctx === "statemachine" ||
      ctx === "association" ||
      ctx === "class" ||
      ctx === "enum"
    ) {
      return ctx;
    }
  }

  return "top";
}

function getClassNameCompletions(prefix: string): CompletionItem[] {
  const classNames = new Set<string>();
  for (const document of documents.values()) {
    const text = document.getText();
    const regex = /\b(class|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      classNames.add(match[2]);
    }
  }

  const items = Array.from(classNames).map((name) => ({
    label: name,
    kind: CompletionItemKind.Class,
  }));

  return filterCompletions(items, prefix);
}

function getUseFileCompletions(
  document: TextDocument,
  prefix: string,
  line: number,
  character: number,
): CompletionItem[] {
  const docDir = getDocumentDirectory(document);
  if (!docDir) {
    return [];
  }

  const docBasename = path.basename(getDocumentFilePath(document) ?? "");

  let files: string[];
  try {
    files = fs
      .readdirSync(docDir)
      .filter((f) => f.endsWith(".ump") && f !== docBasename);
  } catch {
    return [];
  }

  // Replace range covers the entire prefix the user has typed
  const replaceRange = Range.create(
    Position.create(line, character - prefix.length),
    Position.create(line, character),
  );

  const lowerPrefix = prefix.toLowerCase();
  return files
    .filter((f) => f.toLowerCase().startsWith(lowerPrefix))
    .map((f) => ({
      label: f,
      kind: CompletionItemKind.File,
      detail: "Umple file",
      textEdit: { range: replaceRange, newText: f },
    }));
}

async function getModelCompletions(
  document: TextDocument,
): Promise<CompletionItem[]> {
  const cached = modelCache.get(document.uri);
  if (cached && cached.version === document.version) {
    return cached.items;
  }

  let items: CompletionItem[] = [];
  try {
    const modelJson = await generateModelJson(document);
    if (modelJson) {
      items = buildModelCompletions(modelJson);
    }
  } catch (error) {
    connection.console.warn(
      `Failed to build model completions: ${String(error)}`,
    );
  }
  modelCache.set(document.uri, { version: document.version, items });

  return items;
}

async function generateModelJson(
  document: TextDocument,
): Promise<unknown | null> {
  const jarPath = resolveJarPath();
  if (!jarPath) {
    return null;
  }

  const tempFileInfo = await writeTempUmpleFile(document, "model");
  const tempFile = tempFileInfo.filePath;
  let text = document.getText();
  if (!text.endsWith("\n\n")) {
    text = text.replace(/\n?$/, "\n\n");
  }
  await fs.promises.writeFile(tempFile, text, "utf8");

  try {
    const commandLine = `-generate JsonMixed ${formatUmpleArg(tempFile)}`;
    const { stdout } = await sendUmpleSyncCommand(jarPath, commandLine);
    const jsonText = extractJson(stdout);
    if (!jsonText) {
      return null;
    }
    return JSON.parse(jsonText);
  } finally {
    await tempFileInfo.cleanup();
  }
}

function buildModelCompletions(modelJson: unknown): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const model = modelJson as {
    umpleClasses?: Array<{
      name?: string;
      attributes?: Array<{ name?: string; type?: string }>;
      stateMachines?: Array<{
        name?: string;
        states?: Array<{ name?: string }>;
        transitions?: Array<{
          labels?: Array<{
            attrs?: { text?: { text?: string } };
          }>;
        }>;
      }>;
    }>;
    umpleAssociations?: Array<{
      name?: string;
      classOneId?: string;
      classTwoId?: string;
    }>;
  };

  // umple classes
  for (const umpleClass of model.umpleClasses ?? []) {
    // class name
    const className = umpleClass.name;
    if (className) {
      addCompletion(items, seen, {
        label: className,
        kind: CompletionItemKind.Class,
        detail: "class",
      });
    }
    // attributes
    for (const attr of umpleClass.attributes ?? []) {
      if (!attr.name) {
        continue;
      }
      const detail = attr.type ? `${attr.type} attribute` : "attribute";
      addCompletion(items, seen, {
        label: attr.name,
        kind: CompletionItemKind.Field,
        detail: className ? `${detail} in ${className}` : detail,
      });
    }

    // statemachines
    for (const sm of umpleClass.stateMachines ?? []) {
      // state names
      for (const state of sm.states ?? []) {
        if (!state.name) {
          continue;
        }
        addCompletion(items, seen, {
          label: state.name,
          kind: CompletionItemKind.EnumMember,
          detail: "state",
        });
      }

      // transition
      for (const transition of sm.transitions ?? []) {
        for (const label of transition.labels ?? []) {
          const text = label?.attrs?.text?.text;
          const eventName = extractEventName(text);
          if (!eventName) {
            continue;
          }
          addCompletion(items, seen, {
            label: eventName,
            kind: CompletionItemKind.Event,
            detail: "event",
          });
        }
      }
    }
  }

  for (const assoc of model.umpleAssociations ?? []) {
    const name =
      assoc.name ??
      (assoc.classOneId && assoc.classTwoId
        ? `${assoc.classOneId}__${assoc.classTwoId}`
        : undefined);
    if (!name) {
      continue;
    }
    addCompletion(items, seen, {
      label: name,
      kind: CompletionItemKind.Property,
      detail: "association",
    });
  }

  return items;
}

function extractEventName(labelText: string | undefined): string | null {
  if (!labelText) {
    return null;
  }
  const trimmed = labelText.trim();
  if (!trimmed) {
    return null;
  }
  const stopIndex = trimmed.search(/\s*\[|\s*\/\s*/);
  if (stopIndex === -1) {
    return trimmed;
  }
  return trimmed.slice(0, stopIndex).trim();
}

function addCompletion(
  items: CompletionItem[],
  seen: Set<string>,
  item: CompletionItem,
): void {
  const key = `${item.kind ?? "text"}:${item.label}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  items.push(item);
}

function dedupeCompletions(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  const result: CompletionItem[] = [];
  for (const item of items) {
    const key = `${item.kind ?? "text"}:${item.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function formatUmpleArg(filePath: string): string {
  return JSON.stringify(filePath);
}

connection.listen();
