import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

// Start the client with server side attached
export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(
    path.join("server", "out", "server.js"),
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "umple" }],
    initializationOptions: {
      umpleSyncJarPath: context.asAbsolutePath("umplesync.jar"),
      umpleSyncPort: 5556,
      umpleJarPath: context.asAbsolutePath("umple.jar"),
      umpleGoToDefClasspath: context.asAbsolutePath("java-tools"),
    },
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.ump"),
    },
  };

  client = new LanguageClient(
    "umpleLanguageServer",
    "Umple Language Server",
    serverOptions,
    clientOptions,
  );

  client.start();
  // context.subscriptions.push();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }

  return client.stop();
}
