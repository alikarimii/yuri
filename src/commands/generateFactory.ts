import * as path from "path";
import { SyntaxKind } from "ts-morph";
import * as vscode from "vscode";
import { PropInfo } from "../types";
import { getProject, getSourceFileFromDocument } from "../utils/project";
import { defaultFor, getPropsFromDecl, getPropTypeFast } from "../utils/props";
import { findDeclNearby } from "../utils/resolve";
import { writeFileUtf8 } from "../utils/text";

// ── Generate factory from type ───────────────────────────────────────
export async function generateFactoryFromType(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("yuri.generateFactory");
    const inNewFile = cfg.get<boolean>("inNewFile", true);
    const functionPrefix = cfg.get<string>("functionPrefix", "create");
    const stripSuffixRx = new RegExp(
      cfg.get<string>("stripSuffixRegex", "(ViewModel|View|Props)$"),
    );

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
    const pickMatch =
      /Pick<\s*([A-Za-z0-9_\.]+)\s*,\s*((?:(?:['"][^'"]+['"])\s*(?:\|\s*)?)*)>/.exec(
        typeText,
      );

    function parseKeyList(raw: string) {
      return Array.from(raw.matchAll(/['"]([^'"]+)['"]/g)).map((mm) => mm[1]);
    }

    if (omitMatch || pickMatch) {
      const [_, baseTypeName, rawKeys] = (omitMatch ?? pickMatch)!;
      const keys = new Set(parseKeyList(rawKeys));

      const simpleBase = baseTypeName.split(".").pop()!;
      const baseIface = sourceFile.getInterface(simpleBase);
      const baseType = sourceFile.getTypeAlias(simpleBase);

      if (!baseIface && !baseType) {
        return void vscode.window.showErrorMessage(
          `Base ${baseTypeName} not found in this file.`,
        );
      }

      let baseProps: PropInfo[] = [];
      if (baseIface) {
        baseProps = baseIface.getProperties().map((p) => ({
          name: p.getName(),
          type: getPropTypeFast(p),
          isOptional: p.hasQuestionToken(),
        }));
      } else if (baseType) {
        baseProps = baseType
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
                type = sym.getTypeAtLocation(baseType).getText();
              } catch {
                /* keep defaults */
              }
            }
            return { name, type, isOptional };
          });
      }

      if (pickMatch) {
        properties = baseProps.filter((p) => keys.has(p.name));
        const invalid = Array.from(keys).filter(
          (k) => !baseProps.some((p) => p.name === k),
        );
        if (invalid.length) {
          return void vscode.window.showErrorMessage(
            `Invalid fields in Pick: ${invalid.join(", ")} not found in ${baseTypeName}.`,
          );
        }
      } else {
        properties = baseProps.filter((p) => !keys.has(p.name));
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

    const baseName = typeName.replace(stripSuffixRx, "");
    const factoryName = `${functionPrefix}${baseName}`;

    const lines: string[] = [];
    if (inNewFile) {
      lines.push(
        `import type { ${typeName} } from './${path.basename(document.fileName, ".ts")}';`,
      );
      lines.push("");
    }
    lines.push(
      `export function ${factoryName}(init: ${typeName}): Readonly<${typeName}> {`,
    );
    lines.push(`  return Object.freeze({`);
    for (const p of properties) {
      if (p.isOptional) {
        lines.push(`    ${p.name}: init.${p.name} ?? ${defaultFor(p.type)},`);
      } else {
        lines.push(`    ${p.name}: init.${p.name},`);
      }
    }
    lines.push(`  });`);
    lines.push(`}`);
    const fnContent = lines.join("\n") + "\n";

    if (inNewFile) {
      const dir = path.dirname(document.uri.fsPath);
      const target = vscode.Uri.file(path.join(dir, `${factoryName}.ts`));
      await writeFileUtf8(target, fnContent);
      vscode.window.showInformationMessage(
        `Factory ${factoryName} generated in ${path.basename(target.fsPath)}.`,
      );
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(document.lineCount + 1, 0),
        "\n" + fnContent,
      );
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(
        `Factory ${factoryName} generated inline.`,
      );
    }
  } catch (err) {
    console.error("generateFactoryFromType:", err);
    vscode.window.showErrorMessage(
      `Error generating factory from type: ${err}`,
    );
  }
}

// ── Generate factory from interface ──────────────────────────────────
export async function generateFactoryFromInterface(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("yuri.generateFactory");
    const inNewFile = cfg.get<boolean>("inNewFile", false);
    const functionPrefix = cfg.get<string>("functionPrefix", "create");
    const stripSuffixRx = new RegExp(
      cfg.get<string>("stripSuffixRegex", "(ViewModel|View|Props)$"),
    );

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

    let heritageKind: "pick" | "omit" | "none" = "none";
    let baseTypeName: string | null = null;
    let keyList: string[] = [];

    for (const hc of iface.getHeritageClauses()) {
      for (const tn of hc.getTypeNodes()) {
        const exprText = tn.getExpression().getText();
        if (exprText !== "Pick" && exprText !== "Omit") continue;

        const args = tn.getTypeArguments();
        if (args.length !== 2) continue;

        const base = args[0].getText().split(".").pop() ?? null;
        const keys = Array.from(
          args[1].getText().matchAll(/['"]([^'"]+)['"]/g),
        ).map((mm) => mm[1]);
        if (!base || !keys.length) continue;

        heritageKind = exprText === "Pick" ? "pick" : "omit";
        baseTypeName = base;
        keyList = keys;
        break;
      }
      if (heritageKind !== "none") break;
    }

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

    const baseName = interfaceName.replace(stripSuffixRx, "");
    const factoryName = `${functionPrefix}${baseName}`;

    const lines: string[] = [];
    if (inNewFile) {
      lines.push(
        `import type { ${interfaceName} } from './${path.basename(document.fileName, ".ts")}';`,
      );
      lines.push("");
    }
    lines.push(
      `export function ${factoryName}(init: ${interfaceName}): Readonly<${interfaceName}> {`,
    );
    lines.push(`  return Object.freeze({`);
    for (const p of properties) {
      if (p.isOptional) {
        lines.push(`    ${p.name}: init.${p.name} ?? ${defaultFor(p.type)},`);
      } else {
        lines.push(`    ${p.name}: init.${p.name},`);
      }
    }
    lines.push(`  });`);
    lines.push(`}`);
    const fnContent = lines.join("\n") + "\n";

    if (inNewFile) {
      const dir = path.dirname(document.uri.fsPath);
      const target = vscode.Uri.file(path.join(dir, `${factoryName}.ts`));
      await writeFileUtf8(target, fnContent);
      vscode.window.showInformationMessage(
        `Factory ${factoryName} generated in ${path.basename(target.fsPath)}.`,
      );
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(document.lineCount + 1, 0),
        "\n" + fnContent,
      );
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(
        `Factory ${factoryName} generated inline.`,
      );
    }
  } catch (err) {
    console.error("generateFactoryFromInterface:", err);
    vscode.window.showErrorMessage(
      `Error generating factory from interface: ${err}`,
    );
  }
}
