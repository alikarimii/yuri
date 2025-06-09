import { Project } from "ts-morph";
import * as vscode from "vscode";
const path = require("path");
const fs = require("fs");

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "yuri" is now active!');

  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    { language: "typescript", scheme: "file" },
    new YuriCodeActionProvider(),
    {
      providedCodeActionKinds: YuriCodeActionProvider.providedCodeActionKinds,
    }
  );
  context.subscriptions.push(codeActionProvider);

  const generateClassCommand = vscode.commands.registerCommand(
    "yuri.generateClassFromInterface",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const config = vscode.workspace.getConfiguration("yuri.generateClass");
        const inNewFile = config.get<boolean>("inNewFile", true);
        const classNameSuffix = config.get<string>("classNameSuffix", "Impl");

        const project = new Project({
          useInMemoryFileSystem: true,
        });

        const sourceFile = project.createSourceFile(
          "temp.ts",
          document.getText(),
          { overwrite: true }
        );

        const interfaceNameMatch = document
          .lineAt(range.start.line)
          .text.match(/interface\s+(\w+)/);
        if (!interfaceNameMatch) {
          vscode.window.showErrorMessage("Could not determine interface name.");
          return;
        }

        const interfaceName = interfaceNameMatch[1];
        const iface = sourceFile.getInterface(interfaceName);
        if (!iface) {
          vscode.window.showErrorMessage(
            `Interface ${interfaceName} not found.`
          );
          return;
        }

        let className = interfaceName;
        if (className.endsWith("ViewModel")) {
          className = className.replace(/ViewModel$/, "");
        }
        className += classNameSuffix;

        const properties = iface.getProperties().map((prop) => {
          const name = prop.getName();
          const type = prop.getType().getText();
          const isReadonly = prop.hasModifier("readonly");
          const isOptional = prop.hasQuestionToken();

          return { name, type, isReadonly, isOptional };
        });

        let classContent = `import { ${interfaceName} } from './${path.basename(
          document.fileName,
          ".ts"
        )}'\n\n`;

        classContent += `export class ${className} implements ${interfaceName} {\n`;

        for (const prop of properties) {
          classContent += `  ${prop.isReadonly ? "readonly " : ""}${prop.name}${
            prop.isOptional ? "?" : ""
          }: ${prop.type}\n`;
        }

        classContent += `\n  constructor(init: ${interfaceName}) {\n`;

        for (const prop of properties) {
          if (prop.isOptional) {
            const fallback = getDefaultValueForType(prop.type);
            classContent += `    this.${prop.name} = init.${prop.name} ?? ${fallback}\n`;
          } else {
            classContent += `    this.${prop.name} = init.${prop.name}\n`;
          }
        }

        classContent += `  }\n`;

        classContent += `}\n`;

        if (inNewFile) {
          const originalDir = path.dirname(document.uri.fsPath);
          const newFileName = path.join(originalDir, `${className}.ts`);
          fs.writeFileSync(newFileName, classContent);
          vscode.window.showInformationMessage(
            `Class ${className} generated in new file: ${className}.ts`
          );
        } else {
          const edit = new vscode.WorkspaceEdit();
          const position = new vscode.Position(document.lineCount + 1, 0);
          edit.insert(document.uri, position, classContent);
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Class ${className} generated inline.`
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Error generating class: ${err}`);
        console.error(err);
      }
    }
  );

  context.subscriptions.push(generateClassCommand);
}

class YuriCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] | undefined {
    const lineText = document.lineAt(range.start.line).text;

    if (!lineText.includes("interface ")) {
      return;
    }

    const fix = new vscode.CodeAction(
      "Generate Class from Interface (Yuri)",
      vscode.CodeActionKind.QuickFix
    );
    fix.command = {
      title: "Generate Class",
      command: "yuri.generateClassFromInterface",
      arguments: [document, range],
    };
    return [fix];
  }
}

export function deactivate() {}

function getDefaultValueForType(type: string): string {
  if (type === "string") {
    return `''`;
  }
  if (type === "number") {
    return `0`;
  }
  if (type === "boolean") {
    return `false`;
  }
  if (type.endsWith("[]")) {
    return `[]`;
  }
  return "undefined";
}
