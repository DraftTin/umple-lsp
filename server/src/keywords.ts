/**
 * Context-specific completion keywords for tree-sitter based completions.
 * Keys match CompletionContext values from symbolIndex.ts.
 */
export const COMPLETION_KEYWORDS = {
  // Top-level definitions
  top: [
    "class",
    "interface",
    "trait",
    "enum",
    "association",
    "namespace",
    "generate",
    "mixset",
    "use",
    "external",
  ],

  // Inside class/trait/interface body
  class_body: [
    "isA",
    "singleton",
    "depend",
    "before",
    "after",
    // Visibility modifiers for methods
    "public",
    "private",
    "protected",
    // Other method/attribute modifiers
    "static",
    "abstract",
    "const",
  ],

  // Attribute modifiers (used in class_body context when typing attribute)
  attribute_modifiers: [
    "lazy",
    "settable",
    "internal",
    "defaulted",
    "immutable",
    "autounique",
    "unique",
    "const",
  ],

  // Common types for attribute declarations
  attribute_types: [
    "String",
    "Integer",
    "Double",
    "Float",
    "Boolean",
    "Date",
    "Time",
    "void",
  ],

  // State machine definition (outside states)
  state_machine: ["queued", "pooled"],

  // Inside a state
  state: ["entry", "exit", "do", "final", "->"],

  // Inside association block
  association: ["--", "->", "<-", "<@>-", "-<@>", ">->", "<-<"],

  // Inside enum - typically just identifiers, no keywords
  enum: [],

  // Inside method body - code completion out of scope for now
  method: [],

  // Contexts where only symbol completions are offered (no keywords)
  use_path: [],
  isa_type: [],
  transition_target: [],
  association_type: [],
  depend_package: [],
  comment: [],
  unknown: [],
};

/**
 * Legacy keyword categories (kept for backward compatibility).
 */
export const KEYWORDS = {
  topLevel: [
    "after",
    "around",
    "association",
    "associationClass",
    "class",
    "distributable",
    "filter",
    "generate",
    "interface",
    "mixset",
    "namespace",
    "statemachine",
    "strictness",
    "trait",
    "use",
    "--redefine",
  ],
  classLevel: [
    "abstract",
    "active",
    "const",
    "depend",
    "distributable",
    "emit",
    "enum",
    "inner",
    "isA",
    "key",
    "model",
    "self",
    "singleton",
    "sorted",
    "static",
  ],
  attribute: [
    "attribute",
    "attr",
    "autounique",
    "defaulted",
    "false",
    "immutable",
    "internal",
    "lazy",
    "settable",
    "true",
    "unique",
  ],
  method: [
    "public",
    "protected",
    "private",
    "static",
    "abstract",
    "pre",
    "custom",
    "generated",
    "all",
    "around_proceed",
  ],
  statemachine: [
    "after",
    "afterEvery",
    "as",
    "do",
    "entry",
    "exit",
    "final",
    "Final",
    "pooled",
    "queued",
    "statemachine",
    "unspecified",
  ],
  constraints: ["and", "not", "or"],
  modelConstraints: [
    "attribute",
    "attr",
    "has",
    "model",
    "of",
    "subclass",
    "superclass",
  ],
  tracing: [
    "add",
    "cardinality",
    "for",
    "giving",
    "remove",
    "trace",
    "tracer",
    "until",
    "where",
  ],
  testing: [
    "assertAttribute",
    "assertEqual",
    "assertFalse",
    "assertMethod",
    "assertNull",
    "assertTrue",
    "generic",
    "prefix",
    "regex",
    "suffix",
    "test",
  ],
  misc: [
    "forced",
    "hops",
    "ignore",
    "include",
    "includeFilter",
    "off",
    "RMI",
    "sub",
    "super",
    "WS",
  ],
};

export const ALL_KEYWORDS = Array.from(new Set(Object.values(KEYWORDS).flat()));
