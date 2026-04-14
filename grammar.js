const PREC = {
  FUNCTION: 1,  // ->
  PIPE: 2,      // |>, ?>
  OR: 3,        // or
  AND: 4,       // and
  COMPARE: 5,   // ==, !=, <, >, <=, >=
  CONCAT: 6,    // ++
  ADD: 7,       // +, -
  MUL: 8,       // *, /
  APPLY: 9,     // f x y  (left-recursive)
  FIELD: 10,    // a.b.c
};

module.exports = grammar({
  name: "lume",

  word: $ => $.identifier,

  extras: $ => [/\s/, $.comment],

  conflicts: $ => [
    // GLR: identifier/literal can be either a pattern or an expression atom
    [$.pattern, $._atom],
    // GLR: { … } can be record_pattern or record_expr before -> is seen
    [$.record_pattern, $.record_expr],
    // GLR: [ … ] can be list_pattern or list_expr
    [$.list_pattern, $.list_expr],
    // GLR: `ident :` can open a field_pattern or a field_initializer
    [$.field_pattern, $.field_initializer],
    // GLR: TypeIdent optional(record_type) in a type definition
    [$.type_definition],
    // GLR: variant with optional record_type payload
    [$.variant],
    // GLR: TypeIdent alone vs TypeIdent followed by { … } (variant_expr)
    [$._atom, $.variant_expr],
    // GLR: after an arm body, | may continue the current match_expr
    // or belong to an outer one — use prec.right to prefer inner (greedy)
    [$.match_expr],
  ],

  rules: {
    program: $ => seq(
      repeat($.use_declaration),
      repeat(choice($.type_definition, $.binding)),
      $._expr,
    ),

    comment: $ => /--.*/,

    // ── Declarations ────────────────────────────────────────────────────

    use_declaration: $ => seq(
      "use",
      choice(
        seq(field("alias", $.identifier), "="),
        seq(field("pattern", $.record_pattern), "="),
      ),
      field("path", $.string),
    ),

    type_definition: $ => seq(
      "type",
      field("name", $.type_identifier),
      repeat(field("param", $.identifier)),
      "=",
      repeat1(seq("|", $.variant)),
    ),

    variant: $ => seq(
      field("name", $.type_identifier),
      optional(field("fields", $.record_type)),
    ),

    binding: $ => seq(
      "let",
      field("pattern", $.pattern),
      optional(seq(":", field("type", $.type))),
      "=",
      field("body", $._expr),
    ),

    // ── Expressions ─────────────────────────────────────────────────────

    _expr: $ => choice(
      $.lambda,
      $.match_expr,
      $._binary_expr,
    ),

    // x -> body  (right-associative: x -> y -> z = x -> (y -> z))
    lambda: $ => prec.right(PREC.FUNCTION, seq(
      field("param", $.pattern),
      "->",
      field("body", $._expr),
    )),

    // One or more | pat guard? -> body arms.
    // Arms are right-associative so an arm's body greedily captures
    // further | arms as a nested match_expr rather than as siblings.
    match_expr: $ => repeat1($.match_arm),

    match_arm: $ => prec.right(PREC.FUNCTION, seq(
      "|",
      field("pattern", $.pattern),
      optional(field("guard", $.guard)),
      "->",
      field("body", $._expr),
    )),

    guard: $ => seq("if", $._binary_expr),

    // Transparent grouping — no AST node of its own.
    _binary_expr: $ => choice(
      $.pipe_expr,
      $.binary_expr,
      $.apply,
      $.record_expr,
      $._atom,
    ),

    pipe_expr: $ => choice(
      prec.left(PREC.PIPE, seq(
        field("left", $._binary_expr), "|>", field("right", $._binary_expr),
      )),
      prec.left(PREC.PIPE, seq(
        field("left", $._binary_expr), "?>", field("right", $._binary_expr),
      )),
    ),

    binary_expr: $ => choice(
      prec.left(PREC.OR,      seq(field("left", $._binary_expr), field("op", "or"),  field("right", $._binary_expr))),
      prec.left(PREC.AND,     seq(field("left", $._binary_expr), field("op", "and"), field("right", $._binary_expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._binary_expr), field("op", "=="),  field("right", $._binary_expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._binary_expr), field("op", "!="),  field("right", $._binary_expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._binary_expr), field("op", "<"),   field("right", $._binary_expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._binary_expr), field("op", ">"),   field("right", $._binary_expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._binary_expr), field("op", "<="),  field("right", $._binary_expr))),
      prec.left(PREC.COMPARE, seq(field("left", $._binary_expr), field("op", ">="),  field("right", $._binary_expr))),
      prec.left(PREC.CONCAT,  seq(field("left", $._binary_expr), field("op", "++"),  field("right", $._binary_expr))),
      prec.left(PREC.ADD,     seq(field("left", $._binary_expr), field("op", "+"),   field("right", $._binary_expr))),
      prec.left(PREC.ADD,     seq(field("left", $._binary_expr), field("op", "-"),   field("right", $._binary_expr))),
      prec.left(PREC.MUL,     seq(field("left", $._binary_expr), field("op", "*"),   field("right", $._binary_expr))),
      prec.left(PREC.MUL,     seq(field("left", $._binary_expr), field("op", "/"),   field("right", $._binary_expr))),
    ),

    // Left-recursive application: f x y z  ≡  ((f x) y) z
    // prec.left drives shift over reduce when the next token can start an atom,
    // cleanly avoiding the repeat1 self-conflict pitfall.
    apply: $ => prec.left(PREC.APPLY, seq(
      field("function", choice($.apply, $._atom)),
      field("argument", $._atom),
    )),

    // ── Atoms ────────────────────────────────────────────────────────────

    _atom: $ => choice(
      $.field_access,
      $.variant_expr,
      $.identifier,
      $.type_identifier,
      $.number,
      $.string,
      $.bool,
      $.list_expr,
      $.if_expr,
      $.paren_expr,
    ),

    // a.b.c  (higher prec than apply so f a.b parses as f (a.b))
    field_access: $ => prec.left(PREC.FIELD, seq(
      choice($.identifier, $.type_identifier, $.paren_expr),
      repeat1(seq(".", $.identifier)),
    )),

    // Some { value: x }  — TypeIdent followed by a record payload.
    // { alone cannot start an atom (mirrors can_start_atom excluding LBrace).
    variant_expr: $ => seq(
      field("name", $.type_identifier),
      field("fields", $.record_expr),
    ),

    paren_expr: $ => seq("(", $._expr, ")"),

    if_expr: $ => seq(
      "if",   field("condition", $._binary_expr),
      "then", field("then", $._expr),
      "else", field("else", $._expr),
    ),

    list_expr: $ => seq(
      "[",
      optional(seq(
        $._expr,
        repeat(seq(",", $._expr)),
        optional(","),
      )),
      "]",
    ),

    // record_expr is NOT in _atom — { cannot start a function argument.
    // It lives in _binary_expr so it's valid as a standalone expression
    // (module-ending record) and as a lambda/binding body.
    record_expr: $ => seq(
      "{",
      optional(choice(
        seq(field("base", $._binary_expr), "|", field("fields", $.record_fields)),
        field("fields", $.record_fields),
      )),
      "}",
    ),

    record_fields: $ => seq(
      $.field_initializer,
      repeat(seq(",", $.field_initializer)),
      // Allow trailing comma or spread (", .." / ", ..name")
      optional(choice(
        seq(",", "..", optional($.identifier)),
        ",",
      )),
    ),

    field_initializer: $ => seq(
      field("name", $.identifier),
      optional(seq(":", field("value", $._expr))),
    ),

    // ── Patterns ────────────────────────────────────────────────────────

    pattern: $ => choice(
      "_",
      $.identifier,
      // TypeIdent with optional sub-pattern: None, Some x, Err { reason }
      prec(2, seq(
        field("name", $.type_identifier),
        optional(field("arg", $.pattern)),
      )),
      $.record_pattern,
      $.list_pattern,
      $.number,
      $.string,
      $.bool,
    ),

    record_pattern: $ => seq(
      "{",
      optional(seq(
        $.field_pattern,
        repeat(seq(",", $.field_pattern)),
        optional(seq(",", "..", optional($.identifier))),
      )),
      "}",
    ),

    field_pattern: $ => seq(
      field("name", $.identifier),
      optional(seq(":", field("pattern", $.pattern))),
    ),

    list_pattern: $ => seq(
      "[",
      optional(seq(
        $.pattern,
        repeat(seq(",", $.pattern)),
        optional(seq(",", "..", optional($.identifier))),
      )),
      "]",
    ),

    // ── Types ────────────────────────────────────────────────────────────

    type: $ => choice(
      $.type_function,
      $.type_apply,
      $._type_primary,
    ),

    type_function: $ => prec.right(PREC.FUNCTION, seq(
      field("param", $.type),
      "->",
      field("return", $.type),
    )),

    type_apply: $ => prec.left(PREC.APPLY, seq(
      field("name", $.type_identifier),
      repeat1(field("arg", $._type_primary)),
    )),

    _type_primary: $ => choice(
      $.type_identifier,
      $.identifier,
      $.record_type,
      seq("(", $.type, ")"),
    ),

    record_type: $ => seq(
      "{",
      optional(seq(
        $.field_type,
        repeat(seq(",", $.field_type)),
        optional(","),
      )),
      "}",
    ),

    field_type: $ => seq(
      field("name", $.identifier),
      ":",
      field("type", $.type),
    ),

    // ── Terminals ────────────────────────────────────────────────────────

    identifier:      $ => /[a-z][a-zA-Z0-9_]*/,
    type_identifier: $ => /[A-Z][a-zA-Z0-9]*/,
    number:          $ => /[0-9]+(?:\.[0-9]+)?/,
    string:          $ => /"([^"\\]|\\.)*"/,
    bool:            $ => choice("true", "false"),
  },
});
