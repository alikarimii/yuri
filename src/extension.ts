import fs from "fs";
import * as path from "path";
import {
  ArrayLiteralExpression,
  InterfaceDeclaration,
  LiteralTypeNode,
  Node,
  Project,
  PropertyAssignment,
  PropertySignature,
  QuoteKind,
  SourceFile,
  StringLiteral,
  Symbol,
  SyntaxKind,
  Type,
  TypeAliasDeclaration,
  TypeNode,
  TypeReferenceNode,
  UnionTypeNode,
} from "ts-morph";
import * as vscode from "vscode";

type ValidationMode = "strict" | "partial" | "loose";
// --- shared project + cache ---
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

export function getProject(forFile?: string): Project {
  if (_project) return _project;

  const tsconfig = forFile ? findNearestTsconfig(forFile) : null;

  if (tsconfig) {
    _project = new Project({
      tsConfigFilePath: tsconfig,
      manipulationSettings: { quoteKind: QuoteKind.Single },
      // important: allow dependency resolution
      skipFileDependencyResolution: false,
      // DO NOT pass addFilesFromTsConfig (not present in some versions)
      // DO NOT pass skipAddingFilesFromTsConfig (defaults are fine)
    });

    // Some ts-morph versions don’t auto-add files; add them explicitly if needed.
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
    // Fallback project (no tsconfig found): allow resolution and add workspace files by glob.
    _project = new Project({
      manipulationSettings: { quoteKind: QuoteKind.Single },
      skipFileDependencyResolution: false,
      // this option exists on most versions; if your version complains, just remove it
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { skipLibCheck: true, strict: false },
    });

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      _project.addSourceFilesAtPaths(
        path.join(f.uri.fsPath, "**/*.{ts,tsx,d.ts}")
      );
    }
  }

  return _project!;
}

export function getSourceFileFromDocument(
  doc: vscode.TextDocument
): SourceFile {
  const fsPath = doc.uri.fsPath;
  const key = fsPath;
  const cached = _sfCache.get(key);
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

  _sfCache.set(key, { version: doc.version, sf });
  return sf;
}

export async function writeFileUtf8(uri: vscode.Uri, text: string) {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export function getPropTypeFast(p: PropertySignature, fallback = "any") {
  const tn = p.getTypeNode();
  if (tn) return tn.getText();
  try {
    return p.getType().getText(p);
  } catch {
    return fallback;
  }
}

function defaultFor(typeText: string) {
  if (/\[\]$/.test(typeText)) return `[]`;
  if (/\bboolean\b/.test(typeText)) return `false`;
  if (/\bnumber\b/.test(typeText)) return `0`;
  if (/\bstring\b/.test(typeText)) return `''`;
  return "undefined";
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "yuri" is now active!');

  const disposable = vscode.commands.registerCommand(
    "extension.createIndex",
    async (uri: vscode.Uri) => {
      const folderPath = uri.fsPath;

      const files = fs
        .readdirSync(folderPath)
        .filter(
          (file: string) =>
            file !== "index.ts" &&
            file.endsWith(".ts") &&
            !file.endsWith(".d.ts")
        );

      const exportLines = files.map((file: string) => {
        const baseName = path.basename(file, ".ts");
        return `export * from './${baseName}'`;
      });

      const indexPath = path.join(folderPath, "index.ts");
      fs.writeFileSync(indexPath, exportLines.join("\n") + "\n");

      vscode.window.showInformationMessage(
        `index.ts created with ${files.length} exports`
      );
    }
  );

  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    { language: "typescript", scheme: "file" },
    new YuriCodeActionProvider(),
    { providedCodeActionKinds: YuriCodeActionProvider.providedCodeActionKinds }
  );
  context.subscriptions.push(codeActionProvider);

  // ---------------- generate class from interface (AST-first: Pick/Omit + alias base) ----------------
  const generateClassCommand = vscode.commands.registerCommand(
    "yuri.generateClassFromInterface",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const config = vscode.workspace.getConfiguration("yuri.generateClass");
        const inNewFile = config.get<boolean>("inNewFile", true);
        const classNameSuffix = config.get<string>("classNameSuffix", "Impl");

        const project = getProject();
        const sourceFile = getSourceFileFromDocument(document);

        // 1) Get interface name from the current line (cheap)
        const line = document.lineAt(range.start.line).text;
        const m = line.match(/interface\s+(\w+)/);
        if (!m) {
          return vscode.window.showErrorMessage(
            "Could not determine interface name."
          );
        }
        const interfaceName = m[1];

        // 2) Find the interface in the current file
        const iface = sourceFile.getInterface(interfaceName);
        if (!iface) {
          return vscode.window.showErrorMessage(
            `Interface ${interfaceName} not found in this file.`
          );
        }

        // 3) Heritage detection: Pick<> OR Omit<> via AST
        type PropInfo = { name: string; type: string; isOptional: boolean };
        type HeritageKind = "pick" | "omit" | "none";
        let heritageKind: HeritageKind = "none";
        let baseTypeName: string | null = null; // may be qualified ("ns.Base")
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

        // 4) Resolve base declaration nearby (interface OR type alias)
        async function tryFindDeclNearby(
          name: string
        ): Promise<InterfaceDeclaration | TypeAliasDeclaration | undefined> {
          const simple = name.split(".").pop()!;

          // same file
          let idecl = sourceFile.getInterface(simple);
          if (idecl) return idecl;
          let tdecl = sourceFile.getTypeAlias(simple);
          if (tdecl) return tdecl;

          // relative imports (once)
          for (const imp of sourceFile.getImportDeclarations()) {
            const spec = imp.getModuleSpecifierValue();
            if (!spec.startsWith(".")) continue;
            const fsPath = await resolveModuleToFsPath(
              document.uri.fsPath,
              spec
            );
            if (!fsPath) continue;

            const sf = await ensureFileLoaded(fsPath);
            idecl = sf.getInterface(simple);
            if (idecl) return idecl;
            tdecl = sf.getTypeAlias(simple);
            if (tdecl) return tdecl;
          }

          // same-dir probe
          const dir = path.dirname(document.uri.fsPath);
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

        // Helpers used above
        async function ensureFileLoaded(fsPath: string) {
          const existing = project.getSourceFile(fsPath);
          if (existing) return existing;
          const data = await vscode.workspace.fs.readFile(
            vscode.Uri.file(fsPath)
          );
          const text = Buffer.from(data).toString("utf8");
          return project.createSourceFile(fsPath, text, { overwrite: true });
        }
        async function fileExists(fsPath: string) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
            return true;
          } catch {
            return false;
          }
        }
        async function resolveModuleToFsPath(
          fromFsPath: string,
          moduleSpecifier: string
        ) {
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

        // 5) Collect properties
        let properties: PropInfo[] = [];

        if (heritageKind !== "none" && baseTypeName) {
          const baseDecl = await tryFindDeclNearby(baseTypeName);
          if (!baseDecl) {
            return vscode.window.showErrorMessage(
              `Base type ${baseTypeName} not found nearby (skipping full-project scan for speed).`
            );
          }

          const baseProps = getPropsFromDecl(baseDecl);

          if (heritageKind === "pick") {
            const pickSet = new Set(keyList);
            properties = baseProps.filter((p) => pickSet.has(p.name));

            // Validate (warn if keys not in base)
            const invalid = keyList.filter(
              (k) => !baseProps.some((p) => p.name === k)
            );
            if (invalid.length) {
              return vscode.window.showErrorMessage(
                `Invalid fields in Pick: ${invalid.join(
                  ", "
                )} not found in ${baseTypeName}.`
              );
            }
          } else {
            // Omit
            const omitSet = new Set(keyList);
            const afterOmit = baseProps.filter((p) => !omitSet.has(p.name));

            // Merge overrides/additions from child interface
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
          // Plain interface
          properties = iface.getProperties().map((p) => ({
            name: p.getName(),
            type: getPropTypeFast(p),
            isOptional: p.hasQuestionToken(),
          }));
        }

        if (!properties.length) {
          return vscode.window.showErrorMessage(
            `No properties found in interface ${interfaceName}.`
          );
        }

        // 6) Compute class name
        let className = interfaceName.endsWith("ViewModel")
          ? interfaceName.replace(/ViewModel$/, "")
          : interfaceName;
        className += classNameSuffix;

        // 7) Generate class text
        const lines: string[] = [];
        if (inNewFile) {
          lines.push(
            `import { ${interfaceName} } from './${path.basename(
              document.fileName,
              ".ts"
            )}'`
          );
          lines.push("");
        }
        lines.push(`export class ${className} implements ${interfaceName} {`);
        for (const p of properties) {
          lines.push(
            `  readonly ${p.name}${p.isOptional ? "?" : ""}: ${p.type}`
          );
        }
        lines.push("");
        lines.push(`  constructor(init: ${interfaceName}) {`);
        for (const p of properties) {
          if (p.isOptional) {
            lines.push(
              `    this.${p.name} = init.${p.name} ?? ${defaultFor(p.type)}`
            );
          } else {
            lines.push(`    this.${p.name} = init.${p.name}`);
          }
        }
        lines.push(`  }`);
        lines.push(`}`);
        const classContent = lines.join("\n") + "\n";

        // 8) Write async (no blocking)
        if (inNewFile) {
          const originalDir = path.dirname(document.uri.fsPath);
          const target = vscode.Uri.file(
            path.join(originalDir, `${className}.ts`)
          );
          await writeFileUtf8(target, classContent);
          vscode.window.showInformationMessage(
            `Class ${className} generated in new file: ${className}.ts`
          );
        } else {
          const edit = new vscode.WorkspaceEdit();
          const position = new vscode.Position(document.lineCount + 1, 0);
          edit.insert(document.uri, position, "\n" + classContent);
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Class ${className} generated inline.`
          );
        }
      } catch (err) {
        console.error("generateClassFromInterface (ast-first):", err);
        vscode.window.showErrorMessage(
          `Error generating class from interface: ${err}`
        );
      }
    }
  );

  // custom for our project
  const refactorToUseCaseCommand = vscode.commands.registerCommand(
    "yuri.refactorCQRSHandlerToUseCase",
    async (document: vscode.TextDocument) => {
      try {
        const project = new Project({ useInMemoryFileSystem: true });

        const config = vscode.workspace.getConfiguration(
          "yuri.refactorCQRSHandlerToUseCase"
        );
        const resultOk = config.get<string>("resultOk", "resultOk");
        const resultFailure = config.get<string>(
          "resultFailure",
          "resultFailure"
        );
        const sourceFile = project.createSourceFile(
          "temp.ts",
          document.getText(),
          { overwrite: true }
        );

        const refactoredContent = refactorCQRSHandlerToUseCase(
          sourceFile,
          resultOk,
          resultFailure
        );

        if (!refactoredContent) {
          vscode.window.showErrorMessage("No CQRS Handler found to refactor.");
          return;
        }

        const originalDir = path.dirname(document.uri.fsPath);
        const originalFileName = path.basename(document.fileName, ".ts");
        const newFileName = path.join(
          originalDir,
          `${originalFileName}.refactored.ts`
        );

        fs.writeFileSync(newFileName, refactoredContent);

        vscode.window.showInformationMessage(
          `CQRS Handler refactored to Use Case: ${originalFileName}.refactored.ts`
        );

        const newFileUri = vscode.Uri.file(newFileName);
        const newDocument = await vscode.workspace.openTextDocument(newFileUri);
        await vscode.window.showTextDocument(newDocument);
      } catch (err) {
        vscode.window.showErrorMessage(`Error refactoring to Use Case: ${err}`);
        console.error(err);
      }
    }
  );

  const addReadonlyToClassPropsCommand = vscode.commands.registerCommand(
    "yuri.addReadonlyToClassProps",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
          "temp.ts",
          document.getText(),
          { overwrite: true }
        );

        const classDeclaration = sourceFile.getClasses().find((cls: any) => {
          const start = cls.getStart();
          const end = cls.getEnd();
          const classRange = new vscode.Range(
            document.positionAt(start),
            document.positionAt(end)
          );
          return classRange.contains(range.start);
        });

        if (!classDeclaration) {
          vscode.window.showErrorMessage(
            "No class found at the cursor position."
          );
          return;
        }

        const className = classDeclaration.getName();
        const properties = classDeclaration.getProperties();
        properties.forEach((prop: any) => {
          if (!prop.hasModifier("readonly")) {
            prop.addModifier("readonly");
          }
        });

        const updatedText = sourceFile.getFullText();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          ),
          updatedText
        );
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(
          `Added readonly to properties of class ${className}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Error adding readonly to class properties: ${err}`
        );
        console.error(err);
      }
    }
  );

  const addGettersToClassPropsCommand = vscode.commands.registerCommand(
    "yuri.addGettersToClassProps",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
          "temp.ts",
          document.getText(),
          { overwrite: true }
        );

        const classDeclaration = sourceFile.getClasses().find((cls: any) => {
          const start = cls.getStart();
          const end = cls.getEnd();
          const classRange = new vscode.Range(
            document.positionAt(start),
            document.positionAt(end)
          );
          return classRange.contains(range.start);
        });

        if (!classDeclaration) {
          vscode.window.showErrorMessage(
            "No class found at the cursor position."
          );
          return;
        }

        const className = classDeclaration.getName();
        const extendsClause = classDeclaration
          .getHeritageClauses()
          .find((h) => h.getToken() === SyntaxKind.ExtendsKeyword);

        const extendsText = extendsClause?.getText() ?? "";
        const isAggregate = extendsText.includes("Aggregate<");

        if (!isAggregate) {
          vscode.window.showErrorMessage(
            `${extendsText} => Class ${className} does not extend Aggregate with props type.`
          );
          return;
        }

        const propsTypeName = extendsText.match(/Aggregate<(\w+)>/)?.[1];
        if (!propsTypeName) {
          vscode.window.showErrorMessage(
            `Could not determine props type for Aggregate in class ${className}.`
          );
          return;
        }

        const propsType = sourceFile.getTypeAlias(propsTypeName);
        if (!propsType) {
          vscode.window.showErrorMessage(
            `Type ${propsTypeName} not found in the file.`
          );
          return;
        }

        const props = propsType
          .getType()
          .getProperties()
          .map((prop: any) => {
            const name = prop.getName();
            const type =
              prop.getValueDeclaration()?.getType()?.getText() || "any";
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

        vscode.window.showInformationMessage(
          `Added getters to class ${className}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Error adding getters to class: ${err}`);
        console.error(err);
      }
    }
  );

  const addMissingConstructorPropsCommand = vscode.commands.registerCommand(
    "yuri.addMissingConstructorProps",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const sourceFile = getSourceFileFromDocument(document);

        // 1) new Foo({...}) at cursor
        const offset = document.offsetAt(range.start);
        const nodeAt = sourceFile.getDescendantAtPos(offset);
        if (!nodeAt)
          return vscode.window.showErrorMessage("No node found at cursor.");

        const newExpr =
          nodeAt.getFirstAncestorByKind(SyntaxKind.NewExpression) ??
          nodeAt.asKind(SyntaxKind.NewExpression);
        if (!newExpr)
          return vscode.window.showErrorMessage(
            "Cursor is not inside a 'new Class(...)' expression."
          );

        const className = newExpr.getExpression().getText();
        const arg0 = newExpr.getArguments()[0];
        if (!arg0 || !arg0.isKind(SyntaxKind.ObjectLiteralExpression))
          return vscode.window.showErrorMessage(
            "Expected object literal as first constructor argument."
          );
        const argObj = arg0.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

        // 2) Resolve class nearby
        const cls = await findClassNearby(
          className,
          document.uri.fsPath,
          sourceFile
        );
        if (!cls)
          return vscode.window.showErrorMessage(
            `Class ${className} not found nearby.`
          );

        // 3) Constructor + first param (props)
        const ctor = cls.getConstructors()[0];
        if (!ctor)
          return vscode.window.showErrorMessage(
            `Class ${className} has no constructor.`
          );

        const param = ctor.getParameters()[0];
        if (!param)
          return vscode.window.showErrorMessage(
            `Constructor of ${className} has no parameters.`
          );

        // 4) Figure out the *shape* of the param, including Pick/Omit
        const wantedProps = await getWantedPropsFromParamType(
          param,
          document.uri.fsPath,
          sourceFile
        );
        if (!wantedProps.length) {
          return vscode.window.showInformationMessage(
            "No constructor properties detected."
          );
        }

        // 5) Which props are missing in the object literal?
        const existingNames = new Set(
          argObj
            .getProperties()
            .map((p) =>
              p.isKind(SyntaxKind.PropertyAssignment) ||
              p.isKind(SyntaxKind.ShorthandPropertyAssignment)
                ? p.getName()
                : ""
            )
            .filter(Boolean)
        );
        const missing = wantedProps
          .map((p) => p.name)
          .filter((n) => !existingNames.has(n));
        if (!missing.length)
          return vscode.window.showInformationMessage(
            "No missing properties to add."
          );

        // 6) Insert with tidy commas + indentation
        const indent = computeIndent(document, argObj);
        const valueTemplate = vscode.workspace
          .getConfiguration("yuri.addMissingConstructorProps")
          .get<string>("valueTemplate", "entity.${name}");

        const lines = missing.map(
          (name) =>
            `${indent}${name}: ${valueTemplate.replace("${name}", name)},`
        );
        let insertText = "\n" + lines.join("\n") + "\n";

        if (argObj.getProperties().length > 0) {
          const objText = argObj.getText();
          const beforeClose = objText
            .replace(/\s+}$/, "}")
            .slice(0, -1)
            .trimEnd();
          const hasTrailingComma = beforeClose.endsWith(",");
          if (!hasTrailingComma) insertText = "," + insertText;
        }

        const insertPos = document.positionAt(argObj.getEnd() - 1);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, insertText);
        await vscode.workspace.applyEdit(edit);

        vscode.window.showInformationMessage(
          `Added missing properties: ${missing.join(", ")}`
        );
      } catch (err) {
        console.error("addMissingConstructorProps (fast+pick/omit):", err);
        vscode.window.showErrorMessage(
          `Error adding missing properties: ${err}`
        );
      }

      // ---------- helpers ----------
      function computeIndent(
        doc: vscode.TextDocument,
        obj: import("ts-morph").ObjectLiteralExpression
      ) {
        const startPos = doc.positionAt(obj.getStart());
        const lineText = doc.lineAt(startPos.line).text;
        const base = lineText.match(/^\s*/)?.[0] ?? "";
        return base + "  ";
      }

      async function getWantedPropsFromParamType(
        param: import("ts-morph").ParameterDeclaration,
        fromFsPath: string,
        currentSf: import("ts-morph").SourceFile
      ): Promise<{ name: string; optional: boolean }[]> {
        const tn = param.getTypeNode();

        // Inline: constructor(props: { a: A; b?: B })
        if (tn?.isKind(SyntaxKind.TypeLiteral)) {
          return tn
            .getMembers()
            .filter((m) => m.isKind(SyntaxKind.PropertySignature))
            .map((m) => ({
              name: (m as any).getName(),
              optional: (m as any).hasQuestionToken?.() ?? false,
            }));
        }

        // Reference: FooProps | Pick<Foo, 'a'|'b'> | Omit<Foo, 'a'|'b'>
        if (tn?.isKind(SyntaxKind.TypeReference)) {
          const refText = tn.getText(); // quick parse; cheap
          const parsed = parsePickOmit(refText);
          if (parsed) {
            const baseDecl = await findInterfaceOrTypeNearby(
              parsed.base,
              fromFsPath,
              currentSf
            );
            if (!baseDecl) return [];
            const baseProps = getPropsFromInterfaceOrType(baseDecl);
            const set = new Set(parsed.fields);
            return parsed.kind === "pick"
              ? baseProps.filter((p) => set.has(p.name))
              : baseProps.filter((p) => !set.has(p.name));
          } else {
            const name = tn
              .asKindOrThrow(SyntaxKind.TypeReference)
              .getTypeName()
              .getText();
            const decl = await findInterfaceOrTypeNearby(
              name,
              fromFsPath,
              currentSf
            );
            if (!decl) return [];
            return getPropsFromInterfaceOrType(decl);
          }
        }

        // Fallback: limited checker scope
        try {
          return param
            .getType()
            .getProperties()
            .map((s) => ({ name: s.getName(), optional: false }));
        } catch {
          return [];
        }
      }

      function parsePickOmit(
        text: string
      ): { kind: "pick" | "omit"; base: string; fields: string[] } | null {
        // Handles: Pick<Foo, 'a' | 'b'>, Omit<Foo,"a"|'b'>
        const m =
          /^\s*(Pick|Omit)\s*<\s*([A-Za-z0-9_\.]+)\s*,\s*([^>]+)\s*>\s*$/.exec(
            text
          );
        if (!m) return null;
        const kind = m[1].toLowerCase() as "pick" | "omit";
        const base = m[2];
        const fields = Array.from(m[3].matchAll(/['"]([^'"]+)['"]/g)).map(
          (mm) => mm[1].trim()
        );
        return { kind, base, fields };
      }

      function getPropsFromInterfaceOrType(
        decl:
          | import("ts-morph").InterfaceDeclaration
          | import("ts-morph").TypeAliasDeclaration
      ): { name: string; optional: boolean }[] {
        if (decl.isKind(SyntaxKind.InterfaceDeclaration)) {
          return decl.getProperties().map((p) => ({
            name: p.getName(),
            optional: p.hasQuestionToken(),
          }));
        }
        const tn = decl.getTypeNode();
        if (tn?.isKind(SyntaxKind.TypeLiteral)) {
          return tn
            .getMembers()
            .filter((m) => m.isKind(SyntaxKind.PropertySignature))
            .map((m) => ({
              name: (m as any).getName(),
              optional: (m as any).hasQuestionToken?.() ?? false,
            }));
        }
        try {
          return decl
            .getType()
            .getProperties()
            .map((s) => ({ name: s.getName(), optional: false }));
        } catch {
          return [];
        }
      }

      async function findClassNearby(
        name: string,
        fromFsPath: string,
        currentSf: import("ts-morph").SourceFile
      ) {
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

      async function findInterfaceOrTypeNearby(
        name: string,
        fromFsPath: string,
        currentSf: import("ts-morph").SourceFile
      ) {
        const simple = name.split(".").pop()!;
        let d =
          currentSf.getInterface(simple) || currentSf.getTypeAlias(simple);
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

      async function ensureFileLoaded(fsPath: string) {
        const project = getProject();
        const existing = project.getSourceFile(fsPath);
        if (existing) return existing;
        const data = await vscode.workspace.fs.readFile(
          vscode.Uri.file(fsPath)
        );
        const text = Buffer.from(data).toString("utf8");
        return project.createSourceFile(fsPath, text, { overwrite: true });
      }
      async function fileExists(fsPath: string) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
          return true;
        } catch {
          return false;
        }
      }
      async function resolveModuleToFsPath(
        fromFsPath: string,
        moduleSpecifier: string
      ) {
        const base = path.dirname(fromFsPath);
        const candidates = [
          path.resolve(base, `${moduleSpecifier}.ts`),
          path.resolve(base, `${moduleSpecifier}.tsx`),
          path.resolve(base, `${moduleSpecifier}.d.ts`),
          path.resolve(base, moduleSpecifier, "index.ts"),
          path.resolve(base, moduleSpecifier, "index.tsx"),
        ];
        for (const c of candidates) if (await fileExists(c)) return c;
        return null;
      }
    }
  );

  const syncClassWithInterfaceCommand = vscode.commands.registerCommand(
    "yuri.syncClassWithInterfaceProps",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const project = getProject();
        const sourceFile = getSourceFileFromDocument(document);

        // Find the class at the cursor
        const offset = document.offsetAt(range.start);
        const classDecl = sourceFile.getClasses().find((cls) => {
          const start = cls.getStart();
          const end = cls.getEnd();
          return offset >= start && offset <= end;
        });
        if (!classDecl) {
          vscode.window.showErrorMessage("No class found at cursor.");
          return;
        }

        const impl = classDecl.getImplements()[0];
        if (!impl) {
          vscode.window.showErrorMessage(
            "Class does not implement an interface."
          );
          return;
        }
        const implText = impl.getText(); // e.g. Foo<Bar> or IFoo
        const interfaceName = (
          impl.getExpression()?.getText() ?? implText
        ).replace(/<.*$/, "");
        if (!interfaceName) {
          vscode.window.showErrorMessage(
            "Could not resolve implemented interface name."
          );
          return;
        }

        // Resolve nearby
        let iface = sourceFile.getInterface(interfaceName);
        if (!iface) {
          iface = await tryFindInterfaceNearby(
            interfaceName,
            document.uri.fsPath,
            sourceFile
          );
        }
        if (!iface) {
          vscode.window.showErrorMessage(
            `Interface ${interfaceName} not found nearby (skipping full-project scan for speed).`
          );
          return;
        }

        // Interface props
        const ifaceProps = iface.getProperties().map((p) => ({
          name: p.getName(),
          type: getPropTypeFast(p),
        }));

        const classPropNames = new Set(
          classDecl.getProperties().map((p) => p.getName())
        );
        let ctor = classDecl.getConstructors()[0];

        let ctorParamName = "props";
        if (ctor) {
          const param = ctor.getParameters()[0];
          if (param) ctorParamName = param.getName();
        }

        const missingDecls = ifaceProps.filter(
          (p) => !classPropNames.has(p.name)
        );
        const ctorBodyText = ctor?.getBodyText() ?? "";
        const missingAssignments = ifaceProps.filter(
          (p) => !new RegExp(`\\bthis\\.${p.name}\\b`).test(ctorBodyText)
        );

        if (
          missingDecls.length === 0 &&
          missingAssignments.length === 0 &&
          ctor
        ) {
          vscode.window.showInformationMessage(
            "No missing properties or constructor assignments found."
          );
          return;
        }

        const edit = new vscode.WorkspaceEdit();

        // 1) Missing property declarations after opening brace
        if (missingDecls.length) {
          const openBrace = classDecl.getFirstChildByKind(
            SyntaxKind.OpenBraceToken
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

        // 2) Ensure constructor exists
        if (!ctor) {
          const beforeCloseBrace = classDecl.getLastChildByKind(
            SyntaxKind.CloseBraceToken
          );
          if (!beforeCloseBrace) {
            vscode.window.showErrorMessage(
              "Could not locate class body for constructor insertion."
            );
            return;
          }
          const insertCtorPos = document.positionAt(
            beforeCloseBrace.getStart()
          );
          const ctorText =
            `\n  constructor(${ctorParamName}: ${interfaceName}) {\n` + `  }\n`;
          edit.insert(document.uri, insertCtorPos, ctorText);
        }

        // 3) Add missing assignments
        const ctorNow = classDecl.getConstructors()[0] || ctor;
        let ctorInsertPos: vscode.Position | null = null;
        if (ctorNow && ctorNow.getBody()) {
          const bodyEnd = ctorNow.getBody()!.getEnd();
          ctorInsertPos = document.positionAt(bodyEnd - 1);
        } else {
          const closeBrace = classDecl.getLastChildByKind(
            SyntaxKind.CloseBraceToken
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
          `Added ${missingDecls.length} property(ies) and ${missingAssignments.length} constructor assignment(s).`
        );

        // helpers
        async function tryFindInterfaceNearby(
          name: string,
          fromFsPath: string,
          currentSf: import("ts-morph").SourceFile
        ): Promise<import("ts-morph").InterfaceDeclaration | undefined> {
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

        async function ensureFileLoaded(fsPath: string) {
          const existing = project.getSourceFile(fsPath);
          if (existing) return existing;
          const data = await vscode.workspace.fs.readFile(
            vscode.Uri.file(fsPath)
          );
          const text = Buffer.from(data).toString("utf8");
          return project.createSourceFile(fsPath, text, { overwrite: true });
        }
        async function fileExists(fsPath: string) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
            return true;
          } catch {
            return false;
          }
        }
        async function resolveModuleToFsPath(
          fromFsPath: string,
          moduleSpecifier: string
        ) {
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
      } catch (err) {
        console.error("syncClassWithInterface (fast):", err);
        vscode.window.showErrorMessage(
          `Error syncing class with interface: ${err}`
        );
      }
    }
  );

  const generateClassFromTypeCommand = vscode.commands.registerCommand(
    "yuri.generateClassFromType",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const cfg = vscode.workspace.getConfiguration("yuri.generateClass");
        const inNewFile = cfg.get<boolean>("inNewFile", true);
        const classNameSuffix = cfg.get<string>("classNameSuffix", "Impl");
        const includeGetters = cfg.get<boolean>("includeGetters", false);

        const project = getProject();
        const sourceFile = getSourceFileFromDocument(document);

        const m = document.lineAt(range.start.line).text.match(/type\s+(\w+)/);
        if (!m)
          return vscode.window.showErrorMessage(
            "Could not determine type name."
          );
        const typeName = m[1];

        const typeAlias = sourceFile.getTypeAlias(typeName);
        if (!typeAlias)
          return vscode.window.showErrorMessage(
            `Type ${typeName} not found in this file.`
          );

        // Detect Omit<Base, 'a'|'b'> via node text (fast, same-file only)
        let baseTypeName: string | null = null;
        let properties: { name: string; type: string; isOptional: boolean }[] =
          [];

        const typeNode = typeAlias.getTypeNode();
        const typeText = typeNode?.getText() ?? "";

        const omitMatch =
          /Omit<\s*([A-Za-z0-9_\.]+)\s*,\s*((?:(?:['"][^'"]+['"])\s*(?:\|\s*)?)*)>/.exec(
            typeText
          );
        if (omitMatch) {
          baseTypeName = omitMatch[1];
          const omitted = new Set(
            Array.from(omitMatch[2].matchAll(/['"]([^'"]+)['"]/g)).map(
              (mm) => mm[1]
            )
          );

          const baseIface: InterfaceDeclaration | undefined =
            sourceFile.getInterface(baseTypeName.split(".").pop()!);
          const baseTypeAlias: TypeAliasDeclaration | undefined =
            sourceFile.getTypeAlias(baseTypeName.split(".").pop()!);

          if (!baseIface && !baseTypeAlias) {
            return vscode.window.showErrorMessage(
              `Base type/interface ${baseTypeName} not found in this file (avoid full workspace scan for speed).`
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
            const syms = baseTypeAlias.getType().getProperties();
            properties = syms
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
                  } catch {}
                }
                return { name, type, isOptional };
              })
              .filter((p) => !omitted.has(p.name));
          }
        } else {
          // Plain object-like type alias
          const syms = typeAlias.getType().getProperties();
          properties = syms.map((sym) => {
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
            } catch {}
            return { name, type: t, isOptional: false };
          });
        }

        if (!properties.length)
          return vscode.window.showErrorMessage(
            `No properties found in type ${typeName}.`
          );

        // Class name
        let className = typeName.endsWith("ViewModel")
          ? typeName.replace(/ViewModel$/, "")
          : typeName;
        className += classNameSuffix;

        // Build class text
        const lines: string[] = [];
        lines.push(`export class ${className} implements ${typeName} {`);
        for (const p of properties) {
          lines.push(
            `  readonly ${p.name}${p.isOptional ? "?" : ""}: ${p.type}`
          );
        }
        lines.push("");
        lines.push(`  constructor(init: ${typeName}) {`);
        for (const p of properties) {
          if (p.isOptional) {
            lines.push(
              `    this.${p.name} = init.${p.name} ?? ${defaultFor(p.type)}`
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
            `Class ${className} generated in ${path.basename(target.fsPath)}.`
          );
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            document.uri,
            new vscode.Position(document.lineCount + 1, 0),
            "\n" + classContent
          );
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Class ${className} generated inline.`
          );
        }
      } catch (err) {
        console.error("generateClassFromType:", err);
        vscode.window.showErrorMessage(
          `Error generating class from type: ${err}`
        );
      }
    }
  );

  const generateViewInterfacesCommand = vscode.commands.registerCommand(
    "yuri.generateViewInterfaces",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const config = vscode.workspace.getConfiguration(
          "yuri.generateViewInterfaces"
        );
        const inNewFile = config.get<boolean>("inNewFile", true);
        const validationMode = config.get<ValidationMode>(
          "validationMode",
          "partial"
        );
        const iSuffix = config.get<string>("interfaceSuffix", "");
        // Ensure project + source file come from the real filesystem + tsconfig
        const project = getProject(document.fileName);
        const sourceFile = getSourceFileFromDocument(document);
        // interface name from current line (cheap)
        const m = document
          .lineAt(range.start.line)
          .text.match(/interface\s+(\w+)/);
        if (!m) {
          vscode.window.showErrorMessage("Could not determine interface name.");
          return;
        }
        const interfaceName = m[1];
        const noUnderscoreInterfaceName = interfaceName.startsWith("_")
          ? interfaceName.slice(1)
          : interfaceName;
        const iface = sourceFile.getInterface(interfaceName);
        if (!iface) {
          vscode.window.showErrorMessage(
            `Interface ${interfaceName} not found in this file.`
          );
          return;
        }
        // find _viewSchemas as object literal in the same file (no workspace scan)
        const viewSchemasVar =
          sourceFile.getVariableDeclaration("_viewSchemas");
        if (!viewSchemasVar) {
          vscode.window.showErrorMessage(
            `No '_viewSchemas' variable found in the file.`
          );
          return;
        }
        const init = viewSchemasVar.getInitializer();
        if (!init || !init.isKind(SyntaxKind.ObjectLiteralExpression)) {
          vscode.window.showErrorMessage(
            `'_viewSchemas' must be initialized with an object literal.`
          );
          return;
        }
        const obj = init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        // collect interface props for validation
        const ifacePropNames = new Set(
          iface.getProperties().map((p) => p.getName())
        );
        const out: string[] = [];
        if (inNewFile) {
          out.push(
            `import { ${interfaceName} } from './${path.basename(
              document.fileName,
              ".ts"
            )}'`,
            ""
          );
        }
        // ---------------- helpers ----------------
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
        type Split = {
          top: Set<string>;
          nested: Map<string, Set<string>>;
          exclusions: Map<string, Set<string>>; // New: tracks fields to exclude, e.g., { "author": Set("privacy") }
        };
        const splitFields = (fields: string[]): Split => {
          const top = new Set<string>();
          const nested = new Map<string, Set<string>>();
          const exclusions = new Map<string, Set<string>>();
          for (const f of fields) {
            // Check for exclusion syntax, e.g., "author.!privacy"
            const exclusionMatch = f.match(/^(\w+)\.\!(\w+)$/);
            if (exclusionMatch) {
              const [, parent, excludedField] = exclusionMatch;
              // Add parent to top-level fields to include the whole object
              top.add(parent);
              // Track the excluded field
              if (!exclusions.has(parent)) {
                exclusions.set(parent, new Set());
              }
              exclusions.get(parent)!.add(excludedField);
              continue;
            }
            // Existing logic for regular fields
            const parts = f.split(".");
            if (parts.length === 1) {
              top.add(parts[0]);
            } else if (parts.length >= 2) {
              const [parent, child] = parts as [string, string];
              if (!nested.has(parent)) {
                nested.set(parent, new Set());
              }
              nested.get(parent)!.add(child);
            }
          }
          // If a parent appears both top-level and nested, prefer nested unless it's an exclusion
          for (const parent of nested.keys()) {
            if (!exclusions.has(parent)) {
              top.delete(parent);
            }
          }
          return { top, nested, exclusions };
        };
        // Type rendering helpers
        const printType = (t: Type, ctx: Node) => t.getText(ctx);
        const getTopPropTypeText = (name: string): string | null => {
          const p = iface.getProperty(name);
          if (!p) return null;
          // If the property has an explicit annotation, use it verbatim (keeps 'string')
          const tn = p.getTypeNode();
          if (tn) return tn.getText();
          // Fallback to the computed type (no 'apparent' boxing)
          return p.getType().getNonNullableType().getText(p);
        };
        function getArrayElementTypeIfArray(t: Type): {
          isArray: boolean;
          elem: Type;
        } {
          const nn = t.getNonNullableType(); // don't use getApparentType -> avoids boxing 'string' => 'String'
          if (nn.isArray()) {
            const elem = nn.getArrayElementType();
            if (elem) return { isArray: true, elem };
          }
          // Handle Array<T>/ReadonlyArray<T>
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
        const getChildPropTypeText = (
          parent: string,
          child: string
        ): { isArray: boolean; typeText: string } | null => {
          const parentSig = iface.getProperty(parent);
          if (!parentSig) return null;
          const { isArray, elem } = getArrayElementTypeIfArray(
            parentSig.getType()
          );
          const childSym = elem.getProperty(child);
          if (!childSym) return null;
          const childDecl = childSym.getDeclarations()?.[0] ?? iface;
          // Avoid apparent type here too; stick to the declared/real type
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
          const { top, nested, exclusions } = splitFields(fields);
          // --- validation ---
          const invalidTop = [...top].filter((f) => !ifacePropNames.has(f));
          const invalidNestedParents = [...nested.keys()].filter(
            (p) => !ifacePropNames.has(p)
          );
          const invalidNestedChildren: string[] = [];
          // Validate exclusions
          const invalidExclusions: string[] = [];
          for (const [parent, excludedFields] of exclusions) {
            if (!ifacePropNames.has(parent)) {
              invalidExclusions.push(
                ...[...excludedFields].map((f) => `${parent}.!${f}`)
              );
              continue;
            }
            // Optionally validate excluded fields
            if (validationMode === "strict" || validationMode === "partial") {
              const parentSig = iface.getProperty(parent);
              const parentType = parentSig ? parentSig.getType() : undefined;
              const childNames = parentType
                ? new Set(
                    parentType.getProperties().map((s: Symbol) => s.getName())
                  )
                : null;
              if (childNames) {
                for (const excludedField of excludedFields) {
                  if (!childNames.has(excludedField)) {
                    invalidExclusions.push(`${parent}.!${excludedField}`);
                  }
                }
              }
            }
          }
          // Existing nested children validation
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
              if (!childNames.has(c)) {
                invalidNestedChildren.push(`${parent}.${c}`);
              }
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
          if (validationMode === "strict") {
            if (invalid.length) {
              warnings.push(
                `Skipped '${viewName}': invalid fields: ${invalid.join(", ")}`
              );
              continue;
            }
          } else if (validationMode === "partial") {
            // Keep only valid top-level names
            finalTop = finalTop.filter((f) => ifacePropNames.has(f));
            // Require valid parent for nested and exclusions
            for (const p of [...finalNested.keys()]) {
              if (!ifacePropNames.has(p)) {
                finalNested.delete(p);
              }
            }
            for (const p of [...finalExclusions.keys()]) {
              if (!ifacePropNames.has(p)) {
                finalExclusions.delete(p);
              }
            }
            if (
              !finalTop.length &&
              !finalNested.size &&
              !finalExclusions.size
            ) {
              warnings.push(`Skipped '${viewName}': no valid fields.`);
              continue;
            }
            if (invalid.length) {
              warnings.push(
                `Partially generated '${viewName}': ignored invalid fields: ${invalid.join(
                  ", "
                )}`
              );
            }
          } else {
            // Loose: only require parent to exist
            finalTop = finalTop.filter((f) => ifacePropNames.has(f));
            for (const p of [...finalNested.keys()]) {
              if (!ifacePropNames.has(p)) {
                finalNested.delete(p);
              }
            }
            for (const p of [...finalExclusions.keys()]) {
              if (!ifacePropNames.has(p)) {
                finalExclusions.delete(p);
              }
            }
            if (invalid.length) {
              warnings.push(
                `Loosely generated '${viewName}': interface does not contain: ${invalid.join(
                  ", "
                )}`
              );
            }
          }
          // --- emit ---
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
            // Check if this field has exclusions
            const excludedFields = finalExclusions.get(name);
            if (excludedFields) {
              const parentSig = iface.getProperty(name);
              if (!parentSig) continue;
              const parentType = parentSig.getType().getNonNullableType();
              const { isArray, elem } = getArrayElementTypeIfArray(parentType);
              const childProps = elem.getProperties();
              const childLines: string[] = [];
              for (const childProp of childProps) {
                const childName = childProp.getName();
                if (excludedFields.has(childName)) continue; // Skip excluded fields
                const childTypeText = childProp
                  .getTypeAtLocation(parentSig)
                  .getNonNullableType()
                  .getText(parentSig);
                childLines.push(
                  `${childName}: ${normalizePrimitives(childTypeText)}`
                );
              }
              if (!childLines.length) continue;
              const obj = `{ ${childLines.join("; ")} }`;
              lines.push(
                isArray ? ` ${name}: Array<${obj}>;` : ` ${name}: ${obj};`
              );
            } else {
              lines.push(` ${name}: ${normalizePrimitives(tt)};`);
            }
          }
          // Nested fields (existing logic)
          for (const [parent, childs] of finalNested) {
            const pieces: string[] = [];
            let isArrayParent: boolean | null = null;
            for (const child of childs) {
              const info = getChildPropTypeText(parent, child);
              if (!info) continue;
              if (isArrayParent == null) isArrayParent = info.isArray;
              if (isArrayParent !== info.isArray) isArrayParent = false;
              pieces.push(`${child}: ${normalizePrimitives(info.typeText)}`);
            }
            if (!pieces.length) continue;
            const obj = `{ ${pieces.join("; ")} }`;
            lines.push(
              isArrayParent
                ? ` ${parent}: Array<${obj}>;`
                : ` ${parent}: ${obj};`
            );
          }
          if (!lines.length) continue;
          out.push(`export interface ${typeName} {\n${lines.join("\n")}\n}`);
          generated++;
        }
        if (!generated) {
          vscode.window.showErrorMessage(
            `No view interfaces generated from '_viewSchemas'.` +
              (warnings.length ? ` Details: ${warnings.join(" | ")}` : "")
          );
          return;
        }
        const content = out.join("\n") + "\n";
        if (inNewFile) {
          const dir = path.dirname(document.uri.fsPath);
          const target = vscode.Uri.file(
            path.join(dir, `${interfaceName}Views.ts`)
          );
          await writeFileUtf8(target, content);
          vscode.window.showInformationMessage(
            `Generated ${generated} interfaces in ${path.basename(
              target.fsPath
            )}.` + (warnings.length ? ` Warnings: ${warnings.join(" | ")}` : "")
          );
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            document.uri,
            new vscode.Position(document.lineCount + 1, 0),
            "\n" + content
          );
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Generated ${generated} interfaces inline.` +
              (warnings.length ? ` Warnings: ${warnings.join(" | ")}` : "")
          );
        }
      } catch (err) {
        console.error("generateViewInterfaces:", err);
        vscode.window.showErrorMessage(
          `Error generating view interfaces: ${err}`
        );
      }
    }
  );
  // ---------------- generate factory from TYPE (fast same-file Omit/Pick) ----------------
  const generateFactoryFromTypeCommand = vscode.commands.registerCommand(
    "yuri.generateFactoryFromType",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const cfg = vscode.workspace.getConfiguration("yuri.generateFactory");
        const inNewFile = cfg.get<boolean>("inNewFile", true);
        const functionPrefix = cfg.get<string>("functionPrefix", "create");
        const stripSuffixRx = new RegExp(
          cfg.get<string>("stripSuffixRegex", "(ViewModel|View|Props)$")
        );

        const project = getProject();
        const sourceFile = getSourceFileFromDocument(document);

        const m = document.lineAt(range.start.line).text.match(/type\s+(\w+)/);
        if (!m)
          return vscode.window.showErrorMessage(
            "Could not determine type name."
          );
        const typeName = m[1];

        const typeAlias = sourceFile.getTypeAlias(typeName);
        if (!typeAlias)
          return vscode.window.showErrorMessage(
            `Type ${typeName} not found in this file.`
          );

        // Collect properties (supports Omit<Base, 'a'|'b'> and Pick<Base, 'a'|'b'> via node text)
        type PropInfo = { name: string; type: string; isOptional: boolean };
        let properties: PropInfo[] = [];

        const typeNode = typeAlias.getTypeNode();
        const typeText = typeNode?.getText() ?? "";

        // Try Omit<Base, 'a'|'b'> and Pick<Base, 'a'|'b'>
        const omitMatch =
          /Omit<\s*([A-Za-z0-9_\.]+)\s*,\s*((?:(?:['"][^'"]+['"])\s*(?:\|\s*)?)*)>/.exec(
            typeText
          );
        const pickMatch =
          /Pick<\s*([A-Za-z0-9_\.]+)\s*,\s*((?:(?:['"][^'"]+['"])\s*(?:\|\s*)?)*)>/.exec(
            typeText
          );

        function parseKeyList(raw: string) {
          return Array.from(raw.matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]);
        }

        if (omitMatch || pickMatch) {
          const [_, baseTypeName, rawKeys] = (omitMatch ?? pickMatch)!;
          const keys = new Set(parseKeyList(rawKeys));

          const simpleBase = baseTypeName.split(".").pop()!;
          const baseIface = sourceFile.getInterface(simpleBase);
          const baseType = sourceFile.getTypeAlias(simpleBase);

          if (!baseIface && !baseType) {
            return vscode.window.showErrorMessage(
              `Base ${baseTypeName} not found in this file (factory-from-type avoids workspace scan).`
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
            const syms = baseType.getType().getProperties();
            baseProps = syms.map((sym) => {
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
                } catch {}
              }
              return { name, type, isOptional };
            });
          }

          if (pickMatch) {
            properties = baseProps.filter((p) => keys.has(p.name));
            // warn if invalid keys
            const invalid = Array.from(keys).filter(
              (k) => !baseProps.some((p) => p.name === k)
            );
            if (invalid.length) {
              return vscode.window.showErrorMessage(
                `Invalid fields in Pick: ${invalid.join(
                  ", "
                )} not found in ${baseTypeName}.`
              );
            }
          } else {
            // Omit
            properties = baseProps.filter((p) => !keys.has(p.name));
          }
        } else {
          // Plain object-like alias
          const syms = typeAlias.getType().getProperties();
          properties = syms.map((sym) => {
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
            } catch {}
            return { name, type: t, isOptional: false };
          });
        }

        if (!properties.length)
          return vscode.window.showErrorMessage(
            `No properties found in type ${typeName}.`
          );

        // Factory name
        const baseName = typeName.replace(stripSuffixRx, "");
        const factoryName = `${functionPrefix}${baseName}`;

        // Build function text
        const lines: string[] = [];
        if (inNewFile) {
          lines.push(
            `import type { ${typeName} } from './${path.basename(
              document.fileName,
              ".ts"
            )}';`
          );
          lines.push("");
        }
        lines.push(
          `export function ${factoryName}(init: ${typeName}): Readonly<${typeName}> {`
        );
        lines.push(`  return Object.freeze({`);
        for (const p of properties) {
          if (p.isOptional) {
            lines.push(
              `    ${p.name}: init.${p.name} ?? ${defaultFor(p.type)},`
            );
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
            `Factory ${factoryName} generated in ${path.basename(
              target.fsPath
            )}.`
          );
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            document.uri,
            new vscode.Position(document.lineCount + 1, 0),
            "\n" + fnContent
          );
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Factory ${factoryName} generated inline.`
          );
        }
      } catch (err) {
        console.error("generateFactoryFromType:", err);
        vscode.window.showErrorMessage(
          `Error generating factory from type: ${err}`
        );
      }
    }
  );

  // ---------------- generate factory from INTERFACE (AST-first: Pick/Omit + alias base) ----------------
  const generateFactoryFromInterfaceCommand = vscode.commands.registerCommand(
    "yuri.generateFactoryFromInterface",
    async (document: vscode.TextDocument, range: vscode.Range) => {
      try {
        const cfg = vscode.workspace.getConfiguration("yuri.generateFactory");
        const inNewFile = cfg.get<boolean>("inNewFile", false);
        const functionPrefix = cfg.get<string>("functionPrefix", "create");
        const stripSuffixRx = new RegExp(
          cfg.get<string>("stripSuffixRegex", "(ViewModel|View|Props)$")
        );

        const project = getProject();
        const sourceFile = getSourceFileFromDocument(document);

        const line = document.lineAt(range.start.line).text;
        const m = line.match(/interface\s+(\w+)/);
        if (!m) {
          return vscode.window.showErrorMessage(
            "Could not determine interface name."
          );
        }
        const interfaceName = m[1];

        const iface = sourceFile.getInterface(interfaceName);
        if (!iface) {
          return vscode.window.showErrorMessage(
            `Interface ${interfaceName} not found in this file.`
          );
        }

        type PropInfo = { name: string; type: string; isOptional: boolean };
        type HeritageKind = "pick" | "omit" | "none";
        let heritageKind: HeritageKind = "none";
        let baseTypeName: string | null = null;
        let keyList: string[] = [];

        // Helpers for parsing heritage type args (local to this command)
        function extractStringLiteralKeys(
          typeNode: import("ts-morph").TypeNode
        ): string[] {
          const text = typeNode.getText();
          return Array.from(text.matchAll(/['"]([^'"]+)['"]/g)).map(
            (m) => m[1]
          );
        }
        function getBaseNameFromTypeArg(
          typeNode: import("ts-morph").TypeNode
        ): string | null {
          try {
            // getText() is fine; we only need the simple name (last segment if qualified)
            const txt = typeNode.getText();
            const simple = txt.split(".").pop();
            return simple || null;
          } catch {
            return null;
          }
        }

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

        // Resolve nearby (same as your AST-first pattern)
        async function ensureFileLoaded(fsPath: string) {
          const existing = project.getSourceFile(fsPath);
          if (existing) return existing;
          const data = await vscode.workspace.fs.readFile(
            vscode.Uri.file(fsPath)
          );
          const text = Buffer.from(data).toString("utf8");
          return project.createSourceFile(fsPath, text, { overwrite: true });
        }
        async function fileExists(fsPath: string) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
            return true;
          } catch {
            return false;
          }
        }
        async function resolveModuleToFsPath(
          fromFsPath: string,
          moduleSpecifier: string
        ) {
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
        async function tryFindDeclNearby(
          name: string
        ): Promise<InterfaceDeclaration | TypeAliasDeclaration | undefined> {
          const simple = name.split(".").pop()!;

          // same file
          let idecl = sourceFile.getInterface(simple);
          if (idecl) return idecl;
          let tdecl = sourceFile.getTypeAlias(simple);
          if (tdecl) return tdecl;

          // relative imports (once)
          for (const imp of sourceFile.getImportDeclarations()) {
            const spec = imp.getModuleSpecifierValue();
            if (!spec.startsWith(".")) continue;
            const fsPath = await resolveModuleToFsPath(
              document.uri.fsPath,
              spec
            );
            if (!fsPath) continue;
            const sf = await ensureFileLoaded(fsPath);
            idecl = sf.getInterface(simple);
            if (idecl) return idecl;
            tdecl = sf.getTypeAlias(simple);
            if (tdecl) return tdecl;
          }

          // same-dir probe
          const dir = path.dirname(document.uri.fsPath);
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

        function getPropsFromDecl(
          decl: InterfaceDeclaration | TypeAliasDeclaration
        ): PropInfo[] {
          if (decl.getKind() === SyntaxKind.InterfaceDeclaration) {
            const i = decl as InterfaceDeclaration;
            return i.getProperties().map((p) => ({
              name: p.getName(),
              type: getPropTypeFast(p),
              isOptional: p.hasQuestionToken(),
            }));
          }
          const t = decl as TypeAliasDeclaration;
          return t
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
                  type = sym.getTypeAtLocation(t).getText();
                } catch {}
              }
              return { name, type, isOptional };
            });
        }

        // Collect props
        let properties: PropInfo[] = [];
        if (heritageKind !== "none" && baseTypeName) {
          const baseDecl = await tryFindDeclNearby(baseTypeName);
          if (!baseDecl) {
            return vscode.window.showErrorMessage(
              `Base type ${baseTypeName} not found nearby (skipping full-project scan for speed).`
            );
          }
          const baseProps = getPropsFromDecl(baseDecl);

          if (heritageKind === "pick") {
            const pickSet = new Set(keyList);
            properties = baseProps.filter((p) => pickSet.has(p.name));

            const invalid = keyList.filter(
              (k) => !baseProps.some((p) => p.name === k)
            );
            if (invalid.length) {
              return vscode.window.showErrorMessage(
                `Invalid fields in Pick: ${invalid.join(
                  ", "
                )} not found in ${baseTypeName}.`
              );
            }
          } else {
            // Omit: remove omitted and merge local additions/overrides
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
          return vscode.window.showErrorMessage(
            `No properties found in interface ${interfaceName}.`
          );
        }

        // Factory name
        const baseName = interfaceName.replace(stripSuffixRx, "");
        const factoryName = `${functionPrefix}${baseName}`;

        // Generate function
        const lines: string[] = [];
        if (inNewFile) {
          lines.push(
            `import type { ${interfaceName} } from './${path.basename(
              document.fileName,
              ".ts"
            )}';`
          );
          lines.push("");
        }
        lines.push(
          `export function ${factoryName}(init: ${interfaceName}): Readonly<${interfaceName}> {`
        );
        lines.push(`  return Object.freeze({`);
        for (const p of properties) {
          if (p.isOptional) {
            lines.push(
              `    ${p.name}: init.${p.name} ?? ${defaultFor(p.type)},`
            );
          } else {
            lines.push(`    ${p.name}: init.${p.name},`);
          }
        }
        lines.push(`  });`);
        lines.push(`}`);
        const fnContent = lines.join("\n") + "\n";

        if (inNewFile) {
          const originalDir = path.dirname(document.uri.fsPath);
          const target = vscode.Uri.file(
            path.join(originalDir, `${factoryName}.ts`)
          );
          await writeFileUtf8(target, fnContent);
          vscode.window.showInformationMessage(
            `Factory ${factoryName} generated in ${path.basename(
              target.fsPath
            )}.`
          );
        } else {
          const edit = new vscode.WorkspaceEdit();
          const position = new vscode.Position(document.lineCount + 1, 0);
          edit.insert(document.uri, position, "\n" + fnContent);
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Factory ${factoryName} generated inline.`
          );
        }
      } catch (err) {
        console.error("generateFactoryFromInterface:", err);
        vscode.window.showErrorMessage(
          `Error generating factory from interface: ${err}`
        );
      }
    }
  );

  context.subscriptions.push(generateClassCommand);
  context.subscriptions.push(refactorToUseCaseCommand);
  context.subscriptions.push(addReadonlyToClassPropsCommand);
  context.subscriptions.push(addGettersToClassPropsCommand);
  context.subscriptions.push(addMissingConstructorPropsCommand);
  context.subscriptions.push(syncClassWithInterfaceCommand);
  context.subscriptions.push(disposable);
  context.subscriptions.push(generateClassFromTypeCommand);
  context.subscriptions.push(generateViewInterfacesCommand);
  context.subscriptions.push(generateFactoryFromInterfaceCommand);
  context.subscriptions.push(generateFactoryFromTypeCommand);
}

class YuriCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] | undefined {
    const actions: vscode.CodeAction[] = [];
    const lineText = document.lineAt(range.start.line).text;

    console.log("YuriCodeActionProvider: Evaluating actions at", range.start);

    if (lineText.includes("interface ")) {
      const fix = new vscode.CodeAction(
        "Generate Class from Interface (Yuri)",
        vscode.CodeActionKind.QuickFix
      );
      fix.command = {
        title: "Generate Class",
        command: "yuri.generateClassFromInterface",
        arguments: [document, range],
      };
      actions.push(fix);
      const generateViewInterfacesFix = new vscode.CodeAction(
        "Generate View Interfaces (Yuri)",
        vscode.CodeActionKind.QuickFix
      );
      generateViewInterfacesFix.command = {
        title: "Generate View Interfaces",
        command: "yuri.generateViewInterfaces",
        arguments: [document, range],
      };
      actions.push(generateViewInterfacesFix);
      const generateFactoryFromInterface = new vscode.CodeAction(
        "Generate Factory From Interfaces (Yuri)",
        vscode.CodeActionKind.QuickFix
      );
      generateFactoryFromInterface.command = {
        title: "Generate Factory From Interfaces",
        command: "yuri.generateFactoryFromInterface",
        arguments: [document, range],
      };
      actions.push(generateFactoryFromInterface);
    }

    if (lineText.includes("type ")) {
      const fix = new vscode.CodeAction(
        "Generate Class from Type (Yuri)",
        vscode.CodeActionKind.QuickFix
      );
      fix.command = {
        title: "Generate Class from Type",
        command: "yuri.generateClassFromType",
        arguments: [document, range],
      };
      actions.push(fix);
      const generateFactoryFromType = new vscode.CodeAction(
        "Generate Factory From Type (Yuri)",
        vscode.CodeActionKind.QuickFix
      );
      generateFactoryFromType.command = {
        title: "Generate Factory From Type",
        command: "yuri.generateFactoryFromType",
        arguments: [document, range],
      };
      actions.push(generateFactoryFromType);
    }

    const documentText = document.getText();
    if (
      (documentText.includes("QueryHandler") &&
        documentText.includes("IQueryHandler")) ||
      (documentText.includes("CommandHandler") &&
        documentText.includes("ICommandHandler"))
    ) {
      const refactor = new vscode.CodeAction(
        "Refactor CQRS Handler to Use Case (Yuri)",
        vscode.CodeActionKind.Refactor
      );
      refactor.command = {
        title: "Refactor to Use Case",
        command: "yuri.refactorCQRSHandlerToUseCase",
        arguments: [document],
      };
      actions.push(refactor);
    }

    try {
      const project = new Project({ useInMemoryFileSystem: true });
      const sourceFile = project.createSourceFile(
        "temp.ts",
        document.getText(),
        { overwrite: true }
      );

      const classDeclaration = sourceFile.getClasses().find((cls: any) => {
        const start = cls.getStart();
        const end = cls.getEnd();
        const classRange = new vscode.Range(
          document.positionAt(start),
          document.positionAt(end)
        );
        return classRange.contains(range.start);
      });

      if (lineText.includes("new ")) {
        const addPropsFix = new vscode.CodeAction(
          "Add Missing Constructor Properties (Yuri)",
          vscode.CodeActionKind.QuickFix
        );
        addPropsFix.command = {
          title: "Add Missing Constructor Props",
          command: "yuri.addMissingConstructorProps",
          arguments: [document, range],
        };
        actions.push(addPropsFix);
      }

      if (lineText.includes("class ") && lineText.includes("implements")) {
        const fix = new vscode.CodeAction(
          "Sync Class with Interface (Yuri)",
          vscode.CodeActionKind.QuickFix
        );
        fix.command = {
          title: "Sync Class with Interface",
          command: "yuri.syncClassWithInterfaceProps",
          arguments: [document, range],
        };
        actions.push(fix);
      }

      if (classDeclaration) {
        const readonlyAction = new vscode.CodeAction(
          "Add readonly to Class Properties (Yuri)",
          vscode.CodeActionKind.Refactor
        );
        readonlyAction.command = {
          title: "Add readonly to Class Properties",
          command: "yuri.addReadonlyToClassProps",
          arguments: [document, range],
        };
        actions.push(readonlyAction);

        const extendsClause = classDeclaration
          .getHeritageClauses()
          .find((h) => h.getToken() === SyntaxKind.ExtendsKeyword);

        const extendsText = extendsClause?.getText() ?? "";
        const isAggregate = extendsText.includes("Aggregate<");

        if (isAggregate) {
          const gettersAction = new vscode.CodeAction(
            "Add Getters to Class Properties (Yuri)",
            vscode.CodeActionKind.Refactor
          );
          gettersAction.command = {
            title: "Add Getters to Class Properties",
            command: "yuri.addGettersToClassProps",
            arguments: [document, range],
          };
          actions.push(gettersAction);
        }
      }
    } catch (err) {
      console.error("YuriCodeActionProvider: Error evaluating class", err);
    }

    return actions.length > 0 ? actions : undefined;
  }
}

function refactorCQRSHandlerToUseCase(
  sourceFile: any,
  resultOk: string,
  resultFailure: string
): string | null {
  const text = sourceFile.getFullText();

  const isQueryHandler =
    text.includes("QueryHandler") && text.includes("IQueryHandler");
  const isCommandHandler =
    text.includes("CommandHandler") && text.includes("ICommandHandler");

  if (!isQueryHandler && !isCommandHandler) {
    return null;
  }

  let refactoredContent = text;

  const commandOrQueryMatch = text.match(
    /export\s+class\s+(\w+(?:Command|Query))\s+extends\s+(?:Command|Query)/
  );
  const commandOrQueryName = commandOrQueryMatch
    ? commandOrQueryMatch[1]
    : "CommandOrQuery";

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
      refactoredContent = refactoredContent.replace(
        new RegExp(
          `import\\s+\\{[\\s\\n]*${importName}[\\s\\n]*\\}\\s+from\\s+['"][^'"]*['"][\\s\\n]*`,
          "g"
        ),
        ""
      );
      refactoredContent = refactoredContent.replace(
        new RegExp(
          `import\\s+\\{[\\s\\n]*(?:[^}]*?,\\s*${importName}|${importName},\\s*[^}]*)[\\s\\n]*\\}\\s+from\\s+['"][^'"]*['"][\\s\\n]*`,
          "g"
        ),
        (match: string) => {
          let cleanedImport = match.replace(
            new RegExp(`,\\s*${importName}|${importName}\\s*,`),
            ""
          );
          cleanedImport = cleanedImport.replace(/\s*,\s*}/g, " }");
          cleanedImport = cleanedImport.replace(/{\s*}/g, "");
          return cleanedImport.includes("{ }") ? "" : cleanedImport;
        }
      );
    }
  });

  refactoredContent = refactoredContent.replace(
    /import\s+\{\s*HttpStatus,\s*Inject,\s*Injectable,\s*Type\s*\}\s+from\s+['"][^'"]*['"][\s\n]*/g,
    "import { HttpStatus, Inject, Injectable } from '@nestjs/common'\n"
  );

  const importLines = refactoredContent.split("\n");
  let lastImportIndex = -1;
  const newImports: string[] = [
    "import { IUseCase } from '@common/domain/usecase'",
  ];

  if (text.includes("failure(") && text.includes("ok(")) {
    newImports.push(
      `import { ${resultFailure}, ${resultOk} } from '@common/domain'`
    );
  } else {
    if (text.includes("failure(")) {
      newImports.push(`import { ${resultFailure} } from '@common/domain'`);
    }
    if (text.includes("ok(")) {
      newImports.push(`import { ${resultOk} } from '@common/domain'`);
    }
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
    refactoredContent = importLines.join("\n");
  }

  refactoredContent = refactoredContent.replace(
    /export\s+class\s+(\w+(?:Command|Query))\s+extends\s+(?:Command|Query)\s+implements\s+(\w+)\s*\{/g,
    "export class $1 implements $2 {"
  );

  refactoredContent = refactoredContent.replace(
    /export\s+class\s+(\w+(?:Command|Query))\s+extends\s+(?:Command|Query)\s*\{/g,
    "export class $1 {"
  );

  refactoredContent = refactoredContent.replace(
    /constructor\(([^)]*)\)\s*\{\s*super\([^)]*\)\s*([^}]*)\}/g,
    function (_: string, params: string, body: string) {
      const cleanedBody = body.trim() ? `\n    ${body.trim()}\n  ` : "\n  ";
      return `constructor(${params}) {${cleanedBody}}`;
    }
  );

  refactoredContent = refactoredContent.replace(
    /export\s+class\s+(\w+)(?:Query|Command)Handler/g,
    "export class $1UseCase"
  );

  refactoredContent = refactoredContent.replace(
    /implements\s+I(?:Query|Command)Handler<([^,]+),\s*([^>]+)>/g,
    "implements IUseCase<$1, $2>"
  );

  refactoredContent = refactoredContent.replace(
    /get\s+(?:query|command)\(\):\s*Type<(?:Query|Command)>\s*\{\s*return\s+\w+(?:Query|Command)\s*\}\s*/g,
    ""
  );

  refactoredContent = refactoredContent.replace(
    /async\s+execute\(([^)]*)\):\s*Promise<Either<([^,]+),\s*ICoreError>>\s*\{/g,
    function (_: string, params: string, returnType: string) {
      return `async execute(${params}): Promise<${returnType}> {`;
    }
  );

  if (text.includes("failure(")) {
    refactoredContent = refactoredContent.replace(
      /return\s+failure\(/g,
      `return ${resultFailure}(`
    );
  }

  if (text.includes("ok(")) {
    refactoredContent = refactoredContent.replace(
      /return\s+ok\(/g,
      `return ${resultOk}(`
    );
  }

  refactoredContent = refactoredContent.replace(/\n\s*\n\s*\n/g, "\n\n");
  refactoredContent = refactoredContent.replace(/^\s*\n/gm, "");

  return refactoredContent;
}

/** Helpers shared by commands **/

function getBaseNameFromTypeArg(typeNode: TypeNode): string | null {
  // Pick<PostBase, ...> OR Omit<PostBase, ...> OR wrappers like Readonly<T>
  if (typeNode.getKind() === SyntaxKind.TypeReference) {
    const tr = typeNode as TypeReferenceNode;

    const name = tr.getTypeName().getText(); // "PostBase", "Readonly", etc.
    const targs = tr.getTypeArguments();

    // Unwrap simple wrappers
    if (
      (name === "Readonly" || name === "Partial" || name === "Required") &&
      targs.length
    ) {
      return getBaseNameFromTypeArg(targs[0]);
    }

    // Qualified names yield "ns.PostBase" – keep as-is; we strip to last segment on lookup
    return name;
  }

  // Fallback
  return typeNode.getText() || null;
}

function extractStringLiteralKeys(typeNode: TypeNode): string[] {
  // 'a' | 'b' | 'c'
  if (typeNode.getKind() === SyntaxKind.UnionType) {
    const ut = typeNode as UnionTypeNode;
    const out: string[] = [];
    for (const t of ut.getTypeNodes()) out.push(...extractStringLiteralKeys(t));
    return out;
  }

  // 'a'
  if (typeNode.getKind() === SyntaxKind.LiteralType) {
    const lt = typeNode as LiteralTypeNode;
    const lit = lt.getLiteral();
    if (lit && lit.getKind() === SyntaxKind.StringLiteral) {
      return [(lit as StringLiteral).getLiteralText()];
    }
  }

  // Single string literal node form
  if (typeNode.getKind() === SyntaxKind.StringLiteral) {
    return [(typeNode as unknown as StringLiteral).getLiteralText()];
  }

  return [];
}

function getPropsFromDecl(
  decl: InterfaceDeclaration | TypeAliasDeclaration
): { name: string; type: string; isOptional: boolean }[] {
  // Interface
  if (decl.isKind(SyntaxKind.InterfaceDeclaration)) {
    return decl.getProperties().map((p) => ({
      name: p.getName(),
      type: getPropTypeFast(p),
      isOptional: p.hasQuestionToken(),
    }));
  }

  // Type alias – if it's a type literal (object)
  const tn = decl.getTypeNode();
  if (tn?.isKind(SyntaxKind.TypeLiteral)) {
    const members = tn.getMembers();
    return members
      .filter((m) => m.isKind(SyntaxKind.PropertySignature))
      .map(
        (m) =>
          ({
            name: (m as PropertySignature).getName(),
            type: getPropTypeFast(m as PropertySignature),
            isOptional: (m as PropertySignature).hasQuestionToken(),
          } as { name: string; type: string; isOptional: boolean })
      );
  }

  // Fallback: use checker
  try {
    return decl
      .getType()
      .getProperties()
      .map((sym) => {
        const name = sym.getName();
        let type = "any";
        let isOptional = false;
        const decls = sym.getDeclarations();
        const d0 = decls && decls[0];

        if (d0 && d0.isKind(SyntaxKind.PropertySignature)) {
          type = getPropTypeFast(d0 as PropertySignature);
          isOptional = (d0 as PropertySignature).hasQuestionToken();
        } else {
          try {
            type = sym.getTypeAtLocation(decl).getText();
          } catch {
            // keep defaults
          }
        }
        return { name, type, isOptional };
      });
  } catch {
    return [];
  }
}

const normalizePrimitives = (txt: string) =>
  txt
    .replace(/\bString\b/g, "string")
    .replace(/\bNumber\b/g, "number")
    .replace(/\bBoolean\b/g, "boolean")
    .replace(/\bSymbol\b/g, "symbol")
    .replace(/\bBigInt\b/g, "bigint")
    .replace(/import\("[^"]+"\)\./g, ""); // Strip import("...").
export function deactivate() {}
