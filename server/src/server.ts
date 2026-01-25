import { ChildProcess, execFile, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
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

const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();
const modelCache = new Map<
  string,
  { version: number; items: CompletionItem[] }
>();
const shadowWorkspaces = new Map<string, ShadowWorkspaceState>();
let workspaceRoots: string[] = [];
let goToDefClient: GoToDefServerClient | null = null;

let umpleSyncJarPath: string | undefined;
let umpleSyncHost = "localhost";
let umpleSyncPort = 5555;
let umpleSyncTimeoutMs = 50000;
let jarWarningShown = false;
let serverProcess: ChildProcess | undefined;
let umpleJarPath: string | undefined;
let umpleGoToDefClasspath: string | undefined;

const execFileAsync = promisify(execFile);
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
        umpleJarPath?: string;
        umpleGoToDefClasspath?: string;
      }
    | undefined;
  umpleSyncJarPath = initOptions?.umpleSyncJarPath;
  umpleSyncHost =
    initOptions?.umpleSyncHost || process.env.UMPLESYNC_HOST || "localhost";
  umpleJarPath = initOptions?.umpleJarPath;
  umpleGoToDefClasspath = initOptions?.umpleGoToDefClasspath;
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

connection.onInitialized(() => {
  connection.console.info("Umple language server initialized.");
});

// Create
connection.onDidOpenTextDocument((params) => {
  const document = TextDocument.create(
    params.textDocument.uri,
    params.textDocument.languageId,
    params.textDocument.version,
    params.textDocument.text,
  );
  documents.set(params.textDocument.uri, document);
  scheduleValidation(document);
});

connection.onDidChangeTextDocument((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return;
  }
  const updated = TextDocument.update(
    document,
    params.contentChanges,
    params.textDocument.version,
  );
  documents.set(params.textDocument.uri, updated);
  modelCache.delete(params.textDocument.uri);
  scheduleValidation(updated);
});

connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  modelCache.delete(params.textDocument.uri);
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return KEYWORD_COMPLETIONS;
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
  // const classItems = getClassNameCompletions(prefix);
  return dedupeCompletions([
    ...keywordItems,
    ...filterCompletions(modelItems, prefix),
    // ...classItems,
  ]);
});

connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const useLocation = resolveUseDefinitionFromLine(document, params.position);
  if (useLocation) {
    return [useLocation];
  }

  const settings = resolveGoToDefSettings();
  if (!settings) {
    return [];
  }

  const { jarPath, classpath } = settings;
  const shadowInfo = await getOrCreateShadowWorkspace(document, "def");
  const tempFileInfo = shadowInfo
    ? null
    : await writeTempUmpleFile(document, "def");
  const tempFile = shadowInfo ? shadowInfo.filePath : tempFileInfo!.filePath;
  if (!shadowInfo) {
    let text = document.getText();
    if (!text.endsWith("\n\n")) {
      text = text.replace(/\n?$/, "\n\n");
    }
    await fs.promises.writeFile(tempFile, text, "utf8");
  }

  try {
    const line = params.position.line + 1;
    const col = params.position.character;
    let def: GoToDefResult | null = null;
    try {
      const client = getGoToDefClient({ jarPath, classpath });
      def = await client.request(tempFile, line, col);
    } catch (error) {
      // Fall back to one-shot execution if the daemon fails.
      connection.console.warn(
        `Go-to-definition daemon failed: ${String(error)}`,
      );
      def = await runGoToDefOnce(jarPath, classpath, tempFile, line, col);
    }

    if (!def?.found) {
      return [];
    }

    const uri = resolveDefinitionUri(
      def,
      document,
      tempFile,
      shadowInfo?.shadowRoot,
      shadowInfo?.workspaceRoot,
    );
    const defLine = Math.max((def.line ?? 1) - 1, 0);
    const defCol = Math.max((def.col ?? 1) - 1, 0);
    return [
      Location.create(
        uri,
        Range.create(
          Position.create(defLine, defCol),
          Position.create(defLine, defCol),
        ),
      ),
    ];
  } catch (error) {
    connection.console.warn(`Go to definition failed: ${String(error)}`);
    return [];
  } finally {
    if (tempFileInfo) {
      await tempFileInfo.cleanup();
    }
  }
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

function resolveGoToDefSettings():
  | { jarPath: string; classpath: string }
  | undefined {
  if (!umpleJarPath) {
    connection.window.showWarningMessage(
      "Umple jar path not set. Configure initializationOptions.umpleJarPath.",
    );
    return undefined;
  }
  if (!umpleGoToDefClasspath) {
    connection.window.showWarningMessage(
      "Go-to-definition classpath not set. Configure initializationOptions.umpleGoToDefClasspath.",
    );
    return undefined;
  }
  if (!fs.existsSync(umpleJarPath)) {
    connection.window.showWarningMessage(
      `Umple jar not found at ${umpleJarPath}.`,
    );
    return undefined;
  }
  if (!fs.existsSync(umpleGoToDefClasspath)) {
    connection.window.showWarningMessage(
      `Go-to-definition classpath not found at ${umpleGoToDefClasspath}.`,
    );
    return undefined;
  }
  return { jarPath: umpleJarPath, classpath: umpleGoToDefClasspath };
}

function getGoToDefClient(settings: {
  jarPath: string;
  classpath: string;
}): GoToDefServerClient {
  if (goToDefClient && goToDefClient.matches(settings)) {
    return goToDefClient;
  }
  if (goToDefClient) {
    goToDefClient.dispose();
  }
  goToDefClient = new GoToDefServerClient(settings);
  return goToDefClient;
}

async function runGoToDefOnce(
  jarPath: string,
  classpath: string,
  tempFile: string,
  line: number,
  col: number,
): Promise<GoToDefResult | null> {
  const classPath = [jarPath, classpath].join(path.delimiter);
  const { stdout } = await execFileAsync(
    "java",
    ["-cp", classPath, "UmpleGoToDefJson", tempFile, String(line), String(col)],
    { encoding: "utf8", timeout: 50000 },
  );
  return parseGoToDefOutput(stdout);
}

async function runUmpleSyncAndParseDiagnostics(
  jarPath: string,
  document: TextDocument,
): Promise<Diagnostic[]> {
  const tempFileInfo = await writeTempUmpleFile(document, "diag");
  const tempFile = tempFileInfo.filePath;
  let text = document.getText();
  text = sanitizeUseStatements(text);
  // Umple needs two trailing newlines to report end-of-file errors on the last line.
  if (!text.endsWith("\n\n")) {
    text = text.replace(/\n?$/, "\n\n");
  }
  await fs.promises.writeFile(tempFile, text, "utf8");

  try {
    const commandLine = `-generate nothing ${formatUmpleArg(tempFile)}`;
    const { stdout, stderr } = await sendUmpleSyncCommand(jarPath, commandLine);
    return parseUmpleDiagnostics(stderr, stdout, document);
  } finally {
    await tempFileInfo.cleanup();
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

function sanitizeUseStatements(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*use\b/.test(line)) {
      lines[i] = `//${line}`;
    }
  }
  return lines.join("\n");
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

class GoToDefServerClient {
  private process: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: GoToDefResult | null) => void;
      reject: (error: Error) => void;
    }
  >();
  private settings: { jarPath: string; classpath: string };

  constructor(settings: { jarPath: string; classpath: string }) {
    this.settings = settings;
  }

  matches(settings: { jarPath: string; classpath: string }): boolean {
    return (
      this.settings.jarPath === settings.jarPath &&
      this.settings.classpath === settings.classpath
    );
  }

  dispose(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.pending.clear();
  }

  async request(
    file: string,
    line: number,
    col: number,
  ): Promise<GoToDefResult | null> {
    this.ensureProcess();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, file, line, col });

    return new Promise((resolve, reject) => {
      const process = this.process;
      if (!process || !process.stdin) {
        reject(new Error("Go-to-definition daemon not running"));
        return;
      }

      this.pending.set(id, { resolve, reject });
      // Send one request per line to the daemon.
      process.stdin.write(`${payload}\n`, "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private ensureProcess(): void {
    if (this.process) {
      return;
    }
    // Start the Java daemon once and reuse it.
    const classPath = [this.settings.jarPath, this.settings.classpath].join(
      path.delimiter,
    );
    const child = spawn(
      "java",
      ["-cp", classPath, "UmpleGoToDefJson", "--server"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.process = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      this.buffer += chunk;
      this.flushBuffer();
    });
    child.stderr?.on("data", (chunk) => {
      connection.console.warn(`Go-to-definition daemon stderr: ${chunk}`);
    });
    child.on("exit", (code) => {
      const error = new Error(`Go-to-definition daemon exited: ${code}`);
      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();
      this.process = null;
    });
  }

  private flushBuffer(): void {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleResponseLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleResponseLine(line: string): void {
    let parsed: GoToDefServerResponse | null = null;
    try {
      parsed = JSON.parse(line) as GoToDefServerResponse;
    } catch {
      connection.console.warn(
        `Go-to-definition daemon sent invalid JSON: ${line}`,
      );
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id);
    pending.resolve(parsed);
  }
}

function parseUmpleDiagnostics(
  stderr: string,
  stdout: string,
  document: TextDocument,
): Diagnostic[] {
  const jsonDiagnostics = parseUmpleJsonDiagnostics(stderr, document);
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

type GoToDefResult = {
  found: boolean;
  kind?: string;
  name?: string;
  file?: string;
  line?: number;
  col?: number;
};

type GoToDefServerResponse = GoToDefResult & { id: number };

type ShadowWorkspace = {
  filePath: string;
  shadowRoot: string;
  workspaceRoot: string;
};

type ShadowWorkspaceState = {
  shadowRoot: string;
  workspaceRoot: string;
  docVersions: Map<string, number>;
};

function parseUmpleJsonDiagnostics(
  stderr: string,
  document: TextDocument,
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
    const parsed = JSON.parse(jsonText) as { results?: UmpleJsonResult[] };
    if (!Array.isArray(parsed.results)) {
      return [];
    }

    const lines = document.getText().split(/\r?\n/);
    return parsed.results.map((result) => {
      const lineNumber = Math.max(Number(result.line ?? "1") - 1, 0);
      const lineText = lines[lineNumber] ?? "";
      const firstNonSpace = lineText.search(/\S/);
      const startChar = firstNonSpace === -1 ? 0 : firstNonSpace;
      const severityValue = Number(result.severity ?? "3");
      const severity =
        severityValue > 2
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Error;

      const details = [
        result.errorCode
          ? (severity == DiagnosticSeverity.Warning ? "W" : "E") +
            result.errorCode
          : undefined,
        result.message,
      ].filter(Boolean);

      return {
        severity,
        range: Range.create(
          Position.create(lineNumber, startChar),
          Position.create(lineNumber, lineText.length),
        ),
        message: details.join(": "),
        source: "umple",
      };
    });
  } catch {
    return [];
  }
}

function parseGoToDefOutput(stdout: string): GoToDefResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as GoToDefResult;
    if (typeof parsed?.found !== "boolean") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveDefinitionUri(
  def: GoToDefResult,
  document: TextDocument,
  tempFile: string,
  shadowRoot?: string,
  workspaceRoot?: string,
): string {
  const docPath = getDocumentFilePath(document);
  const docDir = docPath ? path.dirname(docPath) : null;
  const rawFile = def.file?.trim();
  let resolvedPath: string | null = null;

  if (!rawFile) {
    resolvedPath = docPath;
  } else if (path.isAbsolute(rawFile)) {
    resolvedPath = rawFile;
  } else if (docDir) {
    resolvedPath = path.join(docDir, rawFile);
  } else {
    resolvedPath = rawFile;
  }

  if (!resolvedPath) {
    return document.uri;
  }

  const tempBase = path.basename(tempFile);
  const resolvedBase = path.basename(resolvedPath);
  if (resolvedPath === tempFile || resolvedBase === tempBase) {
    return document.uri;
  }
  if (docPath && resolvedPath === docPath) {
    return document.uri;
  }

  if (shadowRoot && workspaceRoot) {
    const relative = path.relative(shadowRoot, resolvedPath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      resolvedPath = path.join(workspaceRoot, relative);
      return pathToFileURL(resolvedPath).toString();
    }
  }

  return pathToFileURL(resolvedPath).toString();
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

async function getOrCreateShadowWorkspace(
  document: TextDocument,
  label: string,
): Promise<ShadowWorkspace | null> {
  const docPath = getDocumentFilePath(document);
  if (!docPath) {
    return null;
  }
  const workspaceRoot = getWorkspaceRootForPath(docPath);
  if (!workspaceRoot) {
    return null;
  }

  let state = shadowWorkspaces.get(workspaceRoot);
  if (!state) {
    const shadowRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `umple-shadow-${label}-`),
    );
    await mirrorWorkspaceUmpleFiles(workspaceRoot, shadowRoot);
    state = {
      shadowRoot,
      workspaceRoot,
      docVersions: new Map(),
    };
    shadowWorkspaces.set(workspaceRoot, state);
  }

  await overlayOpenDocumentsCached(
    workspaceRoot,
    state.shadowRoot,
    state.docVersions,
  );

  const relative = path.relative(workspaceRoot, docPath);
  const filePath = path.join(state.shadowRoot, relative);
  return {
    filePath,
    shadowRoot: state.shadowRoot,
    workspaceRoot,
  };
}

function getWorkspaceRootForPath(filePath: string): string | null {
  for (const root of workspaceRoots) {
    if (isPathInside(filePath, root)) {
      return root;
    }
  }
  return null;
}

function isPathInside(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function overlayOpenDocumentsCached(
  workspaceRoot: string,
  shadowRoot: string,
  docVersions: Map<string, number>,
): Promise<void> {
  for (const doc of documents.values()) {
    const docPath = getDocumentFilePath(doc);
    if (!docPath || !isPathInside(docPath, workspaceRoot)) {
      continue;
    }
    const currentVersion = doc.version;
    const cachedVersion = docVersions.get(doc.uri);
    if (cachedVersion === currentVersion) {
      continue;
    }
    const relative = path.relative(workspaceRoot, docPath);
    const target = path.join(shadowRoot, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rm(target, { force: true });
    let text = doc.getText();
    if (!text.endsWith("\n\n")) {
      text = text.replace(/\n?$/, "\n\n");
    }
    await fs.promises.writeFile(target, text, "utf8");
    docVersions.set(doc.uri, currentVersion);
  }
}

async function mirrorWorkspaceUmpleFiles(
  workspaceRoot: string,
  shadowRoot: string,
): Promise<void> {
  await walkUmpleFiles(workspaceRoot, async (filePath) => {
    const relative = path.relative(workspaceRoot, filePath);
    const target = path.join(shadowRoot, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.promises.symlink(filePath, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return;
      }
      if (code === "EPERM" || code === "EACCES") {
        await fs.promises.copyFile(filePath, target);
        return;
      }
      throw error;
    }
  });
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  ".vscode",
  ".idea",
]);

async function walkUmpleFiles(
  dir: string,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkUmpleFiles(path.join(dir, entry.name), onFile);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ump")) {
      await onFile(path.join(dir, entry.name));
    }
  }
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
  const lines = document.getText().split(/\r?\n/);
  const lineText = lines[position.line] ?? "";
  const trimmed = lineText.trim();
  if (!trimmed.startsWith("use")) {
    return null;
  }
  const cleaned = lineText.split("//")[0];
  const match = cleaned.match(/\buse\s+([^;]+);/);
  if (!match) {
    return null;
  }
  const fileRef = extractUmpleFilename(match[1]);
  if (!fileRef) {
    return null;
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

function extractUmpleFilename(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.replace(/^[\"']+/, "").replace(/[\"';]+$/, "");
  const match = cleaned.match(/([A-Za-z0-9_./\\-]+\.ump)/);
  return match ? match[1] : null;
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
