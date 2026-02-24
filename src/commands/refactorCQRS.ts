import fs from "fs";
import * as path from "path";
import { Project, SourceFile } from "ts-morph";
import * as vscode from "vscode";

export async function refactorCQRSHandlerToUseCaseCommand(
  document: vscode.TextDocument,
): Promise<void> {
  try {
    const project = new Project({ useInMemoryFileSystem: true });

    const config = vscode.workspace.getConfiguration(
      "yuri.refactorCQRSHandlerToUseCase",
    );
    const resultOk = config.get<string>("resultOk", "resultOk");
    const resultFailure = config.get<string>("resultFailure", "resultFailure");
    const sourceFile = project.createSourceFile("temp.ts", document.getText(), {
      overwrite: true,
    });

    const refactoredContent = refactor(sourceFile, resultOk, resultFailure);

    if (!refactoredContent) {
      return void vscode.window.showErrorMessage(
        "No CQRS Handler found to refactor.",
      );
    }

    const originalDir = path.dirname(document.uri.fsPath);
    const originalFileName = path.basename(document.fileName, ".ts");
    const newFileName = path.join(
      originalDir,
      `${originalFileName}.refactored.ts`,
    );

    fs.writeFileSync(newFileName, refactoredContent);

    vscode.window.showInformationMessage(
      `CQRS Handler refactored to Use Case: ${originalFileName}.refactored.ts`,
    );

    const newFileUri = vscode.Uri.file(newFileName);
    const newDocument = await vscode.workspace.openTextDocument(newFileUri);
    await vscode.window.showTextDocument(newDocument);
  } catch (err) {
    vscode.window.showErrorMessage(`Error refactoring to Use Case: ${err}`);
    console.error(err);
  }
}

function refactor(
  sourceFile: SourceFile,
  resultOk: string,
  resultFailure: string,
): string | null {
  const text = sourceFile.getFullText();

  const isQueryHandler =
    text.includes("QueryHandler") && text.includes("IQueryHandler");
  const isCommandHandler =
    text.includes("CommandHandler") && text.includes("ICommandHandler");

  if (!isQueryHandler && !isCommandHandler) return null;

  let r = text;

  const importsToRemove = [
    "ICoreError",
    "IQueryHandler",
    "ICommandHandler",
    "Query",
    "Command",
    "Either",
    "failure",
    "ok",
  ];
  importsToRemove.forEach((importName) => {
    const importRegex = new RegExp(`\\b${importName}\\b(?!\\s*[,}])`, "g");
    if (!importRegex.test(text)) {
      r = r.replace(
        new RegExp(
          `import\\s+\\{[\\s\\n]*${importName}[\\s\\n]*\\}\\s+from\\s+['"][^'"]*['"][\\s\\n]*`,
          "g",
        ),
        "",
      );
      r = r.replace(
        new RegExp(
          `import\\s+\\{[\\s\\n]*(?:[^}]*?,\\s*${importName}|${importName},\\s*[^}]*)[\\s\\n]*\\}\\s+from\\s+['"][^'"]*['"][\\s\\n]*`,
          "g",
        ),
        (match: string) => {
          let cleaned = match.replace(
            new RegExp(`,\\s*${importName}|${importName}\\s*,`),
            "",
          );
          cleaned = cleaned.replace(/\s*,\s*}/g, " }");
          cleaned = cleaned.replace(/{\s*}/g, "");
          return cleaned.includes("{ }") ? "" : cleaned;
        },
      );
    }
  });

  r = r.replace(
    /import\s+\{\s*HttpStatus,\s*Inject,\s*Injectable,\s*Type\s*\}\s+from\s+['"][^'"]*['"][\s\n]*/g,
    "import { HttpStatus, Inject, Injectable } from '@nestjs/common'\n",
  );

  const importLines = r.split("\n");
  let lastImportIndex = -1;
  const newImports: string[] = [
    "import { IUseCase } from '@common/domain/usecase'",
  ];

  if (text.includes("failure(") && text.includes("ok(")) {
    newImports.push(
      `import { ${resultFailure}, ${resultOk} } from '@common/domain'`,
    );
  } else {
    if (text.includes("failure("))
      newImports.push(`import { ${resultFailure} } from '@common/domain'`);
    if (text.includes("ok("))
      newImports.push(`import { ${resultOk} } from '@common/domain'`);
  }

  for (let i = 0; i < importLines.length; i++) {
    if (
      importLines[i].trim().startsWith("import ") &&
      importLines[i].includes("from")
    ) {
      lastImportIndex = i;
    }
  }

  if (lastImportIndex >= 0 && newImports.length > 0) {
    importLines.splice(lastImportIndex + 1, 0, ...newImports);
    r = importLines.join("\n");
  }

  r = r.replace(
    /export\s+class\s+(\w+(?:Command|Query))\s+extends\s+(?:Command|Query)\s+implements\s+(\w+)\s*\{/g,
    "export class $1 implements $2 {",
  );
  r = r.replace(
    /export\s+class\s+(\w+(?:Command|Query))\s+extends\s+(?:Command|Query)\s*\{/g,
    "export class $1 {",
  );
  r = r.replace(
    /constructor\(([^)]*)\)\s*\{\s*super\([^)]*\)\s*([^}]*)\}/g,
    (_: string, params: string, body: string) => {
      const cleanedBody = body.trim() ? `\n    ${body.trim()}\n  ` : "\n  ";
      return `constructor(${params}) {${cleanedBody}}`;
    },
  );
  r = r.replace(
    /export\s+class\s+(\w+)(?:Query|Command)Handler/g,
    "export class $1UseCase",
  );
  r = r.replace(
    /implements\s+I(?:Query|Command)Handler<([^,]+),\s*([^>]+)>/g,
    "implements IUseCase<$1, $2>",
  );
  r = r.replace(
    /get\s+(?:query|command)\(\):\s*Type<(?:Query|Command)>\s*\{\s*return\s+\w+(?:Query|Command)\s*\}\s*/g,
    "",
  );
  r = r.replace(
    /async\s+execute\(([^)]*)\):\s*Promise<Either<([^,]+),\s*ICoreError>>\s*\{/g,
    (_: string, params: string, returnType: string) =>
      `async execute(${params}): Promise<${returnType}> {`,
  );

  if (text.includes("failure("))
    r = r.replace(/return\s+failure\(/g, `return ${resultFailure}(`);
  if (text.includes("ok("))
    r = r.replace(/return\s+ok\(/g, `return ${resultOk}(`);

  r = r.replace(/\n\s*\n\s*\n/g, "\n\n");
  r = r.replace(/^\s*\n/gm, "");

  return r;
}
