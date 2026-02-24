export type ValidationMode = "strict" | "partial" | "loose";
export type HeritageKind = "pick" | "omit" | "none";
export type PropInfo = { name: string; type: string; isOptional: boolean };
export type SimplePropInfo = { name: string; optional: boolean };
