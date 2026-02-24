import * as path from "path";
import { SyntaxKind } from "ts-morph";
import * as vscode from "vscode";
import { PropInfo } from "../types";
import { getProject, getSourceFileFromDocument } from "../utils/project";
import {
  defaultFor,
  extractStringLiteralKeys,
  getBaseNameFromTypeArg,
  getPropsFromDecl,
  getPropTypeFast,
} from "../utils/props";
import { findDeclNearby } from "../utils/resolve";
import { writeFileUtf8 } from "../utils/text";

// ── Generate class from interface ────────────────────────────────────
export async function generateClassFromInterface(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration("yuri.generateClass");
    const inNewFile = config.get<boolean>("inNewFile", true);
    const classNameSuffix = config.get<string>("classNameSuffix", "Impl");

    getProject();
    const sourceFile = getSourceFileFromDocument(document);

    const line = document.lineAt(range.start.line).text;
    const m = line.match(/interface\s+(\w+)/);
    if (!m) {
      return void vscode.window.showErrorMessage(
        "Could not determine interface name.",
      );
    }
    const interfaceName = m[1];

    const iface = sourceFile.getInterface(interfaceName);
    if (!iface) {
      return void vscode.window.showErrorMessage(
        `Interface ${interfaceName} not found in this file.`,
      );
    }

    // Heritage detection: Pick<> OR Omit<> via AST
    let heritageKind: "pick" | "omit" | "none" = "none";
    let baseTypeName: string | null = null;
    let keyList: string[] = [];

    for (const hc of iface.getHeritageClauses()) {
      for (const tn of hc.getTypeNodes()) {
        const exprText = tn.getExpression().getText();
        if (exprText !== "Pick" && exprText !== "Omit") continue;

        const args = tn.getTypeArguments();
        if (args.length !== 2) continue;

        const base = getBaseNameFromTypeArg(args[0]);
        const keys = extractStringLiteralKeys(args[1]);
        if (!base || !keys.length) continue;

        heritageKind = exprText === "Pick" ? "pick" : "omit";
        baseTypeName = base;
        keyList = keys;
        break;
      }
      if (heritageKind !== "none") break;
    }

    // Collect properties
    let properties: PropInfo[] = [];

    if (heritageKind !== "none" && baseTypeName) {
      const baseDecl = await findDeclNearby(
        baseTypeName,
        document.uri.fsPath,
        sourceFile,
      );
      if (!baseDecl) {
        return void vscode.window.showErrorMessage(
          `Base type ${baseTypeName} not found nearby.`,
        );
      }

      const baseProps = getPropsFromDecl(baseDecl);

      if (heritageKind === "pick") {
        const pickSet = new Set(keyList);
        properties = baseProps.filter((p) => pickSet.has(p.name));
        const invalid = keyList.filter(
          (k) => !baseProps.some((p) => p.name === k),
        );
        if (invalid.length) {
          return void vscode.window.showErrorMessage(
            `Invalid fields in Pick: ${invalid.join(", ")} not found in ${baseTypeName}.`,
          );
        }
      } else {
        const omitSet = new Set(keyList);
        const afterOmit = baseProps.filter((p) => !omitSet.has(p.name));
        const ownProps = iface.getProperties().map((p) => ({
          name: p.getName(),
          type: getPropTypeFast(p),
          isOptional: p.hasQuestionToken(),
        }));
        const map = new Map(afterOmit.map((p) => [p.name, p]));
        for (const op of ownProps) map.set(op.name, op);
        properties = Array.from(map.values());
      }
    } else {
      properties = iface.getProperties().map((p) => ({
        name: p.getName(),
        type: getPropTypeFast(p),
        isOptional: p.hasQuestionToken(),
      }));
    }

    if (!properties.length) {
      return void vscode.window.showErrorMessage(
        `No properties found in interface ${interfaceName}.`,
      );
    }

    let className = interfaceName.endsWith("ViewModel")
      ? interfaceName.replace(/ViewModel$/, "")
      : interfaceName;
    className += classNameSuffix;

    const lines: string[] = [];
    if (inNewFile) {
      lines.push(
        `import { ${interfaceName} } from './${path.basename(document.fileName, ".ts")}'`,
      );
      lines.push("");
    }
    lines.push(`export class ${className} implements ${interfaceName} {`);
    for (const p of properties) {
      lines.push(`  readonly ${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
    }
    lines.push("");
    lines.push(`  constructor(init: ${interfaceName}) {`);
    for (const p of properties) {
      if (p.isOptional) {
        lines.push(
          `    this.${p.name} = init.${p.name} ?? ${defaultFor(p.type)}`,
        );
      } else {
        lines.push(`    this.${p.name} = init.${p.name}`);
      }
    }
    lines.push(`  }`);
    lines.push(`}`);
    const classContent = lines.join("\n") + "\n";

    if (inNewFile) {
      const dir = path.dirname(document.uri.fsPath);
      const target = vscode.Uri.file(path.join(dir, `${className}.ts`));
      await writeFileUtf8(target, classContent);
      vscode.window.showInformationMessage(
        `Class ${className} generated in new file: ${className}.ts`,
      );
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(document.lineCount + 1, 0),
        "\n" + classContent,
      );
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(
        `Class ${className} generated inline.`,
      );
    }
  } catch (err) {
    console.error("generateClassFromInterface:", err);
    vscode.window.showErrorMessage(
      `Error generating class from interface: ${err}`,
    );
  }
}

// ── Generate class from type ─────────────────────────────────────────
export async function generateClassFromType(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("yuri.generateClass");
    const inNewFile = cfg.get<boolean>("inNewFile", true);
    const classNameSuffix = cfg.get<string>("classNameSuffix", "Impl");
    const includeGetters = cfg.get<boolean>("includeGetters", false);

    getProject();
    const sourceFile = getSourceFileFromDocument(document);

    const m = document.lineAt(range.start.line).text.match(/type\s+(\w+)/);
    if (!m) {
      return void vscode.window.showErrorMessage(
        "Could not determine type name.",
      );
    }
    const typeName = m[1];

    const typeAlias = sourceFile.getTypeAlias(typeName);
    if (!typeAlias) {
      return void vscode.window.showErrorMessage(
        `Type ${typeName} not found in this file.`,
      );
    }

    let properties: PropInfo[] = [];

    const typeNode = typeAlias.getTypeNode();
    const typeText = typeNode?.getText() ?? "";

    const omitMatch =
      /Omit<\s*([A-Za-z0-9_\.]+)\s*,\s*((?:(?:['"][^'"]+['"])\s*(?:\|\s*)?)*)>/.exec(
        typeText,
      );
    if (omitMatch) {
      const baseTypeName = omitMatch[1];
      const omitted = new Set(
        Array.from(omitMatch[2].matchAll(/['"]([^'"]+)['"]/g)).map(
          (mm) => mm[1],
        ),
      );

      const baseIface = sourceFile.getInterface(baseTypeName.split(".").pop()!);
      const baseTypeAlias = sourceFile.getTypeAlias(
        baseTypeName.split(".").pop()!,
      );

      if (!baseIface && !baseTypeAlias) {
        return void vscode.window.showErrorMessage(
          `Base type/interface ${baseTypeName} not found in this file.`,
        );
      }

      if (baseIface) {
        properties = baseIface
          .getProperties()
          .filter((p) => !omitted.has(p.getName()))
          .map((p) => ({
            name: p.getName(),
            type: getPropTypeFast(p),
            isOptional: p.hasQuestionToken(),
          }));
      } else if (baseTypeAlias) {
        properties = baseTypeAlias
          .getType()
          .getProperties()
          .map((sym) => {
            const decl = sym.getDeclarations()?.[0];
            const name = sym.getName();
            let type = "any";
            let isOptional = false;
            if (decl && decl.isKind(SyntaxKind.PropertySignature)) {
              type = getPropTypeFast(decl);
              isOptional = decl.hasQuestionToken();
            } else {
              try {
                type = sym.getTypeAtLocation(baseTypeAlias).getText();
              } catch {
                /* keep defaults */
              }
            }
            return { name, type, isOptional };
          })
          .filter((p) => !omitted.has(p.name));
      }
    } else {
      properties = typeAlias
        .getType()
        .getProperties()
        .map((sym) => {
          const decl = sym.getDeclarations()?.[0];
          const name = sym.getName();
          if (decl && decl.isKind(SyntaxKind.PropertySignature)) {
            return {
              name,
              type: getPropTypeFast(decl),
              isOptional: decl.hasQuestionToken(),
            };
          }
          let t = "any";
          try {
            t = sym.getTypeAtLocation(typeAlias).getText();
          } catch {
            /* keep defaults */
          }
          return { name, type: t, isOptional: false };
        });
    }

    if (!properties.length) {
      return void vscode.window.showErrorMessage(
        `No properties found in type ${typeName}.`,
      );
    }

    let className = typeName.endsWith("ViewModel")
      ? typeName.replace(/ViewModel$/, "")
      : typeName;
    className += classNameSuffix;

    const lines: string[] = [];
    lines.push(`export class ${className} implements ${typeName} {`);
    for (const p of properties) {
      lines.push(`  readonly ${p.name}${p.isOptional ? "?" : ""}: ${p.type}`);
    }
    lines.push("");
    lines.push(`  constructor(init: ${typeName}) {`);
    for (const p of properties) {
      if (p.isOptional) {
        lines.push(
          `    this.${p.name} = init.${p.name} ?? ${defaultFor(p.type)}`,
        );
      } else {
        lines.push(`    this.${p.name} = init.${p.name}`);
      }
    }
    lines.push(`  }`);

    if (includeGetters) {
      for (const p of properties) {
        const g = p.name.charAt(0).toUpperCase() + p.name.slice(1);
        lines.push("");
        lines.push(`  public get${g}(): ${p.type} {`);
        lines.push(`    return this.${p.name};`);
        lines.push(`  }`);
      }
    }

    lines.push(`}`);
    const classContent = lines.join("\n") + "\n";

    if (inNewFile) {
      const dir = path.dirname(document.uri.fsPath);
      const target = vscode.Uri.file(path.join(dir, `${className}.ts`));
      await writeFileUtf8(target, classContent);
      vscode.window.showInformationMessage(
        `Class ${className} generated in ${path.basename(target.fsPath)}.`,
      );
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(document.lineCount + 1, 0),
        "\n" + classContent,
      );
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(
        `Class ${className} generated inline.`,
      );
    }
  } catch (err) {
    console.error("generateClassFromType:", err);
    vscode.window.showErrorMessage(`Error generating class from type: ${err}`);
  }
}
