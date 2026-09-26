# Changelog

> Previously published as `ai-matey-middleware-andbox`, last unscoped version `0.1.1`.

## 0.0.1 (2026-09-26)

Both items below surfaced from actually exercising the middleware against a
Python-flavoured LLM and a real aimatey Bridge integration -- the kind of
gaps that only show up once code stops being purely hypothetical.

- Fix: `adaptPythonisms` was only rewriting the *first* `{name}` placeholder
  in an f-string, never rewrote dotted/indexed placeholders (`{o.city}`,
  `{items[0]}`), and would double-dollar a block that already contained a
  real `${x}` template literal into `$${x}` (printing a stray `$`). All
  three are fixed: placeholder rewriting is now global per template literal
  and accepts dotted/indexed identifier chains, and a block containing
  `${` is now left untouched rather than re-adapted. Also adds narrow
  support for the two Python statement forms LLMs reach for most often:
  full-line `#` comments (`// `) and simple, possibly-nested `for x in y:`
  loops (rewritten to brace-delimited `for (const x of y) { ... }` by
  tracking indentation) -- everything else Python-shaped (`if`/`elif`,
  `while`, `def`, comprehensions, ...) is intentionally left alone and
  documented as unsupported, rather than silently mis-adapted. (#7)
- Fix: when a sandboxed code block threw, any `console`/`print()` output it
  produced *before* the throw was discarded -- `_codeResults[i].output` came
  back `''` even if the block had printed something useful for debugging
  why it failed. The captured output is now kept alongside `error` in
  `_codeResults`, `_toolCalls[i]._result`, and the `_resultSummary` string.
- Docs: the README's `createSandbox`-factory usage example and options
  table already matched 0.0.0's actual behavior (fixed under #3/#4 before
  this issue was filed against a stale published tarball) -- added an
  explicit callout that andbox's own `createSandbox()` returns a
  `Promise<Sandbox>`, plus a new "Using with an aimatey Bridge" section
  showing the small `(context, next)` adapter needed because aimatey-core's
  `bridge.use()` middleware shape doesn't match this package's
  `{ after(response) }` object (text lives at `response.message.content`
  there, not `response.content`).
- Adds hand-written `src/index.d.ts` TypeScript declarations for the full
  public API, wired via `package.json`'s `types`/`exports` fields -- no
  build step, matching the sibling `andbox` package's convention for a
  package this size. (#8)

## 0.0.0 (2026-09-21)

- Fix: `createCodeExecutionMiddleware` now actually wires `executeToolFn` into
  the sandbox's capabilities, so `host.call('toolName', ...)` from
  LLM-authored code reaches real tool functions instead of always failing
  with "Unknown capability". Adds a `createSandbox` factory option so the
  middleware can create a correctly-configured sandbox itself; a pre-built
  `sandbox` instance is still supported but must be created with
  capabilities already wired. (#3)
- Docs: corrected the README usage example (previously showed a sandbox
  created with no capabilities, which never worked) and added an honest
  "Security model" section cross-referencing andbox's own security
  documentation instead of implying the tool-capability gate is a security
  boundary.

## 0.1.0 (2026-03-15)

- Initial release
- Code block extraction from LLM responses
- Python-to-JS adaptation (True/False/None, f-strings)
- Auto-await insertion for async tool calls
- Tool-to-preamble stub generation
- Result formatting and synthetic tool call creation
- `createCodeExecutionMiddleware()` for ai.matey integration
