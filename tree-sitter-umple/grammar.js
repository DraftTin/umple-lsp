/**
 * @file Tree-sitter grammar for Umple modeling language
 * @author Umple LSP Team
 * @license MIT
 *
 * This is a simplified grammar focusing on symbol extraction for go-to-definition.
 * It parses the most common Umple constructs without trying to handle every edge case.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "umple",

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  word: ($) => $.identifier,

  rules: {
    source_file: ($) => repeat($._definition),

    _definition: ($) =>
      choice(
        $.namespace_declaration,
        $.use_statement,
        $.generate_statement,
        $.class_definition,
        $.interface_definition,
        $.trait_definition,
        $.association_definition,
        $.external_definition,
        $.enum_definition,
      ),

    // =====================
    // NAMESPACE & USE
    // =====================
    namespace_declaration: ($) =>
      seq("namespace", field("name", $.qualified_name), ";"),

    use_statement: ($) =>
      prec.right(seq("use", field("path", $.use_path), optional(";"))),

    use_path: ($) => /[a-zA-Z_][a-zA-Z0-9_.\/]*/,

    generate_statement: ($) =>
      seq("generate", field("language", $.identifier), ";"),

    // =====================
    // CLASS DEFINITION
    // =====================
    class_definition: ($) =>
      seq(
        optional(choice("abstract", "static")),
        "class",
        field("name", $.identifier),
        optional($.type_parameters),
        "{",
        repeat($._class_content),
        "}",
      ),

    _class_content: ($) =>
      choice(
        $.isa_declaration,
        $.depend_statement,
        $.singleton,
        $.attribute_declaration,
        $.constraint,
        $.association_inline,
        $.state_machine,
        $.method_declaration,
        $.before_after,
      ),

    // Constraints: [pre: condition], [name != ""], etc.
    constraint: ($) =>
      seq("[", optional(seq($.identifier, ":")), /[^\]]+/, "]", optional(";")),

    // =====================
    // INTERFACE DEFINITION
    // =====================
    interface_definition: ($) =>
      seq(
        "interface",
        field("name", $.identifier),
        "{",
        repeat(
          choice(
            $.isa_declaration,
            $.depend_statement,
            $.method_signature,
            $.const_declaration,
          ),
        ),
        "}",
      ),

    // =====================
    // TRAIT DEFINITION
    // =====================
    trait_definition: ($) =>
      seq(
        "trait",
        field("name", $.identifier),
        optional($.type_parameters),
        "{",
        repeat($._class_content),
        "}",
      ),

    // =====================
    // EXTERNAL DEFINITION
    // =====================
    external_definition: ($) =>
      seq("external", field("name", $.identifier), "{", "}"),

    // =====================
    // ENUM DEFINITION
    // =====================
    enum_definition: ($) =>
      seq(
        "enum",
        field("name", $.identifier),
        "{",
        optional(
          seq($.identifier, repeat(seq(",", $.identifier)), optional(",")),
        ),
        "}",
      ),

    // =====================
    // CLASS MEMBERS
    // =====================
    isa_declaration: ($) => seq("isA", $.type_list, ";"),

    depend_statement: ($) =>
      seq("depend", field("package", $.import_path), ";"),

    import_path: ($) =>
      /[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*(\.\*)?/,

    singleton: ($) => seq("singleton", ";"),

    // Attribute: [modifier] [Type] name [= value];
    attribute_declaration: ($) =>
      seq(
        optional($.attribute_modifier),
        optional(field("type", $.type_name)),
        field("name", $.identifier),
        optional(seq("=", $._value)),
        ";",
      ),

    const_declaration: ($) =>
      seq(
        "const",
        field("type", $.type_name),
        field("name", $.identifier),
        "=",
        $._value,
        ";",
      ),

    attribute_modifier: ($) =>
      choice(
        "lazy",
        "settable",
        "internal",
        "defaulted",
        "immutable",
        "autounique",
        "unique",
        "const",
      ),

    // =====================
    // INLINE ASSOCIATIONS
    // =====================
    association_inline: ($) =>
      seq(
        $.multiplicity,
        optional(field("left_role", $.identifier)),
        $.arrow,
        $.multiplicity,
        field("right_type", $.identifier),
        optional(field("right_role", $.identifier)),
        ";",
      ),

    multiplicity: ($) => choice("*", /\d+/, /\d+\.\.\d+/, /\d+\.\.\*/),

    arrow: ($) => choice("--", "->", "<-", "<@>-", "-<@>", ">->", "<-<"),

    // =====================
    // STANDALONE ASSOCIATIONS
    // =====================
    association_definition: ($) =>
      seq(
        "association",
        optional(field("name", $.identifier)),
        "{",
        repeat($.association_member),
        "}",
      ),

    association_member: ($) =>
      seq(
        $.multiplicity,
        field("left_type", $.identifier),
        optional(field("left_role", $.identifier)),
        $.arrow,
        $.multiplicity,
        field("right_type", $.identifier),
        optional(field("right_role", $.identifier)),
        ";",
      ),

    // =====================
    // STATE MACHINES
    // =====================
    state_machine: ($) =>
      seq(
        optional("queued"),
        optional("pooled"),
        field("name", $.identifier),
        "{",
        repeat($.state),
        "}",
      ),

    state: ($) =>
      seq(
        field("name", $.identifier),
        optional(
          seq(
            "{",
            repeat(
              choice($.transition, $.entry_exit_action, $.do_activity, $.state),
            ),
            "}",
          ),
        ),
      ),

    transition: ($) =>
      seq(
        field("event", $.event_spec),
        optional($.guard),
        "->",
        optional($.action_code),
        field("target", $.identifier),
        ";",
      ),

    event_spec: ($) =>
      seq($.identifier, optional(seq("(", optional($.param_list), ")"))),

    guard: ($) => seq("[", /[^\]]+/, "]"),

    action_code: ($) =>
      seq("/", choice(seq("{", optional($.code_content), "}"), $.identifier)),

    entry_exit_action: ($) =>
      seq(choice("entry", "exit"), "/", "{", optional($.code_content), "}"),

    do_activity: ($) => seq("do", "{", optional($.code_content), "}"),

    // =====================
    // METHODS
    // =====================
    method_declaration: ($) =>
      seq(
        optional($.visibility),
        optional("static"),
        optional(field("return_type", $.type_name)),
        field("name", $.identifier),
        "(",
        optional($.param_list),
        ")",
        optional($.identifier), // language tag
        choice(seq("{", optional($.code_content), "}"), ";"),
      ),

    method_signature: ($) =>
      seq(
        optional($.visibility),
        optional("static"),
        optional(field("return_type", $.type_name)),
        field("name", $.identifier),
        "(",
        optional($.param_list),
        ")",
        ";",
      ),

    visibility: ($) => choice("public", "private", "protected"),

    param_list: ($) => seq($.param, repeat(seq(",", $.param))),

    param: ($) => seq($.type_name, field("name", $.identifier)),

    before_after: ($) =>
      seq(
        choice("before", "after"),
        $.identifier,
        optional(seq("(", optional($.param_list), ")")),
        "{",
        optional($.code_content),
        "}",
      ),

    code_content: ($) =>
      repeat1(choice(/[^{}]+/, seq("{", optional($.code_content), "}"))),

    // =====================
    // TYPES
    // =====================
    type_name: ($) =>
      seq(
        $.qualified_name,
        optional(seq("<", $.type_list, ">")),
        optional("[]"),
      ),

    type_list: ($) => seq($.type_name, repeat(seq(",", $.type_name))),

    type_parameters: ($) =>
      seq("<", $.identifier, repeat(seq(",", $.identifier)), ">"),

    // =====================
    // VALUES
    // =====================
    _value: ($) =>
      choice(
        $.number,
        $.string_literal,
        $.boolean,
        "null",
        $.qualified_name,
        $.new_expression,
        $.code_block,
      ),

    new_expression: ($) =>
      seq("new", $.qualified_name, "(", optional($._argument_list), ")"),

    _argument_list: ($) => seq($._value, repeat(seq(",", $._value))),

    code_block: ($) => seq("{", optional($.code_content), "}"),

    // =====================
    // BASIC TOKENS
    // =====================
    qualified_name: ($) =>
      prec.left(seq($.identifier, repeat(seq(".", $.identifier)))),

    identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    number: ($) => /-?\d+(\.\d+)?/,

    string_literal: ($) => choice(/"[^"]*"/, /'[^']*'/),

    boolean: ($) => choice("true", "false"),

    // =====================
    // COMMENTS
    // =====================
    line_comment: ($) => token(seq("//", /[^\n]*/)),

    block_comment: ($) => token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),
  },
});
