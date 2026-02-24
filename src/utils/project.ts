import fs from "fs";
import * as path from "path";
import { Project, QuoteKind, SourceFile } from "ts-morph";
import * as vscode from "vscode";

let _project: Project | undefined;
const _sfCache = new Map<string, { version: number; sf: SourceFile }>();

function findNearestTsconfig(startFilePath: string): string | null {
  let dir =
    fs.existsSync(startFilePath) && fs.statSync(startFilePath).isDirectory()
      ? startFilePath
      : path.dirname(startFilePath);

  for (;;) {
    const tsconfig = path.join(dir, "tsconfig.json");
    if (fs.existsSync(tsconfig)) return tsconfig;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function invalidateProject(): void {
  _project = undefined;
  _sfCache.clear();
}

export function getProject(forFile?: string): Project {
  if (_project) return _project;

  const tsconfig = forFile ? findNearestTsconfig(forFile) : null;

  if (tsconfig) {
    _project = new Project({
      tsConfigFilePath: tsconfig,
      manipulationSettings: { quoteKind: QuoteKind.Single },
      skipFileDependencyResolution: false,
    });

    try {
      if (
        _project.getSourceFiles().length === 0 &&
        typeof (_project as any).addSourceFilesFromTsConfig === "function"
      ) {
        (_project as any).addSourceFilesFromTsConfig(tsconfig);
      }
    } catch {
      /* ignore */
    }
  } else {
    _project = new Project({
      manipulationSettings: { quoteKind: QuoteKind.Single },
      skipFileDependencyResolution: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { skipLibCheck: true, strict: false },
    });

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      _project.addSourceFilesAtPaths(
        path.join(f.uri.fsPath, "**/*.{ts,tsx,d.ts}"),
      );
    }
  }

  return _project!;
}

export function getSourceFileFromDocument(
  doc: vscode.TextDocument,
): SourceFile {
  const fsPath = doc.uri.fsPath;
  const cached = _sfCache.get(fsPath);
  if (cached && cached.version === doc.version) return cached.sf;

  const project = getProject(fsPath);

  let sf = project.getSourceFile(fsPath);
  if (!sf) {
    if (fs.existsSync(fsPath)) sf = project.addSourceFileAtPath(fsPath);
    else
      sf = project.createSourceFile(fsPath, doc.getText(), { overwrite: true });
  } else {
    sf.replaceWithText(doc.getText());
  }

  _sfCache.set(fsPath, { version: doc.version, sf });
  return sf;
}
