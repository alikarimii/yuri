import { Project, SyntaxKind } from "ts-morph";
import * as vscode from "vscode";
import { getSourceFileFromDocument } from "../utils/project";
import { getPropTypeFast, getWantedPropsFromParamType } from "../utils/props";
import { findClassNearby, findInterfaceNearby } from "../utils/resolve";

// ── Add readonly to class properties ─────────────────────────────────
export async function addReadonlyToClassProps(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("temp.ts", document.getText(), {
      overwrite: true,
    });

    const classDeclaration = sourceFile.getClasses().find((cls: any) => {
      const start = cls.getStart();
      const end = cls.getEnd();
      const classRange = new vscode.Range(
        document.positionAt(start),
        document.positionAt(end),
      );
      return classRange.contains(range.start);
    });

    if (!classDeclaration) {
      return void vscode.window.showErrorMessage(
        "No class found at the cursor position.",
      );
    }

    const className = classDeclaration.getName();
    classDeclaration.getProperties().forEach((prop: any) => {
      if (!prop.hasModifier("readonly")) prop.addModifier("readonly");
    });

    const updatedText = sourceFile.getFullText();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      updatedText,
    );
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage(
      `Added readonly to properties of class ${className}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error adding readonly to class properties: ${err}`,
    );
    console.error(err);
  }
}

// ── Add getters to class properties ──────────────────────────────────
export async function addGettersToClassProps(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("temp.ts", document.getText(), {
      overwrite: true,
    });

    const classDeclaration = sourceFile.getClasses().find((cls: any) => {
      const start = cls.getStart();
      const end = cls.getEnd();
      const classRange = new vscode.Range(
        document.positionAt(start),
        document.positionAt(end),
      );
      return classRange.contains(range.start);
    });

    if (!classDeclaration) {
      return void vscode.window.showErrorMessage(
        "No class found at the cursor position.",
      );
    }

    const className = classDeclaration.getName();
    const extendsClause = classDeclaration
      .getHeritageClauses()
      .find((h) => h.getToken() === SyntaxKind.ExtendsKeyword);
    const extendsText = extendsClause?.getText() ?? "";
    const isAggregate = extendsText.includes("Aggregate<");

    if (!isAggregate) {
      return void vscode.window.showErrorMessage(
        `${extendsText} => Class ${className} does not extend Aggregate with props type.`,
      );
    }

    const propsTypeName = extendsText.match(/Aggregate<(\w+)>/)?.[1];
    if (!propsTypeName) {
      return void vscode.window.showErrorMessage(
        `Could not determine props type for Aggregate in class ${className}.`,
      );
    }

    const propsType = sourceFile.getTypeAlias(propsTypeName);
    if (!propsType) {
      return void vscode.window.showErrorMessage(
        `Type ${propsTypeName} not found in the file.`,
      );
    }

    const props = propsType
      .getType()
      .getProperties()
      .map((prop: any) => {
        const name = prop.getName();
        const type = prop.getValueDeclaration()?.getType()?.getText() || "any";
        return { name, type };
      });

    let gettersContent =
      "/////////////////////////// getter ///////////////////////////\n";
    for (const prop of props) {
      if (prop.name === "id") continue;
      gettersContent += `  get ${prop.name}(): ${prop.type} {\n`;
      gettersContent += `    return this.props.${prop.name}\n`;
      gettersContent += `  }\n`;
    }

    const classEnd = classDeclaration.getEnd();
    const insertPosition = document.positionAt(classEnd - 1);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, insertPosition, gettersContent);
    await vscode.workspace.applyEdit(edit);

    vscode.window.showInformationMessage(`Added getters to class ${className}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Error adding getters to class: ${err}`);
    console.error(err);
  }
}

// ── Add missing constructor properties ───────────────────────────────
export async function addMissingConstructorProps(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const sourceFile = getSourceFileFromDocument(document);

    const offset = document.offsetAt(range.start);
    const nodeAt = sourceFile.getDescendantAtPos(offset);
    if (!nodeAt) {
      return void vscode.window.showErrorMessage("No node found at cursor.");
    }

    const newExpr =
      nodeAt.getFirstAncestorByKind(SyntaxKind.NewExpression) ??
      nodeAt.asKind(SyntaxKind.NewExpression);
    if (!newExpr) {
      return void vscode.window.showErrorMessage(
        "Cursor is not inside a 'new Class(...)' expression.",
      );
    }

    const className = newExpr.getExpression().getText();
    const arg0 = newExpr.getArguments()[0];
    if (!arg0 || !arg0.isKind(SyntaxKind.ObjectLiteralExpression)) {
      return void vscode.window.showErrorMessage(
        "Expected object literal as first constructor argument.",
      );
    }
    const argObj = arg0.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

    const cls = await findClassNearby(
      className,
      document.uri.fsPath,
      sourceFile,
    );
    if (!cls) {
      return void vscode.window.showErrorMessage(
        `Class ${className} not found nearby.`,
      );
    }

    const ctor = cls.getConstructors()[0];
    if (!ctor) {
      return void vscode.window.showErrorMessage(
        `Class ${className} has no constructor.`,
      );
    }

    const param = ctor.getParameters()[0];
    if (!param) {
      return void vscode.window.showErrorMessage(
        `Constructor of ${className} has no parameters.`,
      );
    }

    const wantedProps = await getWantedPropsFromParamType(
      param,
      document.uri.fsPath,
      sourceFile,
    );
    if (!wantedProps.length) {
      return void vscode.window.showInformationMessage(
        "No constructor properties detected.",
      );
    }

    const existingNames = new Set(
      argObj
        .getProperties()
        .map((p) =>
          p.isKind(SyntaxKind.PropertyAssignment) ||
          p.isKind(SyntaxKind.ShorthandPropertyAssignment)
            ? p.getName()
            : "",
        )
        .filter(Boolean),
    );
    const missing = wantedProps
      .map((p) => p.name)
      .filter((n) => !existingNames.has(n));
    if (!missing.length) {
      return void vscode.window.showInformationMessage(
        "No missing properties to add.",
      );
    }

    const indent = computeIndent(document, argObj);
    const valueTemplate = vscode.workspace
      .getConfiguration("yuri.addMissingConstructorProps")
      .get<string>("valueTemplate", "entity.${name}");

    const lines = missing.map(
      (name) => `${indent}${name}: ${valueTemplate.replace("${name}", name)},`,
    );
    let insertText = "\n" + lines.join("\n") + "\n";

    if (argObj.getProperties().length > 0) {
      const objText = argObj.getText();
      const beforeClose = objText.replace(/\s+}$/, "}").slice(0, -1).trimEnd();
      const hasTrailingComma = beforeClose.endsWith(",");
      if (!hasTrailingComma) insertText = "," + insertText;
    }

    const insertPos = document.positionAt(argObj.getEnd() - 1);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, insertPos, insertText);
    await vscode.workspace.applyEdit(edit);

    vscode.window.showInformationMessage(
      `Added missing properties: ${missing.join(", ")}`,
    );
  } catch (err) {
    console.error("addMissingConstructorProps:", err);
    vscode.window.showErrorMessage(`Error adding missing properties: ${err}`);
  }
}

function computeIndent(
  doc: vscode.TextDocument,
  obj: import("ts-morph").ObjectLiteralExpression,
): string {
  const startPos = doc.positionAt(obj.getStart());
  const lineText = doc.lineAt(startPos.line).text;
  const base = lineText.match(/^\s*/)?.[0] ?? "";
  return base + "  ";
}

// ── Sync class with interface ────────────────────────────────────────
export async function syncClassWithInterfaceProps(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<void> {
  try {
    const sourceFile = getSourceFileFromDocument(document);

    const offset = document.offsetAt(range.start);
    const classDecl = sourceFile.getClasses().find((cls) => {
      const start = cls.getStart();
      const end = cls.getEnd();
      return offset >= start && offset <= end;
    });
    if (!classDecl) {
      return void vscode.window.showErrorMessage("No class found at cursor.");
    }

    const impl = classDecl.getImplements()[0];
    if (!impl) {
      return void vscode.window.showErrorMessage(
        "Class does not implement an interface.",
      );
    }
    const implText = impl.getText();
    const interfaceName = (impl.getExpression()?.getText() ?? implText).replace(
      /<.*$/,
      "",
    );
    if (!interfaceName) {
      return void vscode.window.showErrorMessage(
        "Could not resolve implemented interface name.",
      );
    }

    let iface = sourceFile.getInterface(interfaceName);
    if (!iface) {
      iface = await findInterfaceNearby(
        interfaceName,
        document.uri.fsPath,
        sourceFile,
      );
    }
    if (!iface) {
      return void vscode.window.showErrorMessage(
        `Interface ${interfaceName} not found nearby.`,
      );
    }

    const ifaceProps = iface.getProperties().map((p) => ({
      name: p.getName(),
      type: getPropTypeFast(p),
    }));

    const classPropNames = new Set(
      classDecl.getProperties().map((p) => p.getName()),
    );
    let ctor = classDecl.getConstructors()[0];
    let ctorParamName = "props";
    if (ctor) {
      const param = ctor.getParameters()[0];
      if (param) ctorParamName = param.getName();
    }

    const missingDecls = ifaceProps.filter((p) => !classPropNames.has(p.name));
    const ctorBodyText = ctor?.getBodyText() ?? "";
    const missingAssignments = ifaceProps.filter(
      (p) => !new RegExp(`\\bthis\\.${p.name}\\b`).test(ctorBodyText),
    );

    if (missingDecls.length === 0 && missingAssignments.length === 0 && ctor) {
      return void vscode.window.showInformationMessage(
        "No missing properties or constructor assignments found.",
      );
    }

    const edit = new vscode.WorkspaceEdit();

    if (missingDecls.length) {
      const openBrace = classDecl.getFirstChildByKind(
        SyntaxKind.OpenBraceToken,
      );
      if (openBrace) {
        const insertPos = document.positionAt(openBrace.getEnd() + 1);
        const declText =
          "\n" +
          missingDecls
            .map((p) => `  readonly ${p.name}: ${p.type}\n`)
            .join("") +
          "\n";
        edit.insert(document.uri, insertPos, declText);
      }
    }

    if (!ctor) {
      const beforeCloseBrace = classDecl.getLastChildByKind(
        SyntaxKind.CloseBraceToken,
      );
      if (!beforeCloseBrace) {
        return void vscode.window.showErrorMessage(
          "Could not locate class body for constructor insertion.",
        );
      }
      const insertCtorPos = document.positionAt(beforeCloseBrace.getStart());
      const ctorText =
        `\n  constructor(${ctorParamName}: ${interfaceName}) {\n` + `  }\n`;
      edit.insert(document.uri, insertCtorPos, ctorText);
    }

    const ctorNow = classDecl.getConstructors()[0] || ctor;
    let ctorInsertPos: vscode.Position | null = null;
    if (ctorNow && ctorNow.getBody()) {
      const bodyEnd = ctorNow.getBody()!.getEnd();
      ctorInsertPos = document.positionAt(bodyEnd - 1);
    } else {
      const closeBrace = classDecl.getLastChildByKind(
        SyntaxKind.CloseBraceToken,
      );
      if (closeBrace) {
        ctorInsertPos = document.positionAt(closeBrace.getStart());
      }
    }

    if (missingAssignments.length && ctorInsertPos) {
      const assignText =
        "\n" +
        missingAssignments
          .map((p) => `    this.${p.name} = ${ctorParamName}.${p.name}`)
          .join("\n") +
        "\n";
      edit.insert(document.uri, ctorInsertPos, assignText);
    }

    await vscode.workspace.applyEdit(edit);

    vscode.window.showInformationMessage(
      `Added ${missingDecls.length} property(ies) and ${missingAssignments.length} constructor assignment(s).`,
    );
  } catch (err) {
    console.error("syncClassWithInterface:", err);
    vscode.window.showErrorMessage(
      `Error syncing class with interface: ${err}`,
    );
  }
}
