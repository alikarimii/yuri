import * as path from "path";
import {
  ArrayLiteralExpression,
  Node,
  PropertyAssignment,
  Symbol,
  SyntaxKind,
  Type,
} from "ts-morph";
import * as vscode from "vscode";
import { ValidationMode } from "../types";
import { getProject, getSourceFileFromDocument } from "../utils/project";
import { normalizePrimitives } from "../utils/props";
import { writeFileUtf8 } from "../utils/text";

type Split = {
  top: Set<string>;
  nested: Map<string, Set<string>>;
  exclusions: Map<string, Set<string>>;
  optionalTop: Set<string>;
  optionalNested: Map<string, Set<string>>;
};

function splitFields(fields: string[]): Split {
  const top = new Set<string>();
  const nested = new Map<string, Set<string>>();
  const exclusions = new Map<string, Set<string>>();
  const optionalTop = new Set<string>();
  const optionalNested = new Map<string, Set<string>>();

  const addNested = (parent: string, child: string) => {
    if (!nested.has(parent)) nested.set(parent, new Set());
    nested.get(parent)!.add(child);
  };
  const addOptionalNested = (parent: string, child: string) => {
    if (!optionalNested.has(parent)) optionalNested.set(parent, new Set());
    optionalNested.get(parent)!.add(child);
  };

  for (const f of fields) {
    // Exclusion syntax: "author.!privacy"
    const exclusionMatch = f.match(/^(\w+)\.\!(\w+)$/);
    if (exclusionMatch) {
      const [, parent, excludedField] = exclusionMatch;
      top.add(parent);
      if (!exclusions.has(parent)) exclusions.set(parent, new Set());
      exclusions.get(parent)!.add(excludedField);
      continue;
    }

    // Optional top-level: "?title"
    const optionalTopMatch = f.match(/^\?(\w+)$/);
    if (optionalTopMatch) {
      const name = optionalTopMatch[1];
      top.add(name);
      optionalTop.add(name);
      continue;
    }

    // Optional nested: "author.?id"
    const optionalNestedMatch = f.match(/^(\w+)\.\?(\w+)$/);
    if (optionalNestedMatch) {
      const [, parent, child] = optionalNestedMatch;
      addNested(parent, child);
      addOptionalNested(parent, child);
      continue;
    }

    // Regular fields
    const parts = f.split(".");
    if (parts.length === 1) {
      top.add(parts[0]);
    } else if (parts.length >= 2) {
      addNested(parts[0], parts[1]);
    }
  }

  // Prefer nested over top (unless exclusion)
  for (const parent of nested.keys()) {
    if (!exclusions.has(parent)) top.delete(parent);
  }

  return { top, nested, exclusions, optionalTop, optionalNested };
}

function getArrayElementTypeIfArray(t: Type): {
  isArray: boolean;
  elem: Type;
} {
  const nn = t.getNonNullableType();
  if (nn.isArray()) {
    const elem = nn.getArrayElementType();
    if (elem) return { isArray: true, elem };
  }
  const typeArgs = nn.getTypeArguments?.() ?? [];
  const symName = nn.getSymbol()?.getName?.();
  if (
    (symName === "Array" || symName === "ReadonlyArray") &&
    typeArgs.length === 1
  ) {
    return { isArray: true, elem: typeArgs[0] };
  }
  return { isArray: false, elem: nn };
}

export async function generateViewInterfaces(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration(
      "yuri.generateViewInterfaces",
    );
    const inNewFile = config.get<boolean>("inNewFile", true);
    const validationMode = config.get<ValidationMode>(
      "validationMode",
      "partial",
    );
    const iSuffix = config.get<string>("interfaceSuffix", "");

    getProject(document.fileName);
    const sourceFile = getSourceFileFromDocument(document);

    const m = document.lineAt(range.start.line).text.match(/interface\s+(\w+)/);
    if (!m) {
      return void vscode.window.showErrorMessage(
        "Could not determine interface name.",
      );
    }
    const interfaceName = m[1];
    const noUnderscoreInterfaceName = interfaceName.startsWith("_")
      ? interfaceName.slice(1)
      : interfaceName;

    const iface = sourceFile.getInterface(interfaceName);
    if (!iface) {
      return void vscode.window.showErrorMessage(
        `Interface ${interfaceName} not found in this file.`,
      );
    }

    const viewSchemasVar = sourceFile.getVariableDeclaration("_viewSchemas");
    if (!viewSchemasVar) {
      return void vscode.window.showErrorMessage(
        `No '_viewSchemas' variable found in the file.`,
      );
    }

    const init = viewSchemasVar.getInitializer();
    if (!init || !init.isKind(SyntaxKind.ObjectLiteralExpression)) {
      return void vscode.window.showErrorMessage(
        `'_viewSchemas' must be initialized with an object literal.`,
      );
    }
    const obj = init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

    const ifacePropNames = new Set(
      iface.getProperties().map((p) => p.getName()),
    );

    const out: string[] = [];
    if (inNewFile) {
      out.push(
        `import { ${interfaceName} } from './${path.basename(document.fileName, ".ts")}'`,
        "",
      );
    }

    const toTitle = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const getPropName = (prop: PropertyAssignment): string => {
      const raw = prop.getNameNode().getText();
      return raw.replace(/^['"`]|['"`]$/g, "");
    };
    const extractStringFields = (arr: ArrayLiteralExpression): string[] =>
      arr.getElements().flatMap((el) => {
        if (Node.isStringLiteral(el)) return [el.getLiteralText()];
        if (Node.isNoSubstitutionTemplateLiteral(el))
          return [el.getLiteralText()];
        return [];
      });

    const getTopPropTypeText = (name: string): string | null => {
      const p = iface.getProperty(name);
      if (!p) return null;
      const tn = p.getTypeNode();
      if (tn) return tn.getText();
      return p.getType().getNonNullableType().getText(p);
    };

    const getChildPropTypeText = (
      parent: string,
      child: string,
    ): { isArray: boolean; typeText: string } | null => {
      const parentSig = iface.getProperty(parent);
      if (!parentSig) return null;
      const { isArray, elem } = getArrayElementTypeIfArray(parentSig.getType());
      const childSym = elem.getProperty(child);
      if (!childSym) return null;
      const childDecl = childSym.getDeclarations()?.[0] ?? iface;
      const childTypeText = childSym
        .getTypeAtLocation(childDecl)
        .getNonNullableType()
        .getText(childDecl);
      return { isArray, typeText: childTypeText };
    };

    let generated = 0;
    const warnings: string[] = [];

    for (const prop of obj.getProperties()) {
      if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
      const viewName = getPropName(prop);
      const arrInit = prop.getInitializer();
      if (!arrInit || !arrInit.isKind(SyntaxKind.ArrayLiteralExpression))
        continue;
      const fields = extractStringFields(arrInit);
      if (!fields.length) continue;

      const { top, nested, exclusions, optionalTop, optionalNested } =
        splitFields(fields);

      // ── validation ──
      const invalidTop = [...top].filter((f) => !ifacePropNames.has(f));
      const invalidNestedParents = [...nested.keys()].filter(
        (p) => !ifacePropNames.has(p),
      );
      const invalidNestedChildren: string[] = [];
      const invalidExclusions: string[] = [];

      for (const [parent, excludedFields] of exclusions) {
        if (!ifacePropNames.has(parent)) {
          invalidExclusions.push(
            ...[...excludedFields].map((f) => `${parent}.!${f}`),
          );
          continue;
        }
        if (validationMode === "strict" || validationMode === "partial") {
          const parentSig = iface.getProperty(parent);
          const parentType = parentSig ? parentSig.getType() : undefined;
          const childNames = parentType
            ? new Set(
                parentType.getProperties().map((s: Symbol) => s.getName()),
              )
            : null;
          if (childNames) {
            for (const ef of excludedFields) {
              if (!childNames.has(ef))
                invalidExclusions.push(`${parent}.!${ef}`);
            }
          }
        }
      }

      for (const [parent, childs] of nested) {
        if (invalidNestedParents.includes(parent)) continue;
        const parentSig = iface.getProperty(parent);
        const { elem } = parentSig
          ? getArrayElementTypeIfArray(parentSig.getType())
          : { elem: undefined as any };
        const childNames = elem
          ? new Set(elem.getProperties().map((s: Symbol) => s.getName()))
          : null;
        if (!childNames) continue;
        for (const c of childs) {
          if (!childNames.has(c)) invalidNestedChildren.push(`${parent}.${c}`);
        }
      }

      const invalid = [
        ...invalidTop,
        ...invalidNestedParents,
        ...invalidNestedChildren,
        ...invalidExclusions,
      ];

      let finalTop = [...top];
      let finalNested = new Map(nested);
      let finalExclusions = new Map(exclusions);
      let finalOptionalTop = new Set(optionalTop);
      let finalOptionalNested = new Map(optionalNested);

      if (validationMode === "strict") {
        if (invalid.length) {
          warnings.push(
            `Skipped '${viewName}': invalid fields: ${invalid.join(", ")}`,
          );
          continue;
        }
      } else if (validationMode === "partial") {
        finalTop = finalTop.filter((f) => ifacePropNames.has(f));
        finalOptionalTop = new Set(
          [...finalOptionalTop].filter((f) => ifacePropNames.has(f)),
        );
        for (const p of [...finalNested.keys()]) {
          if (!ifacePropNames.has(p)) finalNested.delete(p);
        }
        for (const p of [...finalOptionalNested.keys()]) {
          if (!ifacePropNames.has(p)) finalOptionalNested.delete(p);
        }
        for (const p of [...finalExclusions.keys()]) {
          if (!ifacePropNames.has(p)) finalExclusions.delete(p);
        }
        if (!finalTop.length && !finalNested.size && !finalExclusions.size) {
          warnings.push(`Skipped '${viewName}': no valid fields.`);
          continue;
        }
        if (invalid.length) {
          warnings.push(
            `Partially generated '${viewName}': ignored invalid fields: ${invalid.join(", ")}`,
          );
        }
      } else {
        // loose
        finalTop = finalTop.filter((f) => ifacePropNames.has(f));
        finalOptionalTop = new Set(
          [...finalOptionalTop].filter((f) => ifacePropNames.has(f)),
        );
        for (const p of [...finalNested.keys()]) {
          if (!ifacePropNames.has(p)) finalNested.delete(p);
        }
        for (const p of [...finalOptionalNested.keys()]) {
          if (!ifacePropNames.has(p)) finalOptionalNested.delete(p);
        }
        for (const p of [...finalExclusions.keys()]) {
          if (!ifacePropNames.has(p)) finalExclusions.delete(p);
        }
        if (invalid.length) {
          warnings.push(
            `Loosely generated '${viewName}': interface does not contain: ${invalid.join(", ")}`,
          );
        }
      }

      // ── emit ──
      const typeName = `${
        noUnderscoreInterfaceName === toTitle(viewName)
          ? ""
          : noUnderscoreInterfaceName
      }${toTitle(viewName)}${iSuffix}`;

      const lines: string[] = [];

      // Top-level fields
      for (const name of finalTop) {
        const tt = getTopPropTypeText(name);
        if (!tt) continue;
        const excludedFields = finalExclusions.get(name);
        if (excludedFields) {
          const parentSig = iface.getProperty(name);
          if (!parentSig) continue;
          const parentType = parentSig.getType().getNonNullableType();
          const { isArray, elem } = getArrayElementTypeIfArray(parentType);
          const childProps = elem.getProperties();
          const childLines: string[] = [];
          const optionalChildSet =
            finalOptionalNested.get(name) ?? new Set<string>();
          for (const childProp of childProps) {
            const childName = childProp.getName();
            if (excludedFields.has(childName)) continue;
            const childTypeText = childProp
              .getTypeAtLocation(parentSig)
              .getNonNullableType()
              .getText(parentSig);
            childLines.push(
              `${childName}${optionalChildSet.has(childName) ? "?" : ""}: ${normalizePrimitives(childTypeText)}`,
            );
          }
          if (!childLines.length) continue;
          const objStr = `{ ${childLines.join("; ")} }`;
          lines.push(
            isArray
              ? ` ${name}${finalOptionalTop.has(name) ? "?" : ""}: Array<${objStr}>;`
              : ` ${name}${finalOptionalTop.has(name) ? "?" : ""}: ${objStr};`,
          );
        } else {
          lines.push(
            ` ${name}${finalOptionalTop.has(name) ? "?" : ""}: ${normalizePrimitives(tt)};`,
          );
        }
      }

      // Nested fields
      for (const [parent, childs] of finalNested) {
        const pieces: string[] = [];
        let isArrayParent: boolean | null = null;
        const optionalChildSet =
          finalOptionalNested.get(parent) ?? new Set<string>();
        for (const child of childs) {
          const info = getChildPropTypeText(parent, child);
          if (!info) continue;
          if (isArrayParent == null) isArrayParent = info.isArray;
          if (isArrayParent !== info.isArray) isArrayParent = false;
          pieces.push(
            `${child}${optionalChildSet.has(child) ? "?" : ""}: ${normalizePrimitives(info.typeText)}`,
          );
        }
        if (!pieces.length) continue;
        const objStr = `{ ${pieces.join("; ")} }`;
        lines.push(
          isArrayParent
            ? ` ${parent}${finalOptionalTop.has(parent) ? "?" : ""}: Array<${objStr}>;`
            : ` ${parent}${finalOptionalTop.has(parent) ? "?" : ""}: ${objStr};`,
        );
      }

      if (!lines.length) continue;
      out.push(`export interface ${typeName} {\n${lines.join("\n")}\n}`);
      generated++;
    }

    if (!generated) {
      return void vscode.window.showErrorMessage(
        `No view interfaces generated from '_viewSchemas'.` +
          (warnings.length ? ` Details: ${warnings.join(" | ")}` : ""),
      );
    }

    const content = out.join("\n") + "\n";

    if (inNewFile) {
      const dir = path.dirname(document.uri.fsPath);
      const target = vscode.Uri.file(
        path.join(dir, `${interfaceName}Views.ts`),
      );
      await writeFileUtf8(target, content);
      vscode.window.showInformationMessage(
        `Generated ${generated} interfaces in ${path.basename(target.fsPath)}.` +
          (warnings.length ? ` Warnings: ${warnings.join(" | ")}` : ""),
      );
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        document.uri,
        new vscode.Position(document.lineCount + 1, 0),
        "\n" + content,
      );
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(
        `Generated ${generated} interfaces inline.` +
          (warnings.length ? ` Warnings: ${warnings.join(" | ")}` : ""),
      );
    }
  } catch (err) {
    console.error("generateViewInterfaces:", err);
    vscode.window.showErrorMessage(`Error generating view interfaces: ${err}`);
  }
}
