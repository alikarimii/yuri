import fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export async function createIndex(uri: vscode.Uri): Promise<void> {
  const folderPath = uri.fsPath;

  const files = fs
    .readdirSync(folderPath)
    .filter(
      (file: string) =>
        file !== "index.ts" && file.endsWith(".ts") && !file.endsWith(".d.ts"),
    );

  const exportLines = files.map((file: string) => {
    const baseName = path.basename(file, ".ts");
    return `export * from './${baseName}'`;
  });

  const indexPath = path.join(folderPath, "index.ts");
  fs.writeFileSync(indexPath, exportLines.join("\n") + "\n");

  vscode.window.showInformationMessage(
    `index.ts created with ${files.length} exports`,
  );
}
