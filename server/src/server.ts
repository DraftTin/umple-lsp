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
import { ALL_KEYWORDS, KEYWORDS } from "./keywords";

const connection = createConnection(ProposedFeatures.all);
const documents = new Map<string, TextDocument>();
const pendingValidations = new Map<string, NodeJS.Timeout>();
const modelCache = new Map<
  string,
  { version: number; items: CompletionItem[] }
>();

let umpleSyncJarPath: string | undefined;
let umpleSyncHost = "localhost";
let umpleSyncPort = 5555;
let jarWarningShown = false;
let serverProcess: ChildProcess | undefined;

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
  const classItems = getClassNameCompletions(prefix);
  return dedupeCompletions([
    ...keywordItems,
    ...filterCompletions(modelItems, prefix),
    ...classItems,
  ]);
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
  // Umple needs two trailing newlines to report end-of-file errors on the last line.
  if (!text.endsWith("\n\n")) {
    text = text.replace(/\n?$/, "\n\n");
  }
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

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "umple-lsp-model-"),
  );
  const tempFile = path.join(tempDir, "document.ump");
  let text = document.getText();
  if (!text.endsWith("\n\n")) {
    text = text.replace(/\n?$/, "\n\n");
  }
  await fs.promises.writeFile(tempFile, text, "utf8");

  try {
    const commandLine = `-generate JsonMixed ${tempFile}`;
    const { stdout } = await sendUmpleSyncCommand(jarPath, commandLine);
    const jsonText = extractJson(stdout);
    if (!jsonText) {
      return null;
    }
    return JSON.parse(jsonText);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
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

connection.listen();
