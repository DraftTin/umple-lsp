import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
  Position,
  Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();

let umpleSyncJarPath: string | undefined;
let umpleSyncHost = "localhost";
let umpleSyncPort = 5555;
let jarWarningShown = false;
let serverProcess: ChildProcess | undefined;

const KEYWORD_COMPLETIONS: CompletionItem[] = [
  { label: "class", kind: CompletionItemKind.Keyword },
  { label: "trait", kind: CompletionItemKind.Keyword },
  { label: "association", kind: CompletionItemKind.Keyword },
  { label: "enum", kind: CompletionItemKind.Keyword },
  { label: "namespace", kind: CompletionItemKind.Keyword },
  { label: "statemachine", kind: CompletionItemKind.Keyword },
  { label: "event", kind: CompletionItemKind.Keyword },
  { label: "attribute", kind: CompletionItemKind.Keyword },
  { label: "use", kind: CompletionItemKind.Keyword },
  { label: "generate", kind: CompletionItemKind.Keyword },
  { label: "extends", kind: CompletionItemKind.Keyword },
  { label: "implements", kind: CompletionItemKind.Keyword },
  { label: "abstract", kind: CompletionItemKind.Keyword },
];

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initOptions = params.initializationOptions as
    | {
        umpleSyncJarPath?: string;
        umpleSyncHost?: string;
        umpleSyncPort?: number;
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

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [" ", "."],
      },
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
  scheduleValidation(updated);
});

connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});

connection.onCompletion((params): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return KEYWORD_COMPLETIONS;
  }

  const prefix = getCompletionPrefix(
    document,
    params.position.line,
    params.position.character,
  );
  const keywordItems = filterCompletions(KEYWORD_COMPLETIONS, prefix);
  const classItems = getClassNameCompletions(prefix);
  return [...keywordItems, ...classItems];
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

  const diagnostics = await runUmpleSyncAndParseDiagnostics(jarPath, document);
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
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
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "umple-lsp-"),
  );
  const tempFile = path.join(tempDir, "document.ump");
  let text = document.getText();
  // If the error is at the last line, it needs to add newlines to let compiler recognize its position correctly
  text += "\n\n";
  await fs.promises.writeFile(tempFile, text, "utf8");

  try {
    const commandLine = `-generate nothing ${tempFile}`;
    const { stdout, stderr } = await sendUmpleSyncCommand(jarPath, commandLine);
    return parseUmpleDiagnostics(stderr, stdout, document);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
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

    socket.setEncoding("utf8");
    socket.setTimeout(2000);

    socket.on("data", (chunk) => {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      } else {
        chunks.push(chunk.toString("utf8"));
      }
    });

    socket.on("end", () => {
      const raw = chunks.join("");
      const { stdout, stderr } = splitUmpleSyncOutput(raw);
      resolve({ stdout, stderr });
    });

    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on("timeout", () => {
      socket.destroy(new Error("umplesync socket timeout"));
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

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as { code?: string };
  return (
    maybeError.code === "ECONNREFUSED" ||
    maybeError.code === "ECONNRESET" ||
    maybeError.code === "EPIPE"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

connection.listen();
