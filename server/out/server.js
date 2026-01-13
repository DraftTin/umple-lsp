"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const util_1 = require("util");
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new Map();
const pendingValidations = new Map();
let umpleJarPath;
let jarWarningShown = false;
connection.onInitialize((params) => {
    const initOptions = params.initializationOptions;
    umpleJarPath = initOptions?.umpleJarPath || process.env.UMPLE_JAR;
    return {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
        },
    };
});
connection.onInitialized(() => {
    connection.console.info("Umple language server initialized.");
});
connection.onDidOpenTextDocument((params) => {
    const document = vscode_languageserver_textdocument_1.TextDocument.create(params.textDocument.uri, params.textDocument.languageId, params.textDocument.version, params.textDocument.text);
    documents.set(params.textDocument.uri, document);
    scheduleValidation(document);
});
connection.onDidChangeTextDocument((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return;
    }
    const updated = vscode_languageserver_textdocument_1.TextDocument.update(document, params.contentChanges, params.textDocument.version);
    console.log("Document updated:", params.textDocument.uri);
    documents.set(params.textDocument.uri, updated);
    scheduleValidation(updated);
});
connection.onDidCloseTextDocument((params) => {
    documents.delete(params.textDocument.uri);
    connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics: [] });
});
function scheduleValidation(document) {
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
async function validateTextDocument(document) {
    const jarPath = resolveJarPath();
    if (!jarPath) {
        return;
    }
    const diagnostics = await runUmpleAndParseDiagnostics(jarPath, document.getText());
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
}
function resolveJarPath() {
    if (!umpleJarPath) {
        if (!jarWarningShown) {
            connection.window.showWarningMessage("Umple jar path not set. Configure initializationOptions.umpleJarPath or UMPLE_JAR.");
            jarWarningShown = true;
        }
        return undefined;
    }
    if (!fs.existsSync(umpleJarPath)) {
        if (!jarWarningShown) {
            connection.window.showWarningMessage(`Umple jar not found at ${umpleJarPath}. Update the path or UMPLE_JAR.`);
            jarWarningShown = true;
        }
        return undefined;
    }
    return umpleJarPath;
}
async function runUmpleAndParseDiagnostics(jarPath, content) {
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
    }
    catch (error) {
        const execError = error;
        stdout = execError.stdout ?? "";
        stderr = execError.stderr ?? "";
    }
    finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
    return parseUmpleDiagnostics(stderr, stdout);
}
function parseUmpleDiagnostics(stderr, stdout) {
    const diagnostics = [];
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
                    ? node_1.DiagnosticSeverity.Warning
                    : node_1.DiagnosticSeverity.Error,
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
                severity: isWarning ? node_1.DiagnosticSeverity.Warning : node_1.DiagnosticSeverity.Error,
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
//# sourceMappingURL=server.js.map