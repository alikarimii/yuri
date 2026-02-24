import * as vscode from "vscode";

export async function writeFileUtf8(
  uri: vscode.Uri,
  text: string,
): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export async function insertInlineOrNewFile(opts: {
  document: vscode.TextDocument;
  inNewFile: boolean;
  content: string;
  newFileName: string;
  importLine?: string;
}): Promise<void> {
  if (opts.inNewFile) {
    const fullContent = opts.importLine
      ? opts.importLine + "\n\n" + opts.content
      : opts.content;
    const dir = require("path").dirname(opts.document.uri.fsPath);
    const target = vscode.Uri.file(require("path").join(dir, opts.newFileName));
    await writeFileUtf8(target, fullContent);
  } else {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      opts.document.uri,
      new vscode.Position(opts.document.lineCount + 1, 0),
      "\n" + opts.content,
    );
    await vscode.workspace.applyEdit(edit);
  }
}
