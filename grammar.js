const PREC = {
  FUNCTION: 1,    // a -> b
  PIPE: 2,        // |>, ?>
  OR: 3,          // or
  AND: 4,         // and
  COMPARE: 5,     // ==, !=, <, >, <=, >=
  CONCAT: 6,      // ++
  ADD: 7,         // +, -
  MUL: 8,         // *, /
  APPLY: 9,       // f x y
  PRIMARY: 10,    // literals, atoms
};

module.exports = grammar({
  name: "lume",

  extras: $ => [
    /\s/,
    $.comment,
  ],

  conflicts: $ => [
    [$.pattern, $._atom],
    [$.field_initializer, $.field_pattern],
    [$.record_expr, $.record_pattern],
    [$.list_expr, $.list_pattern],
    [$.type_definition],
    [$._type_primary, $.type_apply],
    [$.variant],
    [$.field_access, $.identifier],
    [$.match_expression],
  ],

  word: $ => $.identifier,

  rules: {
    program: $ => seq(
      repeat($.use_declaration),
      repeat(choice($.type_definition, $.binding)),
      $._expression
    ),

    comment: $ => /--.*/,

    use_declaration: $ => seq(
      "use",
      choice(
        seq(field("alias", $.identifier), "="),
        seq(field("pattern", $.record_pattern), "=")
      ),
      field("path", $.string)
    ),

    type_definition: $ => seq(
      "type",
      field("name", $.type_identifier),
      repeat($.identifier),
      "=",
      repeat1(seq("|", $.variant))
    ),

    variant: $ => seq(
      field("name", $.type_identifier),
      optional($.record_type)
    ),

    binding: $ => seq(
      "let",
      field("pattern", $.pattern),
      optional(seq(":", $.type)),
      "=",
      field("body", $._expression)
    ),

    _expression: $ => choice(
      $.lambda,
      $.match_expression,
      $._expression_inner
    ),

    lambda: $ => prec(PREC.FUNCTION, seq(
      $.pattern,
      "->",
      $._expression
    )),

    match_expression: $ => repeat1(
      prec.right(PREC.FUNCTION, seq("|", $.pattern, optional($.guard), "->", $._expression))
    ),

    guard: $ => seq("if", $._expression),

    _expression_inner: $ => choice(
      $.pipe_expression,
      $.binary_expression,
      $.apply,
      $.record_expr,
      $._atom
    ),

    pipe_expression: $ => choice(
      prec.left(PREC.PIPE, seq($._expression_inner, "|>", $._expression_inner)),
      prec.left(PREC.PIPE, seq($._expression_inner, "?>", $._expression_inner))
    ),

    binary_expression: $ => choice(
      prec.left(PREC.OR,      seq($._expression_inner, "or",  $._expression_inner)),
      prec.left(PREC.AND,     seq($._expression_inner, "and", $._expression_inner)),
      prec.left(PREC.COMPARE, seq($._expression_inner, "==",  $._expression_inner)),
      prec.left(PREC.COMPARE, seq($._expression_inner, "!=",  $._expression_inner)),
      prec.left(PREC.COMPARE, seq($._expression_inner, "<",   $._expression_inner)),
      prec.left(PREC.COMPARE, seq($._expression_inner, ">",   $._expression_inner)),
      prec.left(PREC.COMPARE, seq($._expression_inner, "<=",  $._expression_inner)),
      prec.left(PREC.COMPARE, seq($._expression_inner, ">=",  $._expression_inner)),
      prec.left(PREC.CONCAT,  seq($._expression_inner, "++",  $._expression_inner)),
      prec.left(PREC.ADD,     seq($._expression_inner, "+",   $._expression_inner)),
      prec.left(PREC.ADD,     seq($._expression_inner, "-",   $._expression_inner)),
      prec.left(PREC.MUL,     seq($._expression_inner, "*",   $._expression_inner)),
      prec.left(PREC.MUL,     seq($._expression_inner, "/",   $._expression_inner)),
    ),

    apply: $ => prec(PREC.APPLY, seq(
      $._atom,
      repeat1($._atom)
    )),

    _atom: $ => choice(
      $.field_access,
      $.identifier,
      $.type_identifier,
      $.number,
      $.string,
      $.bool,
      $.list_expr,
      $.if_expr,
      seq("(", $._expression, ")")
    ),

    field_access: $ => prec.left(PREC.PRIMARY, seq(
      choice($.identifier, $.type_identifier, seq("(", $._expression, ")")),
      repeat1(seq(".", $.identifier))
    )),

    if_expr: $ => seq(
      "if", $._expression,
      "then", $._expression,
      "else", $._expression
    ),

    record_expr: $ => seq(
      "{",
      optional(choice(
        seq($._expression, "|", $.record_fields),
        $.record_fields
      )),
      "}"
    ),

    record_fields: $ => seq(
      $.field_initializer,
      repeat(seq(",", $.field_initializer)),
      optional(seq(",", "..", optional($.identifier)))
    ),

    field_initializer: $ => seq(
      $.identifier,
      optional(seq(":", $._expression))
    ),

    list_expr: $ => seq(
      "[",
      optional(seq(
        $._expression,
        repeat(seq(",", $._expression))
      )),
      "]"
    ),

    pattern: $ => choice(
      "_",
      $.identifier,
      prec(2, seq($.type_identifier, optional($.pattern))),
      $.record_pattern,
      $.list_pattern,
      $.number,
      $.string,
      $.bool
    ),

    record_pattern: $ => seq(
      "{",
      optional(seq(
        $.field_pattern,
        repeat(seq(",", $.field_pattern)),
        optional(seq(",", "..", optional($.identifier)))
      )),
      "}"
    ),

    field_pattern: $ => seq(
      $.identifier,
      optional(seq(":", $.pattern))
    ),

    list_pattern: $ => seq(
      "[",
      optional(seq(
        $.pattern,
        repeat(seq(",", $.pattern)),
        optional(seq(",", "..", optional($.identifier)))
      )),
      "]"
    ),

    type: $ => choice(
      $.type_function,
      $.type_apply,
      $._type_primary
    ),

    type_function: $ => prec.right(PREC.FUNCTION, seq($.type, "->", $.type)),

    type_apply: $ => prec(PREC.APPLY, seq($.type_identifier, repeat1($._type_primary))),

    _type_primary: $ => choice(
      $.type_identifier,
      $.identifier,
      $.record_type,
      seq("(", $.type, ")")
    ),

    record_type: $ => seq(
      "{",
      optional(seq(
        $.field_type,
        repeat(seq(",", $.field_type)),
        optional(seq(",", ".."))
      )),
      "}"
    ),

    field_type: $ => seq(
      $.identifier,
      ":",
      $.type
    ),

    identifier: $ => /[a-z][a-zA-Z0-9_]*/,
    type_identifier: $ => /[A-Z][a-zA-Z0-9]*/,
    number: $ => /[0-9]+(?:\.[0-9]+)?/,
    string: $ => /"([^"\\]|\\.)*"/,
    bool: $ => choice("true", "false"),
  }
});
