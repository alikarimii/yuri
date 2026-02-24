import {
  InterfaceDeclaration,
  LiteralTypeNode,
  ParameterDeclaration,
  PropertySignature,
  SourceFile,
  StringLiteral,
  SyntaxKind,
  TypeAliasDeclaration,
  TypeNode,
  TypeReferenceNode,
  UnionTypeNode,
} from "ts-morph";
import { PropInfo, SimplePropInfo } from "../types";
import { findInterfaceOrTypeNearby } from "./resolve";

export function getPropTypeFast(
  p: PropertySignature,
  fallback = "any",
): string {
  const tn = p.getTypeNode();
  if (tn) return tn.getText();
  try {
    return p.getType().getText(p);
  } catch {
    return fallback;
  }
}

export function defaultFor(typeText: string): string {
  if (/\[\]$/.test(typeText)) return `[]`;
  if (/\bboolean\b/.test(typeText)) return `false`;
  if (/\bnumber\b/.test(typeText)) return `0`;
  if (/\bstring\b/.test(typeText)) return `''`;
  return "undefined";
}

export function getBaseNameFromTypeArg(typeNode: TypeNode): string | null {
  if (typeNode.getKind() === SyntaxKind.TypeReference) {
    const tr = typeNode as TypeReferenceNode;
    const name = tr.getTypeName().getText();
    const targs = tr.getTypeArguments();

    if (
      (name === "Readonly" || name === "Partial" || name === "Required") &&
      targs.length
    ) {
      return getBaseNameFromTypeArg(targs[0]);
    }
    return name;
  }
  return typeNode.getText() || null;
}

export function extractStringLiteralKeys(typeNode: TypeNode): string[] {
  if (typeNode.getKind() === SyntaxKind.UnionType) {
    const ut = typeNode as UnionTypeNode;
    const out: string[] = [];
    for (const t of ut.getTypeNodes()) out.push(...extractStringLiteralKeys(t));
    return out;
  }

  if (typeNode.getKind() === SyntaxKind.LiteralType) {
    const lt = typeNode as LiteralTypeNode;
    const lit = lt.getLiteral();
    if (lit && lit.getKind() === SyntaxKind.StringLiteral) {
      return [(lit as StringLiteral).getLiteralText()];
    }
  }

  if (typeNode.getKind() === SyntaxKind.StringLiteral) {
    return [(typeNode as unknown as StringLiteral).getLiteralText()];
  }

  return [];
}

export function getPropsFromDecl(
  decl: InterfaceDeclaration | TypeAliasDeclaration,
): PropInfo[] {
  if (decl.isKind(SyntaxKind.InterfaceDeclaration)) {
    return decl.getProperties().map((p) => ({
      name: p.getName(),
      type: getPropTypeFast(p),
      isOptional: p.hasQuestionToken(),
    }));
  }

  const tn = decl.getTypeNode();
  if (tn?.isKind(SyntaxKind.TypeLiteral)) {
    return tn
      .getMembers()
      .filter((m) => m.isKind(SyntaxKind.PropertySignature))
      .map((m) => ({
        name: (m as PropertySignature).getName(),
        type: getPropTypeFast(m as PropertySignature),
        isOptional: (m as PropertySignature).hasQuestionToken(),
      }));
  }

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

export function getSimplePropsFromDecl(
  decl: InterfaceDeclaration | TypeAliasDeclaration,
): SimplePropInfo[] {
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

export function parsePickOmit(
  text: string,
): { kind: "pick" | "omit"; base: string; fields: string[] } | null {
  const m =
    /^\s*(Pick|Omit)\s*<\s*([A-Za-z0-9_\.]+)\s*,\s*([^>]+)\s*>\s*$/.exec(text);
  if (!m) return null;
  const kind = m[1].toLowerCase() as "pick" | "omit";
  const base = m[2];
  const fields = Array.from(m[3].matchAll(/['"]([^'"]+)['"]/g)).map((mm) =>
    mm[1].trim(),
  );
  return { kind, base, fields };
}

export async function getWantedPropsFromParamType(
  param: ParameterDeclaration,
  fromFsPath: string,
  currentSf: SourceFile,
): Promise<SimplePropInfo[]> {
  const tn = param.getTypeNode();

  if (tn?.isKind(SyntaxKind.TypeLiteral)) {
    return tn
      .getMembers()
      .filter((m) => m.isKind(SyntaxKind.PropertySignature))
      .map((m) => ({
        name: (m as any).getName(),
        optional: (m as any).hasQuestionToken?.() ?? false,
      }));
  }

  if (tn?.isKind(SyntaxKind.TypeReference)) {
    const refText = tn.getText();
    const parsed = parsePickOmit(refText);
    if (parsed) {
      const baseDecl = await findInterfaceOrTypeNearby(
        parsed.base,
        fromFsPath,
        currentSf,
      );
      if (!baseDecl) return [];
      const baseProps = getSimplePropsFromDecl(baseDecl);
      const set = new Set(parsed.fields);
      return parsed.kind === "pick"
        ? baseProps.filter((p) => set.has(p.name))
        : baseProps.filter((p) => !set.has(p.name));
    } else {
      const name = tn
        .asKindOrThrow(SyntaxKind.TypeReference)
        .getTypeName()
        .getText();
      const decl = await findInterfaceOrTypeNearby(name, fromFsPath, currentSf);
      if (!decl) return [];
      return getSimplePropsFromDecl(decl);
    }
  }

  try {
    return param
      .getType()
      .getProperties()
      .map((s) => ({ name: s.getName(), optional: false }));
  } catch {
    return [];
  }
}

export const normalizePrimitives = (txt: string) =>
  txt
    .replace(/\bString\b/g, "string")
    .replace(/\bNumber\b/g, "number")
    .replace(/\bBoolean\b/g, "boolean")
    .replace(/\bSymbol\b/g, "symbol")
    .replace(/\bBigInt\b/g, "bigint")
    .replace(/import\("[^"]+"\)\./g, "");
