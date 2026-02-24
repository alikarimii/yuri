import * as path from "path";
import {
  ClassDeclaration,
  InterfaceDeclaration,
  SourceFile,
  TypeAliasDeclaration,
} from "ts-morph";
import * as vscode from "vscode";
import { getProject } from "./project";

export async function fileExists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

export async function ensureFileLoaded(fsPath: string): Promise<SourceFile> {
  const project = getProject();
  const existing = project.getSourceFile(fsPath);
  if (existing) return existing;
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath));
  const text = Buffer.from(data).toString("utf8");
  return project.createSourceFile(fsPath, text, { overwrite: true });
}

export async function resolveModuleToFsPath(
  fromFsPath: string,
  moduleSpecifier: string,
): Promise<string | null> {
  const base = path.dirname(fromFsPath);
  const candidates = [
    path.resolve(base, `${moduleSpecifier}.ts`),
    path.resolve(base, `${moduleSpecifier}.tsx`),
    path.resolve(base, `${moduleSpecifier}.d.ts`),
    path.resolve(base, moduleSpecifier, "index.ts"),
    path.resolve(base, moduleSpecifier, "index.tsx"),
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

export async function findDeclNearby(
  name: string,
  fromFsPath: string,
  currentSf: SourceFile,
): Promise<InterfaceDeclaration | TypeAliasDeclaration | undefined> {
  const simple = name.split(".").pop()!;

  let idecl = currentSf.getInterface(simple);
  if (idecl) return idecl;
  let tdecl = currentSf.getTypeAlias(simple);
  if (tdecl) return tdecl;

  for (const imp of currentSf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;
    const fsPath = await resolveModuleToFsPath(fromFsPath, spec);
    if (!fsPath) continue;
    const sf = await ensureFileLoaded(fsPath);
    idecl = sf.getInterface(simple);
    if (idecl) return idecl;
    tdecl = sf.getTypeAlias(simple);
    if (tdecl) return tdecl;
  }

  const dir = path.dirname(fromFsPath);
  for (const ext of [".ts", ".tsx", ".d.ts"]) {
    const guess = path.join(dir, `${simple}${ext}`);
    if (await fileExists(guess)) {
      const sf = await ensureFileLoaded(guess);
      idecl = sf.getInterface(simple);
      if (idecl) return idecl;
      tdecl = sf.getTypeAlias(simple);
      if (tdecl) return tdecl;
    }
  }
  return undefined;
}

export async function findInterfaceNearby(
  name: string,
  fromFsPath: string,
  currentSf: SourceFile,
): Promise<InterfaceDeclaration | undefined> {
  for (const imp of currentSf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;
    const fsPath = await resolveModuleToFsPath(fromFsPath, spec);
    if (!fsPath) continue;
    const sf = await ensureFileLoaded(fsPath);
    const found = sf.getInterface(name);
    if (found) return found;
  }
  const guess = path.join(path.dirname(fromFsPath), `${name}.ts`);
  if (await fileExists(guess)) {
    const sf = await ensureFileLoaded(guess);
    const found = sf.getInterface(name);
    if (found) return found;
  }
  return undefined;
}

export async function findClassNearby(
  name: string,
  fromFsPath: string,
  currentSf: SourceFile,
): Promise<ClassDeclaration | undefined> {
  let c = currentSf.getClass(name);
  if (c) return c;

  for (const imp of currentSf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;
    const fsPath = await resolveModuleToFsPath(fromFsPath, spec);
    if (!fsPath) continue;
    const sf = await ensureFileLoaded(fsPath);
    c = sf.getClass(name);
    if (c) return c;
  }

  const guess = path.join(path.dirname(fromFsPath), `${name}.ts`);
  if (await fileExists(guess)) {
    const sf = await ensureFileLoaded(guess);
    c = sf.getClass(name);
    if (c) return c;
  }
  return undefined;
}

export async function findInterfaceOrTypeNearby(
  name: string,
  fromFsPath: string,
  currentSf: SourceFile,
): Promise<InterfaceDeclaration | TypeAliasDeclaration | undefined> {
  const simple = name.split(".").pop()!;
  let d = currentSf.getInterface(simple) || currentSf.getTypeAlias(simple);
  if (d) return d;

  for (const imp of currentSf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;
    const fsPath = await resolveModuleToFsPath(fromFsPath, spec);
    if (!fsPath) continue;
    const sf = await ensureFileLoaded(fsPath);
    d = sf.getInterface(simple) || sf.getTypeAlias(simple);
    if (d) return d;
  }

  const guess = path.join(path.dirname(fromFsPath), `${simple}.ts`);
  if (await fileExists(guess)) {
    const sf = await ensureFileLoaded(guess);
    d = sf.getInterface(simple) || sf.getTypeAlias(simple);
    if (d) return d;
  }
  return undefined;
}
