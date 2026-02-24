# Yuri - TypeScript Toolbox

A VS Code extension that generates classes, factories, and view interfaces from TypeScript interfaces and type aliases. Supports Pick/Omit heritage, optional/excluded field syntax in view schemas, and more.

## Features

### Generate Class from Interface / Type

Place your cursor on an `interface` or `type` declaration and trigger the code action. Yuri generates an implementing class with readonly properties and a constructor.

- Resolves `Pick<Base, 'a' | 'b'>` and `Omit<Base, 'a'>` heritage automatically
- Works across files (follows relative imports)

### Generate Factory from Interface / Type

Generates a factory function that returns a frozen object implementing the interface or type.

### Generate View Interfaces

Define a `_viewSchemas` object alongside your interface to generate multiple lightweight view interfaces from a single source.

```ts
const _viewSchemas = {
  feed: ["id", "title", "text"],
  home: ["id", "title", "?text", "images"],
  profile: ["id", "title", "text", "images", "author.!id", "author.?name"],
};

interface _Post {
  id: string;
  title: string;
  text: string;
  images: string[];
  author: { id: string; name: string };
}
```

**Field syntax:**

| Syntax          | Meaning                              | Example          |
| --------------- | ------------------------------------ | ---------------- |
| `field`         | Include top-level field              | `"title"`        |
| `?field`        | Include as optional                  | `"?text"`        |
| `parent.child`  | Include nested field                 | `"author.name"`  |
| `parent.?child` | Include nested field as optional     | `"author.?name"` |
| `parent.!child` | Include parent object, exclude child | `"author.!id"`   |

**Validation modes** (`yuri.generateViewInterfaces.validationMode`):

- `strict` — skip view if any field is invalid
- `partial` — generate with valid fields only, warn about invalid ones
- `loose` — generate all, only require parent to exist

### Sync Class with Interface

Updates an existing class to match its implemented interface — adds missing property declarations and constructor assignments.

### Add Missing Constructor Properties

Place cursor on a `new Foo({...})` expression and Yuri fills in missing properties from the constructor parameter type (supports Pick/Omit).

### Add Readonly to Class Properties

Adds the `readonly` modifier to all properties of the class at cursor.

### Add Getters (Aggregate pattern)

For classes extending `Aggregate<Props>`, generates getter methods for all props.

### Create Index File

Right-click a folder in the explorer → **Create index.ts and export all**. Generates an `index.ts` that re-exports every `.ts` file in the folder.

## Configuration

| Setting                                       | Type    | Default                       | Description                                           |
| --------------------------------------------- | ------- | ----------------------------- | ----------------------------------------------------- |
| `yuri.generateClass.inNewFile`                | boolean | `false`                       | Generate class in a new file or inline                |
| `yuri.generateClass.classNameSuffix`          | string  | `"Impl"`                      | Suffix appended to generated class names              |
| `yuri.generateViewInterfaces.inNewFile`       | boolean | `false`                       | Generate view interfaces in a new file or inline      |
| `yuri.generateViewInterfaces.validationMode`  | string  | `"partial"`                   | Validation mode: `strict`, `partial`, or `loose`      |
| `yuri.generateViewInterfaces.interfaceSuffix` | string  | `"ViewModel"`                 | Suffix for generated view interface names             |
| `yuri.generateFactory.inNewFile`              | boolean | `false`                       | Generate factory in a new file or inline              |
| `yuri.generateFactory.functionPrefix`         | string  | `"create"`                    | Prefix for generated factory function names           |
| `yuri.generateFactory.stripSuffixRegex`       | string  | `"(ViewModel\|View\|Props)$"` | Regex to strip from type name when naming the factory |

## Install

1. Install `vsce`: `npm install -g @vscode/vsce`
2. Package: `vsce package`
3. In VS Code, open the Extensions panel → **…** → **Install from VSIX** → select the `.vsix` file
