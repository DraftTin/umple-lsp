import { execFile, ExecFileException } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const execFileAsync = promisify(execFile);
const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();

let umpleJarPath: string | undefined;
let jarWarningShown = false;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initOptions = params.initializationOptions as
    | { umpleJarPath?: string }
    | undefined;
  umpleJarPath = initOptions?.umpleJarPath || process.env.UMPLE_JAR;

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  };
});

connection.onInitialized(() => {
  connection.console.info("Umple language server initialized.");
});

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
  const updated = TextDocument.update(document, params.contentChanges, params.textDocument.version);
  console.log("Document updated:", params.textDocument.uri);
  documents.set(params.textDocument.uri, updated);
  scheduleValidation(updated);
});

connection.onDidCloseTextDocument((params) => {
  documents.delete(params.textDocument.uri);
  connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
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

  const diagnostics = await runUmpleAndParseDiagnostics(jarPath, document.getText());
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

function resolveJarPath(): string | undefined {
  if (!umpleJarPath) {
    if (!jarWarningShown) {
      connection.window.showWarningMessage(
        "Umple jar path not set. Configure initializationOptions.umpleJarPath or UMPLE_JAR.",
      );
      jarWarningShown = true;
    }
    return undefined;
  }

  if (!fs.existsSync(umpleJarPath)) {
    if (!jarWarningShown) {
      connection.window.showWarningMessage(
        `Umple jar not found at ${umpleJarPath}. Update the path or UMPLE_JAR.`,
      );
      jarWarningShown = true;
    }
    return undefined;
  }

  return umpleJarPath;
}

async function runUmpleAndParseDiagnostics(
  jarPath: string,
  content: string,
): Promise<Diagnostic[]> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "umple-lsp-"));
  const tempFile = path.join(tempDir, "document.ump");
  await fs.promises.writeFile(tempFile, content, "utf8");

  let stdout = "";
  let stderr = "";

  try {
    const result = await execFileAsync("java", ["-jar", jarPath, "-c-", tempFile], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error) {
    const execError = error as ExecFileException & { stdout?: string; stderr?: string };
    stdout = execError.stdout ?? "";
    stderr = execError.stderr ?? "";
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  return parseUmpleDiagnostics(stderr, stdout);
}

function parseUmpleDiagnostics(stderr: string, stdout: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stderr.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const javaMatch = line.match(/^(.*\.ump):(\d+):\s*(warning|error):\s*(.*)$/i);
    if (javaMatch) {
      const lineNumber = Math.max(Number(javaMatch[2]) - 1, 0);
      diagnostics.push({
        severity: javaMatch[3].toLowerCase() === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Error,
        range: {
          start: { line: lineNumber, character: 0 },
          end: { line: lineNumber, character: 1 },
        },
        message: javaMatch[4].trim(),
        source: "umple",
      });
      continue;
    }

    if (line.startsWith("Error") || line.startsWith("Warning")) {
      const isWarning = line.startsWith("Warning");
      const meta = line.split(" ");
      const lineIndex = meta.indexOf("line");
      const lineNumber = lineIndex >= 0 ? Number(meta[lineIndex + 1]) : 1;
      const message = (lines[i + 1] ?? line).trim();

      diagnostics.push({
        severity: isWarning ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
        range: {
          start: { line: Math.max(lineNumber - 1, 0), character: 0 },
          end: { line: Math.max(lineNumber - 1, 0), character: 1 },
        },
        message,
        source: "umple",
      });

      if (lines[i + 1]) {
        i += 1;
      }
    }
  }

  if (diagnostics.length === 0 && stdout.includes("Success")) {
    connection.console.info("Umple compile succeeded.");
  }

  return diagnostics;
}

connection.listen();
