// ==============================================================================
// Lume tree-sitter grammar - annotated for learning GLR and tree-sitter
// ==============================================================================
//
// BACKGROUND: TWO PARSING PARADIGMS
// ----------------------------------
// You already know recursive-descent (RD): a hand-written parser where each
// grammar rule is a function that calls other rule-functions and returns when
// it's done. Control flow IS the grammar.
//
// Tree-sitter uses a different model:
//
//   1. You write a DECLARATIVE grammar (this file). Tree-sitter compiles it
//      into a state machine (an LR(1) automaton) at build time.
//
//   2. At parse time the automaton reads tokens one at a time and maintains a
//      stack. Each step is either:
//        SHIFT  - push the token onto the stack, move to the next state.
//        REDUCE - pop N items off the stack, combine them into a rule node,
//                 push the new node, and jump back to the state that was
//                 waiting for that rule.
//
//   3. When the automaton has two valid actions for the same (state, token)
//      pair it has a CONFLICT. Pure LR(1) parsers require every conflict to
//      be resolved deterministically (by precedence / associativity). When
//      that is impossible, tree-sitter switches to GLR mode for those states:
//      it forks the automaton, explores both paths simultaneously, and merges
//      them when they converge - or discards the path that fails.
//
// KEY DIFFERENCE FROM RECURSIVE DESCENT
// --------------------------------------
// In RD you write:  if (peek() == Token::LParen) { parseParenExpr(); }
//   - you look at the current token and decide which branch to take.
//
// In LR parsing the same decision is encoded in the state machine's action
// table. You don't "choose" - the compiler pre-computes every possible
// situation. The grammar author's job is to make the automaton's choices
// unambiguous (via precedence / conflict declarations) or to explicitly allow
// ambiguity (via the conflicts array, enabling GLR).
//
// HOW PRECEDENCE RESOLVES SHIFT/REDUCE CONFLICTS
// ------------------------------------------------
// A shift/reduce conflict: the stack already holds a complete rule A, but
// the next token could also extend a larger rule B. Should the automaton
// reduce A now, or shift the token and keep building B?
//
//   prec(N, rule)       - when reducing `rule`, use priority N.
//   prec.left(N, rule)  - when two items of priority N conflict, prefer
//                         reduce (left-associative: a op b op c -> (a op b) op c).
//   prec.right(N, rule) - when two items of priority N conflict, prefer
//                         shift  (right-associative: a op b op c -> a op (b op c)).
//
// Higher N wins: shift beats reduce when the shift's rule has higher N.
// When N is equal: left -> reduce wins; right -> shift wins.
//
// NAMED RULES vs INLINE RULES (_prefix)
// --------------------------------------
// Named rules (e.g. `apply`, `binary_expr`) create a node in the syntax tree.
// Inline rules (e.g. `_expr`, `_atom`) are "transparent": they are expanded
// in-place and leave no node. They act purely as grammar structuring helpers.
// This is analogous to a private helper method in an RD parser that calls
// other methods but doesn't build its own AST node.
//
// FIELDS
// ------
// `field("name", rule)` attaches a semantic label to a child node. In an RD
// parser this corresponds to storing the result of a sub-parse in a named
// variable: `let body = parseExpr();`. Fields make the tree queryable by name
// (e.g. in tree-sitter queries or the LSP).

// ==============================================================================
// PRECEDENCE TABLE
// ==============================================================================
//
// This table encodes Lume's operator precedence - the same information an RD
// parser encodes implicitly through call depth (deeper calls bind tighter).
//
// In RD you write:
//   parseMul()  { left = parseAtom(); while (*/) left = Mul(left, parseAtom()); }
//   parseAdd()  { left = parseMul();  while (+/-)  left = Add(left, parseMul());  }
// The nesting depth of parseAtom < parseMul < parseAdd mirrors the table below
// in reverse: higher N = tighter binding = called deepest in RD.
const PREC = {
	FUNCTION: 1, // ->  lowest, loosest binding, right-associative
	PIPE: 2, // |>, ?>
	OR: 3, // ||
	AND: 4, // &&
	COMPARE: 5, // ==, !=, <, >, <=, >=
	CONCAT: 6, // ++
	ADD: 7, // +, -
	MUL: 8, // *, /
	APPLY: 9, // f x y  - tighter than all binary operators
	FIELD: 10, // a.b.c  - tightest, so f a.b parses as f (a.b) not (f a).b
};

module.exports = grammar({
	name: "lume",

	// ==========================================================================
	// KEYWORD EXTRACTION  (word)
	// ==========================================================================
	//
	// Problem: the identifier regex /[a-z][a-zA-Z0-9_]*/ would match reserved
	// words like "let", "if", "then", "else", "or", "and", "true", "false".
	//
	// `word` tells tree-sitter which rule is the language's "word" token. The
	// compiler then gives every string literal that could match the word pattern
	// (e.g. "let", "if") HIGHER lexer priority than the word rule itself. So
	// "let" always lexes as keyword-let, never as identifier.
	//
	// In an RD parser you handle this manually: after reading an identifier you
	// check `if (text == "let") return Token::Let;`. tree-sitter automates this.
	word: ($) => $.identifier,

	// ==========================================================================
	// EXTRAS - tokens that may appear anywhere
	// ==========================================================================
	//
	// Whitespace and comments are valid between any two tokens. In RD you call
	// `skipWhitespace()` at the start of every rule or in the lexer. In
	// tree-sitter `extras` registers patterns that the automaton silently
	// consumes (and attaches as children) at any point.
	extras: ($) => [/\s/, $.comment],

	// ==========================================================================
	// CONFLICTS - where GLR is required
	// ==========================================================================
	//
	// Each entry [A, B] (or [A] for a self-conflict) tells tree-sitter: "in the
	// state where both A and B could be reduced, don't error - fork the
	// automaton and pursue both in parallel."
	//
	// An RD parser handles the same situations with explicit lookahead: you peek
	// N tokens ahead and choose a branch. GLR instead keeps all branches alive
	// simultaneously and prunes the ones that fail later.
	//
	// Rule of thumb: you need a GLR conflict declaration whenever two grammar
	// rules share the same prefix AND there is no single token that resolves the
	// ambiguity before the prefix is fully consumed.
	conflicts: ($) => [
		// -- pattern vs _atom ---------------------------------------------------
		// `identifier`, `number`, `string`, `bool`, and `TypeIdent` all appear in
		// both `pattern` and `_atom`. When the parser sees `n ->`, it cannot know
		// until it reaches `->` whether `n` is a lambda pattern or an expression.
		// GLR forks: one branch assumes pattern (for lambda), one assumes atom
		// (for an expression). The branch that reaches `->` in a valid state wins.
		[$.pattern, $._atom],

		// -- record_pattern vs record_expr -------------------------------------
		// Both start with `{`. An RD parser would peek at the character after the
		// closing `}`: if `->` follows, it was a pattern; otherwise an expression.
		// GLR forks immediately at `{` and resolves when `->` appears or not.
		[$.record_pattern, $.record_expr],

		// -- list_pattern vs list_expr -----------------------------------------
		// Same situation for `[`.
		[$.list_pattern, $.list_expr],

		// -- field_pattern vs field_initializer --------------------------------
		// Both are `identifier optional(":" something)`. Inside `{...}` the parser
		// cannot know whether it's destructuring (field_pattern) or construction
		// (field_initializer) until it sees `->` or not after the enclosing `}`.
		[$.field_pattern, $.field_initializer],

		// -- type_definition self-conflict -------------------------------------
		// `type Foo = | A | B` - after seeing `| A`, should the repeat1 continue
		// (another variant) or is the type definition done? The GLR fork keeps
		// both; the one where `| B` is also a valid variant wins.
		[$.type_definition],

		// -- variant self-conflict ---------------------------------------------
		// A variant may optionally carry a record_type payload: `Circle { r: Num }`.
		// When the parser sees `TypeIdent` it forks: one branch tries to consume
		// `{ ... }` as the payload, one stops. Whichever fits the surrounding rule
		// wins.
		[$.variant],

		// -- _atom vs variant_expr ---------------------------------------------
		// `TypeIdent` can end an `_atom` (type_identifier) OR be the start of a
		// `variant_expr` (TypeIdent followed by `{ ... }`). The fork resolves on the
		// next token: if `{` arrives, variant_expr wins; otherwise type_identifier.
		[$._atom, $.variant_expr],

		// -- match_expr self-conflict -------------------------------------------
		// After an arm body, `|` can mean:
		//   (a) another arm of the CURRENT match_expr (sibling)
		//   (b) another arm of an OUTER match_expr (return to parent)
		//
		// GLR forks both. `prec.right(PREC.FUNCTION)` on match_arm makes the
		// automaton prefer to SHIFT (greedy inner) when priorities tie, mirroring
		// the RD parser's "consume as much as possible inside the current rule"
		// behaviour. This is the declarative grammar's equivalent of the RD
		// parser's greedy while-loop.
		[$.match_expr],

		// -- match_in_expr self-conflict ----------------------------------------
		// Same greedy arm-accumulation as match_expr, but for the `match x in`
		// form. After each arm body, `|` is shifted into the match_in_expr rather
		// than returned to the outer context.
		[$.match_in_expr],

		// -- constraint_list vs paren_type -------------------------------------
		// `( TypeIdent identifier )` is ambiguous: it could be a single-constraint
		// list `(Trait a)` (if `=>` follows) or a parenthesised type `(List a)`
		// (if `->` or another type-level token follows). GLR forks at `(` and
		// resolves on the token after `)`: `=>` → constraint_list wins; anything
		// else → paren_type wins.
		// The secondary conflict between `constraint` and `type_apply` handles
		// the inner `TypeIdent identifier` sequence, which is valid in both rules.
		[$.constraint_list, $.paren_type],
		[$.constraint, $._type_primary],
	],

	rules: {
		// ========================================================================
		// TOP LEVEL
		// ========================================================================
		//
		// In RD: parseProgram() { while(use) parseUse(); while(let|type) ...; optional(pub expr); }
		// In LR: `repeat` compiles to a loop in the state machine: when the next
		// token cannot start a use_declaration, exit the loop and try the next
		// alternative. Because `let`, `type`, and `pub` are unambiguous start
		// tokens here, no conflict arises.
		// All top-level items in one flat repeat: use_declaration, type_definition,
		// trait_definition, impl_definition, and binding can appear in any order.
		// After `use`, the second token disambiguates deterministically: an
		// uppercase TypeIdent → impl_definition; lowercase ident or `{` →
		// use_declaration. All other item-starting tokens are unique keywords.
		program: ($) =>
			seq(
				repeat(
					choice(
						$.use_declaration,
						$.type_definition,
						$.trait_definition,
						$.impl_definition,
						$.binding,
					),
				),
				optional(seq("pub", $._expr)),
			),

		// The comment rule is a regex terminal - the lexer matches it greedily
		// (longest match). Because comment is in `extras`, the automaton eats
		// comments between any two tokens without any grammar rule needing to
		// account for them.
		comment: ($) => /--.*/,

		// ========================================================================
		// DECLARATIONS
		// ========================================================================

		use_declaration: ($) =>
			seq(
				"use",
				// choice() here is a lexical choice: `{` vs identifier start. The lexer
				// resolves this with one token of lookahead - no conflict needed.
				choice(
					seq(field("alias", $.identifier), "="),
					seq(field("pattern", $.record_pattern), "="),
				),
				field("path", $.string),
			),

		type_definition: ($) =>
			seq(
				"type",
				field("name", $.type_identifier),
				// Type parameters are lowercase identifiers: `type List a = ...`
				// repeat() here is unambiguous because `=` terminates parameters and
				// cannot be an identifier.
				repeat(field("param", $.identifier)),
				"=",
				// The first `|` pipe is optional: `type Foo = Bar | Baz` and
				// `type Foo = | Bar | Baz` are both valid. The type_definition
				// self-conflict declared above handles GLR forking for the optional
				// trailing structure.
				optional("|"),
				field("variant", $.variant),
				repeat(seq("|", field("variant", $.variant))),
			),

		// A variant is a TypeIdent with an optional record_type payload.
		// `[$.variant]` in conflicts allows GLR to fork on whether `{` starts a
		// payload or belongs to something following the type definition.
		variant: ($) =>
			seq(
				field("name", $.type_identifier),
				optional(field("fields", $.record_type)),
			),

		binding: ($) =>
			seq(
				"let",
				field("pattern", $.pattern),
				// `:` signals a type annotation. The type annotation may be prefixed
				// with a constraint list: `(ToText a, ToText b) => a -> b -> Text`.
				// After `(`, GLR forks: one branch tries constraint_list (resolved
				// if `=>` follows `)`) and one tries paren_type. The
				// [$.constraint_list, $.paren_type] conflict handles this.
				optional(seq(
					":",
					optional(seq(field("constraints", $.constraint_list), "=>")),
					field("type", $.type),
				)),
				"=",
				field("body", $._expr),
				// Optional `and let …` continuations for mutually recursive groups.
				// `and` cannot start any other top-level form, so the shift here is
				// always unambiguous — no GLR conflict needed.
				repeat(seq(
					"and",
					"let",
					field("pattern", $.pattern),
					optional(seq(":", field("type", $.type))),
					"=",
					field("body", $._expr),
				)),
			),

		// ========================================================================
		// TRAIT AND IMPL DEFINITIONS
		// ========================================================================

		// `trait Name a { let method : type }` — declares a typeclass interface.
		// The body is a sequence of method signatures, each starting with `let`.
		// `trait` is a keyword (word extraction applies automatically).
		trait_definition: ($) =>
			seq(
				"trait",
				field("name", $.type_identifier),
				field("param", $.identifier),
				"{",
				repeat($.trait_method),
				"}",
			),

		// A trait method signature: `let toText : a -> Text`
		// Optional trailing comma allows both comma-separated and whitespace-
		// separated styles inside the trait body.
		trait_method: ($) =>
			seq(
				"let",
				field("name", $.identifier),
				":",
				field("type", $.type),
				optional(","),
			),

		// `use Trait in Type { let method = expr }` — provides a trait instance.
		// Disambiguated from use_declaration by the uppercase TypeIdent after `use`.
		impl_definition: ($) =>
			seq(
				"use",
				field("trait", $.type_identifier),
				"in",
				field("type_name", $.type_identifier),
				"{",
				repeat($.impl_method),
				"}",
			),

		// An impl method: `let name = body` or `let name : Type = body`.
		// The optional type annotation matches the explicit-annotation form.
		impl_method: ($) =>
			seq(
				"let",
				field("name", $.identifier),
				optional(seq(":", field("type", $.type))),
				"=",
				field("body", $._expr),
				optional(","),
			),

		// `let pattern (: type)? = value in body` — expression-level let binding.
		// Unlike top-level `binding`, this requires the `in` keyword and produces
		// a value. Chaining is natural: `let x = 1 in let y = 2 in x + y`.
		// `let` is a keyword so it cannot appear in `pattern` or `_atom`, meaning
		// no GLR conflict with lambda or _atom arises here.
		let_in_expr: ($) =>
			seq(
				"let",
				field("pattern", $.pattern),
				optional(seq(":", field("type", $.type))),
				"=",
				field("value", $._expr),
				"in",
				field("body", $._expr),
			),

		// ========================================================================
		// EXPRESSIONS
		// ========================================================================
		//
		// _expr is INLINE (leading _). It creates no AST node - it is purely a
		// structural helper that expands wherever it is referenced.
		//
		// Compare to RD where you'd write:
		//   Expr parseExpr() {
		//     if (peek() == '|') return parseMatchExpr();
		//     if (isPatternStart() && peekAhead("->")) return parseLambda();
		//     return parseBinaryExpr();
		//   }
		//
		// In tree-sitter you write the same three choices; the LR automaton works
		// out the distinction from the token stream. The GLR [$.pattern, $._atom]
		// conflict handles the lambda/expression ambiguity for the first two cases.
		_expr: ($) => choice($.let_in_expr, $.lambda, $.match_expr, $.match_in_expr, $._binary_expr),

		// -- Match-in expression -----------------------------------------------
		//
		// `match scrutinee in | pat -> body | pat -> body`
		// An explicit scrutinee version of match. The keyword `match` unambiguously
		// starts the rule, and `in` separates the scrutinee from the arms.
		// The scrutinee uses $._binary_expr (no lambdas) to avoid ambiguity with
		// the `in` keyword that follows.
		// The [$.match_in_expr] self-conflict + prec.right on match_arm give the
		// same greedy arm-accumulation as match_expr.
		match_in_expr: ($) =>
			seq(
				"match",
				field("scrutinee", $._binary_expr),
				"in",
				repeat1($.match_arm),
			),

		// -- Lambda -----------------------------------------------------------
		//
		// RD equivalent:
		//   Lambda parseLambda() { pat = parsePattern(); expect("->"); body = parseExpr(); }
		//
		// prec.right(PREC.FUNCTION) encodes two things:
		//   1. Priority 1 (lowest non-zero): lambda binds more loosely than every
		//      operator, so `x -> a + b` parses as `x -> (a + b)`, not `(x -> a) + b`.
		//   2. Right-associativity: `x -> y -> z` parses as `x -> (y -> z)`.
		//      When two FUNCTION-priority rules conflict (the `->` of the inner
		//      lambda vs the `->` of the outer), prec.right says SHIFT - consume
		//      the inner `->` first, building the right branch before the left.
		lambda: ($) =>
			prec.right(
				PREC.FUNCTION,
				seq(field("param", $.pattern), "->", field("body", $._expr)),
			),

		// -- Match expression --------------------------------------------------
		//
		// A match_expr is just a sequence of arms - no enclosing keyword or
		// delimiter. This is unusual for LR grammars because without a sentinel
		// the automaton cannot know when the sequence ends.
		//
		// The [$.match_expr] self-conflict + prec.right on match_arm together
		// implement the greedy strategy: when `|` appears after an arm body,
		// SHIFT it (add it to the current match_expr) rather than reducing the
		// match_expr and returning to the enclosing rule. This is the declarative
		// equivalent of an RD while-loop that keeps running as long as `|` appears.
		//
		// In RD:
		//   MatchExpr parseMatchExpr() {
		//     arms = [];
		//     while (peek() == '|') arms.push(parseArm());
		//     return arms;
		//   }
		// The while-loop naturally greedy - it never "gives back" a `|` to the
		// caller. prec.right achieves the same effect in the LR automaton.
		match_expr: ($) => repeat1($.match_arm),

		match_arm: ($) =>
			prec.right(
				PREC.FUNCTION,
				seq(
					"|",
					field("pattern", $.pattern),
					optional(field("guard", $.guard)),
					"->",
					field("body", $._expr),
					// The body is $._expr, which includes match_expr. So an arm's body can
					// itself be a nested match:
					//   | f -> | Circle -> ...   <- body of the `f` arm is an inner match
					//          | Rect   -> ...
					// Because match_arm has prec.right(PREC.FUNCTION), when the automaton
					// sees `|` after the body, SHIFT wins - `| Circle` and `| Rect` are
					// consumed as arms of the INNER match, not returned to the outer one.
				),
			),

		guard: ($) => seq("if", $._binary_expr),

		// -- Binary expression hierarchy ---------------------------------------
		//
		// _binary_expr is INLINE. It is the grammar's analogue of the RD call
		// chain: parsePipe -> parseOr -> parseAnd -> ... -> parseApply -> parseAtom.
		//
		// In RD each level is a separate function; deeper = tighter binding.
		// In LR the levels are encoded by precedence numbers in PREC. Higher N =
		// tighter binding = reduces before (wins over) lower-N operators.
		//
		// The key difference: in RD the call chain is FIXED at parse time. In LR
		// the automaton dynamically resolves which operator to apply based on
		// precedence numbers, allowing all operators to live in one flat set of
		// rules rather than nested function calls.
		_binary_expr: ($) =>
			choice($.pipe_expr, $.binary_expr, $.apply, $.record_expr, $._atom),

		// -- Pipe operators ----------------------------------------------------
		//
		// prec.left(PREC.PIPE): pipe is left-associative (priority 2).
		// `a |> f |> g` -> `(a |> f) |> g`.
		// When two PIPE items conflict: prefer REDUCE (left side is already done).
		pipe_expr: ($) =>
			choice(
				prec.left(
					PREC.PIPE,
					seq(
						field("left", $._binary_expr),
						"|>",
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.PIPE,
					seq(
						field("left", $._binary_expr),
						"?>",
						field("right", $._binary_expr),
					),
				),
			),

		// -- Arithmetic / logic operators --------------------------------------
		//
		// All alternatives live in one named rule `binary_expr`. That single rule
		// produces a single AST node type regardless of which operator was used;
		// the operator itself is captured as the `op` field child.
		//
		// Each alternative gets its own prec.left(N, ...). When two operators of
		// DIFFERENT priority compete (e.g. `+` vs `*` in `a + b * c`), the higher
		// priority wins: MUL=8 beats ADD=7, so `*` reduces first -> `a + (b * c)`.
		//
		// When two operators of the SAME priority compete (e.g. `a + b + c`),
		// prec.left says reduce the left one first -> `(a + b) + c`.
		binary_expr: ($) =>
			choice(
				prec.left(
					PREC.OR,
					seq(
						field("left", $._binary_expr),
						field("op", "||"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.AND,
					seq(
						field("left", $._binary_expr),
						field("op", "&&"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.COMPARE,
					seq(
						field("left", $._binary_expr),
						field("op", "=="),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.COMPARE,
					seq(
						field("left", $._binary_expr),
						field("op", "!="),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.COMPARE,
					seq(
						field("left", $._binary_expr),
						field("op", "<"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.COMPARE,
					seq(
						field("left", $._binary_expr),
						field("op", ">"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.COMPARE,
					seq(
						field("left", $._binary_expr),
						field("op", "<="),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.COMPARE,
					seq(
						field("left", $._binary_expr),
						field("op", ">="),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.CONCAT,
					seq(
						field("left", $._binary_expr),
						field("op", "++"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.ADD,
					seq(
						field("left", $._binary_expr),
						field("op", "+"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.ADD,
					seq(
						field("left", $._binary_expr),
						field("op", "-"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.MUL,
					seq(
						field("left", $._binary_expr),
						field("op", "*"),
						field("right", $._binary_expr),
					),
				),
				prec.left(
					PREC.MUL,
					seq(
						field("left", $._binary_expr),
						field("op", "/"),
						field("right", $._binary_expr),
					),
				),
			),

		// -- Function application -----------------------------------------------
		//
		// This is the most important rule in the grammar. Read carefully.
		//
		// WHAT WE WANT: `f x y z` -> apply(apply(apply(f, x), y), z)
		// Also: `f { x: 1 }` -> apply(f, record_expr)
		//
		// NAIVE APPROACH (broken):
		//   apply: $ => seq($._atom, repeat1($._atom))
		//
		//   This creates a single parser state that loops inside repeat1. In that
		//   state only _atom tokens are valid. The automaton's keyword extraction
		//   only prevents `let` from lexing as `identifier` in states where BOTH
		//   `let` (keyword) and `identifier` are valid tokens. Inside the repeat1
		//   state only `identifier` is expected, so `let` was silently consumed as
		//   an identifier atom - eating the next binding into the current apply.
		//
		// CORRECT APPROACH (this):
		//   apply: $ => prec.left(PREC.APPLY, seq(
		//     choice($.apply, $._atom),              <- left-recursive
		//     choice($._atom, $.record_expr)
		//   ))
		//
		//   This generates two LR productions:
		//     apply -> apply  atom    (A1: extend an existing apply)
		//     apply -> atom   atom    (A2: start a new apply from two atoms)
		//
		//   Trace for `fold 0 (acc -> ...) xs`:
		//     1. Shift `fold` as atom.
		//     2. Shift `0` as atom. Reduce by A2 -> apply(fold, 0).
		//     3. Now in state: apply -> apply -  <- item A1 is waiting.
		//        Next token: `(`. Item A1 says "shift an atom". `(` starts
		//        paren_expr which is an atom. Shift.
		//     4. Parse paren_expr. Reduce by A1 -> apply(apply(fold,0), paren_expr).
		//     5. `xs` -> atom. Reduce by A1 -> apply(apply(apply(...),paren_expr), xs).
		//     6. Next token: `\n` then `let`. `let` is NOT an atom (keyword
		//        extraction works here because the state also expects `let` as a
		//        binding start). apply stops. OK
		//
		//   The crucial difference: after each reduction to `apply`, the automaton
		//   is in a fresh LR state where BOTH atom tokens AND `let`/`type` keywords
		//   are valid lookahead. Keyword extraction now correctly prevents `let`
		//   from being consumed as an atom.
		//
		//   prec.left(PREC.APPLY) resolves the shift/reduce conflict at each step:
		//     - Shift (consume next atom into apply):  priority APPLY = 9
		//     - Reduce (stop apply, propagate upward): priority of surrounding rule
		//   For surrounding binary operators (priority <= MUL=8 < APPLY=9), shift
		//   wins - application binds tighter than all operators.
		//   For surrounding apply itself (priority APPLY=9), prec.left says
		//   reduce - giving left-associativity: (f x) y, not f (x y).
		apply: ($) =>
			prec.left(
				PREC.APPLY,
				seq(
					field("function", choice($.apply, $._atom)),
					field("argument", choice($._atom, $.record_expr)),
				),
			),

		// ========================================================================
		// ATOMS - primary / non-operator expressions
		// ========================================================================
		//
		// _atom is INLINE. It enumerates almost every expression form that can
		// appear as a function argument without parentheses. record_expr remains
		// intentionally OUTSIDE _atom, but apply explicitly accepts it as a direct
		// argument. `{` is therefore not a general atom start, but it is allowed
		// in the specific `f { ... }` application shape.
		_atom: ($) =>
			choice(
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

		// -- Field access -----------------------------------------------------
		//
		// prec.left(PREC.FIELD=10): tighter than apply (9), so `f a.b` parses as
		// `f (a.b)` not `(f a).b`. The `.` token is unambiguous in the lexer
		// (not used anywhere else), so no conflict is needed - the shift is always
		// the only valid action when `.` appears after an identifier.
		field_access: ($) =>
			prec.left(
				PREC.FIELD,
				seq(
					choice($.identifier, $.type_identifier, $.paren_expr),
					repeat1(seq(".", $.identifier)),
				),
			),

		// -- Variant construction ---------------------------------------------
		//
		// `Some { value: x }` - a TypeIdent immediately followed by a record_expr.
		// This is the only way `{` can appear inside an atom. The [$._atom,
		// $.variant_expr] GLR conflict allows the automaton to fork when it sees
		// TypeIdent: one branch tries to extend to variant_expr (shifts `{`), the
		// other immediately reduces to type_identifier. If `{` arrives, variant_expr
		// wins; otherwise type_identifier wins.
		//
		// Bare constructors (None, A, B, Fail) are just type_identifier atoms.
		variant_expr: ($) =>
			seq(field("name", $.type_identifier), field("fields", $.record_expr)),

		// paren_expr has no explicit prec annotation because parentheses are
		// self-delimiting: `(` and `)` bracket the content completely, leaving no
		// ambiguity about where the expression ends.
		paren_expr: ($) => seq("(", $._expr, ")"),

		// -- If-then-else -----------------------------------------------------
		//
		// if_expr is in _atom, so `f if a then b else c` is a valid apply without
		// parens - the same as the RD parser's can_start_atom including Token::If.
		//
		// The condition uses $._binary_expr (no lambdas/matches in conditions).
		// The branches use $._expr (lambdas and nested ifs are valid branch bodies).
		//
		// Nested-if disambiguation: because `else` is mandatory, there is no
		// "dangling else" problem. Every `if` owns exactly one `then` and one
		// `else`. Nested `if a then if b then x else y else z` resolves
		// unambiguously: `else y` closes the inner if, `else z` closes the outer.
		// No prec annotation is needed - the grammar structure itself is enough.
		if_expr: ($) =>
			seq(
				"if",
				field("condition", $._binary_expr),
				"then",
				field("then", $._expr),
				"else",
				field("else", $._expr),
			),

		list_expr: ($) =>
			seq(
				"[",
				optional(
					seq(
						$._expr,
						repeat(seq(",", $._expr)),
						optional(","), // trailing comma allowed
					),
				),
				"]",
			),

		// -- Record expression -------------------------------------------------
		//
		// record_expr lives in _binary_expr, NOT in _atom. Consequence:
		//   `{ pi, abs }` at end of a module -> valid standalone _binary_expr. OK
		//   `f { x: 1 }` -> `f` is apply function, `{` can't be an atom argument.
		//                   The apply ends at `f`. Then `{ x: 1 }` is a separate
		//                   _binary_expr at the enclosing level. OK
		//
		// The update syntax `{ base | field: val }` uses $._binary_expr for the
		// base (not $._expr) to prevent ambiguity: if base were $._expr, a lambda
		// `x -> y | fields` would be ambiguous - is `|` a pipe-like or a record
		// separator? Restricting base to _binary_expr (no lambdas) removes the
		// ambiguity.
		record_expr: ($) =>
			seq(
				"{",
				optional(
					choice(
						seq(
							field("base", $._binary_expr),
							"|",
							field("fields", $.record_fields),
						),
						field("fields", $.record_fields),
					),
				),
				"}",
			),

		// record_fields allows:
		//   { a, b, c }         - plain fields
		//   { a, b, c, }        - trailing comma (common in multi-line records)
		//   { a, b, ..rest }    - named spread
		//   { a, b, .. }        - anonymous spread
		record_fields: ($) =>
			seq(
				$.field_initializer,
				repeat(seq(",", $.field_initializer)),
				optional(
					choice(
						seq(",", "..", optional($.identifier)), // spread
						",", // trailing comma only
					),
				),
			),

		// field_initializer: `name` (shorthand) or `name: value` (explicit).
		// The name can be a lowercase identifier OR an uppercase type_identifier
		// (for constructor shorthand: `pub { Circle }` exports the constructor).
		// The [$.field_pattern, $.field_initializer] GLR conflict arises because
		// both share the `identifier optional(":" ...)` prefix - the difference is
		// only resolved when we know whether we're inside a record_pattern or a
		// record_expr, which depends on whether `->` follows the enclosing `{...}`.
		field_initializer: ($) =>
			seq(
				field("name", choice($.identifier, $.type_identifier)),
				optional(seq(":", field("value", $._expr))),
			),

		// ========================================================================
		// PATTERNS
		// ========================================================================
		//
		// Patterns appear in three positions: lambda params, match arms, and let
		// bindings. They look identical to expressions for literals/identifiers,
		// which is why [$.pattern, $._atom] requires GLR.

		pattern: ($) =>
			choice(
				// `_` is a string literal, not a regex. The word: identifier declaration
				// ensures `_` never matches the identifier rule (which requires [a-z]
				// start). The automaton lexes `_` as the literal token `"_"` directly.
				"_",
				$.identifier,

				// TypeIdent with optional sub-pattern. prec(2) gives this alternative
				// higher priority (2 > default 0) so that when seeing `Some x`, the
				// automaton prefers `TypeIdent pattern` over the alternative of treating
				// `Some` and `x` as two separate atoms.
				prec(
					2,
					seq(
						field("name", $.type_identifier),
						optional(field("arg", $.pattern)),
					),
				),

				$.record_pattern,
				$.list_pattern,
				$.number,
				$.string,
				$.bool,
			),

		// Record and list patterns use `..` for rest-capture: `{ a, b, ..rest }`
		// or `[x, y, ..rest]`. The `..` token is unambiguous - it appears only in
		// spread positions. Note there is no trailing-comma variant here; pattern
		// spread is always at the end of the list, separated by `,`.
		record_pattern: ($) =>
			seq(
				"{",
				optional(
					seq(
						$.field_pattern,
						repeat(seq(",", $.field_pattern)),
						optional(seq(",", "..", optional($.identifier))),
					),
				),
				"}",
			),

		// field_pattern: destructuring field — `name` or `name: pattern`.
		// The name can be a lowercase identifier OR an uppercase type_identifier
		// to support module imports like `use { Shape, Circle } = "path"` where
		// constructors/types are also valid field names.
		field_pattern: ($) =>
			seq(
				field("name", choice($.identifier, $.type_identifier)),
				optional(seq(":", field("pattern", $.pattern))),
			),

		list_pattern: ($) =>
			seq(
				"[",
				optional(
					seq(
						$.pattern,
						repeat(seq(",", $.pattern)),
						optional(seq(",", "..", optional($.identifier))),
					),
				),
				"]",
			),

		// ========================================================================
		// CONSTRAINT ANNOTATIONS
		// ========================================================================
		//
		// `(ToText a, ToText b)` — a parenthesised list of trait constraints, each
		// being a TypeIdent applied to a type variable identifier.
		// The [$.constraint_list, $.paren_type] GLR conflict resolves `(Trait a)`
		// as a constraint_list when followed by `=>`, or as a paren_type otherwise.

		constraint_list: ($) =>
			seq(
				"(",
				$.constraint,
				repeat(seq(",", $.constraint)),
				")",
			),

		// A single constraint: `TraitName typeVar`, e.g. `ToText a`.
		constraint: ($) =>
			seq(
				field("trait", $.type_identifier),
				field("var", $.identifier),
			),

		// ========================================================================
		// TYPES
		// ========================================================================
		//
		// Types form their own mini expression language: function types, applied
		// types, and primary types. The structure mirrors expressions but is
		// simpler (no binary operators, no function application in the curried
		// sense). The same precedence machinery (prec.right, prec.left) applies.

		type: ($) => choice($.type_function, $.type_apply, $._type_primary),

		// `A -> B -> C` -> `A -> (B -> C)` - right-associative, same as lambda.
		// prec.right(PREC.FUNCTION) resolves the same shift/reduce conflict as for
		// lambda: when we have `A ->` and see `B`, shift (keep building the chain)
		// rather than reduce (stop at `A`).
		type_function: ($) =>
			prec.right(
				PREC.FUNCTION,
				seq(field("param", $.type), "->", field("return", $.type)),
			),

		// `List Num` -> type_apply(List, [Num]).
		// prec.left(PREC.APPLY) gives type application the same tight binding as
		// value-level application, so `List Num -> Bool` parses as
		// `(List Num) -> Bool`, not `List (Num -> Bool)`.
		//
		// Note: type_apply uses repeat1 rather than left-recursion because type
		// application is always headed by a TypeIdent (capital letter) - there is
		// no ambiguity with keywords. The repeat1 loop never accidentally absorbs
		// keywords because `->` (a non-identifier token) terminates the loop
		// deterministically. This is safe precisely because type expressions have
		// a much simpler token set than value expressions.
		type_apply: ($) =>
			prec.left(
				PREC.APPLY,
				seq(
					field("name", $.type_identifier),
					repeat1(field("arg", $._type_primary)),
				),
			),

		// _type_primary is INLINE. It lists the "atom" level of types.
		// Lowercase identifiers here are type variables (e.g. `a` in `List a`).
		// paren_type is factored out as a named rule so that the GLR conflict
		// [$.constraint_list, $.paren_type] can reference it.
		_type_primary: ($) =>
			choice(
				$.type_identifier,
				$.identifier,
				$.record_type,
				$.paren_type,
			),

		// Parenthesised type: `(A -> B)`, `(List Num)`, etc.
		// Named (not inline) so it can be referenced in the GLR conflict with
		// constraint_list to resolve `(TypeIdent identifier)` ambiguity.
		paren_type: ($) => seq("(", $.type, ")"),

		// Record types use the same `{...}` syntax as record expressions and
		// patterns but appear only in type position. Because types have their own
		// grammar namespace (`type` vs `_expr`), there is no cross-context
		// ambiguity - a `{` inside a type annotation is unambiguously record_type.
		record_type: ($) =>
			seq(
				"{",
				optional(
					seq(
						$.field_type,
						repeat(seq(",", $.field_type)),
						optional(","), // trailing comma for consistency
					),
				),
				"}",
			),

		field_type: ($) =>
			seq(field("name", $.identifier), ":", field("type", $.type)),

		// ========================================================================
		// TERMINALS - the leaves of the grammar
		// ========================================================================
		//
		// Terminal rules are matched by the LEXER (not the parser). The lexer runs
		// before the parser, splitting raw text into tokens. In tree-sitter the
		// lexer is also compiled from the grammar; regex terminals become DFA
		// states in the lexer automaton.
		//
		// Longest-match rule: the lexer always takes the longest possible token.
		// `identifier` matches `foldLeft` in one token, not `fold` + `Left`.
		//
		// Keyword priority (from `word: $ => $.identifier`): any string literal
		// that could match the identifier pattern gets higher lexer priority, so
		// "let", "if", "true", "and", etc. are always keywords, never identifiers.

		// Lowercase identifiers: value names, type variables, field names.
		identifier: ($) => /[a-z][a-zA-Z0-9_]*/,

		// UpperCamelCase: type names, variant constructors.
		type_identifier: ($) => /[A-Z][a-zA-Z0-9]*/,

		// Numbers: integer or decimal. No leading-zero restriction.
		number: ($) => /[0-9]+(?:\.[0-9]+)?/,

		// Strings: double-quoted, with backslash escapes.
		string: ($) => /"([^"\\]|\\.)*"/,

		// bool is defined as a choice of two string literals. Because `word` makes
		// all string literals take priority over the identifier pattern, `true` and
		// `false` are always lexed as `bool` tokens, never as identifiers - even
		// though they match /[a-z][a-zA-Z0-9_]*/.
		bool: ($) => choice("true", "false"),
	},
});
