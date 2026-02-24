import * as vscode from "vscode";
import { YuriCodeActionProvider } from "./codeActions";
import { invalidateProject } from "./utils/project";

// ── Commands ─────────────────────────────────────────────────────────
import {
  addGettersToClassProps,
  addMissingConstructorProps,
  addReadonlyToClassProps,
  syncClassWithInterfaceProps,
} from "./commands/classEdits";
import { createIndex } from "./commands/createIndex";
import {
  generateClassFromInterface,
  generateClassFromType,
} from "./commands/generateClass";
import {
  generateFactoryFromInterface,
  generateFactoryFromType,
} from "./commands/generateFactory";
import { generateViewInterfaces } from "./commands/generateViewInterfaces";

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "yuri" is now active!');

  // Invalidate ts-morph project cache when workspace files change
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx}");
  watcher.onDidCreate(() => invalidateProject());
  watcher.onDidDelete(() => invalidateProject());
  watcher.onDidChange(() => invalidateProject());
  context.subscriptions.push(watcher);

  // Code action provider (lightweight — no ts-morph on every cursor move)
  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    { language: "typescript", scheme: "file" },
    new YuriCodeActionProvider(),
    { providedCodeActionKinds: YuriCodeActionProvider.providedCodeActionKinds },
  );
  context.subscriptions.push(codeActionProvider);

  // ── Register all commands ────────────────────────────────────────
  const commands: [string, (...args: any[]) => any][] = [
    ["extension.createIndex", createIndex],
    ["yuri.generateClassFromInterface", generateClassFromInterface],
    ["yuri.generateClassFromType", generateClassFromType],
    ["yuri.generateFactoryFromType", generateFactoryFromType],
    ["yuri.generateFactoryFromInterface", generateFactoryFromInterface],
    ["yuri.generateViewInterfaces", generateViewInterfaces],
    ["yuri.addReadonlyToClassProps", addReadonlyToClassProps],
    ["yuri.addGettersToClassProps", addGettersToClassProps],
    ["yuri.addMissingConstructorProps", addMissingConstructorProps],
    ["yuri.syncClassWithInterfaceProps", syncClassWithInterfaceProps],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

export function deactivate() {}
