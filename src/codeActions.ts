import * as vscode from "vscode";

/**
 * Lightweight code-action provider.
 *
 * All checks use cheap string / regex operations on the current line
 * instead of spinning up a ts-morph Project (the old code created a
 * brand-new in-memory Project on **every** cursor move).
 */
export class YuriCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Refactor,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] | undefined {
    const actions: vscode.CodeAction[] = [];
    const lineText = document.lineAt(range.start.line).text;

    // ── interface-level actions ──────────────────────────────────────
    if (/\binterface\s+\w+/.test(lineText)) {
      actions.push(
        this.action(
          "Generate Class from Interface (Yuri)",
          "yuri.generateClassFromInterface",
          [document, range],
        ),
        this.action(
          "Generate View Interfaces (Yuri)",
          "yuri.generateViewInterfaces",
          [document, range],
        ),
        this.action(
          "Generate Factory From Interfaces (Yuri)",
          "yuri.generateFactoryFromInterface",
          [document, range],
        ),
      );
    }

    // ── type-level actions ──────────────────────────────────────────
    if (/\btype\s+\w+/.test(lineText)) {
      actions.push(
        this.action(
          "Generate Class from Type (Yuri)",
          "yuri.generateClassFromType",
          [document, range],
        ),
        this.action(
          "Generate Factory From Type (Yuri)",
          "yuri.generateFactoryFromType",
          [document, range],
        ),
      );
    }

    // ── new Foo({}) → add missing props ─────────────────────────────
    if (/\bnew\s+/.test(lineText)) {
      actions.push(
        this.action(
          "Add Missing Constructor Properties (Yuri)",
          "yuri.addMissingConstructorProps",
          [document, range],
        ),
      );
    }

    // ── class implements Foo → sync ─────────────────────────────────
    if (/\bclass\s+/.test(lineText) && /\bimplements\b/.test(lineText)) {
      actions.push(
        this.action(
          "Sync Class with Interface (Yuri)",
          "yuri.syncClassWithInterfaceProps",
          [document, range],
        ),
      );
    }

    // ── class-level edits (readonly, getters) ───────────────────────
    // Use a cheap regex to detect whether the cursor is inside a class.
    const classAtCursor = this.classContainsCursor(document, range);
    if (classAtCursor) {
      actions.push(
        this.action(
          "Add readonly to Class Properties (Yuri)",
          "yuri.addReadonlyToClassProps",
          [document, range],
          vscode.CodeActionKind.Refactor,
        ),
      );

      if (/\bAggregate\s*</.test(classAtCursor)) {
        actions.push(
          this.action(
            "Add Getters to Class Properties (Yuri)",
            "yuri.addGettersToClassProps",
            [document, range],
            vscode.CodeActionKind.Refactor,
          ),
        );
      }
    }

    return actions.length ? actions : undefined;
  }

  // ── private helpers ─────────────────────────────────────────────────

  private action(
    title: string,
    command: string,
    args: unknown[],
    kind = vscode.CodeActionKind.QuickFix,
  ): vscode.CodeAction {
    const a = new vscode.CodeAction(title, kind);
    a.command = { title, command, arguments: args };
    return a;
  }

  /**
   * Walk backwards from cursor until we find a line with `class `,
   * then walk forwards to confirm the cursor is before the matching `}`.
   * Returns the class header text (for heritage checks) or null.
   */
  private classContainsCursor(
    doc: vscode.TextDocument,
    range: vscode.Range,
  ): string | null {
    const cursorLine = range.start.line;

    // Walk backwards to find the class header
    for (let i = cursorLine; i >= 0; i--) {
      const line = doc.lineAt(i).text;
      if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/.test(line)) {
        // Found a class header – now verify cursor is inside the body
        // by walking forward from the header looking for the matching '}'
        let depth = 0;
        for (let j = i; j < doc.lineCount; j++) {
          const text = doc.lineAt(j).text;
          for (const ch of text) {
            if (ch === "{") depth++;
            if (ch === "}") depth--;
          }
          if (depth <= 0) {
            // Cursor is inside this class if cursorLine <= j
            return cursorLine <= j ? line : null;
          }
        }
        return null;
      }
    }
    return null;
  }
}
