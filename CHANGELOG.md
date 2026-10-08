# Changelog

> Previously published as `ai-matey-middleware-andbox`, last unscoped version `0.1.1`.

## 0.0.5 (2026-10-08)

- Add `test/real-andbox.test.mjs` (#12): 15 tests against the real
  `@johnhenry/andbox` (now a devDependency), covering tool calls through
  `host.call`, python-style blocks, errors with partial output, the capability
  gate (undeclared and prototype-chain names), `policy.limits.maxCalls`,
  `sandboxScope` `'conversation'`/`'turn'`, `resetSandbox()` disposal, timeouts
  with recovery, and pre-built sandboxes. andbox runs under plain Node via
  `node:worker_threads` since 0.0.4, so no browser is needed.
- Fix `AGENTS.md`, which claimed all suites ran against a real sandbox: it now
  says which suites use the real andbox and which use fakes.
- Peer range raised to `@johnhenry/andbox >=0.1.0` (the 2026-10 security
  release: capability gate hardening, deny-by-default remote
  `sandboxImport()`, worker globals removed, abortable capability calls).
  README's Security model updated to match.

## 0.0.4 (2026-10-07)

- Add `sandboxScope: 'conversation' | 'turn'` and `middleware.resetSandbox()`
  (#13). With the `createSandbox` factory the sandbox is created once and
  cached, so andbox's per-sandbox limits such as `policy.limits.maxCalls`
  accumulated across the whole conversation, not per turn. The default stays
  `'conversation'` (behaviour unchanged). `'turn'` creates a fresh sandbox for
  each `after()` call that has code to run and disposes it afterwards, so
  limits apply per turn; it requires the factory (a pre-built `sandbox` cannot
  be recreated, so that combination throws). `resetSandbox()` disposes the
  cached sandbox so the next turn starts on a fresh one; it is a no-op before
  first use and under `'turn'`, and rejects for a pre-built `sandbox`. README
  documents that limits are per sandbox and the sandbox is cached. Types
  updated. Tests use a fake andbox that enforces `maxCalls` per sandbox
  (the real one needs a `Worker`, which Node does not provide).

## 0.0.3 (2026-09-27)

- Repoint the `andbox` peer dependency at `@johnhenry/andbox` (`>=0.0.1`),
  matching andbox's own adoption into the `@johnhenry` npm scope
  (johnhenry/andbox#2), now that `@johnhenry/andbox` is actually published to
  npm. Verified the API this middleware calls (`createSandbox({ capabilities,
  onConsole })` returning `Promise<{ evaluate, ... }>`, `sandbox.evaluate(code,
  { timeoutMs, onConsole })`, `host.call()`) is unchanged across
  `@johnhenry/andbox` 0.0.1-0.0.3 -- this is a rename, not an API migration.
  Sweeps README/JSDoc install and import examples to match.

## 0.0.2 (2026-09-26)

- Fix: the `0.0.1` fix for the double-dollaring bug worked by having
  `adaptPythonisms` bail out of rewriting *the entire code block* as soon
  as it saw a pre-existing `${` anywhere in it, on the theory that any
  `${` meant the block already contained a real JS template literal that
  must not be touched again. That's the wrong granularity: a block can
  legitimately contain *both* a real template literal *and* a separate
  Python f-string (e.g. `` const label = `${city}`; `` followed by
  `print(f"{label} is {temp} degrees")`), and bailing on the whole block
  left the f-string unrewritten too -- trading the old silently-wrong
  output for a `SyntaxError` in the sandbox instead. Detection and
  rewriting now happen per string literal rather than per block: only text
  actually captured as an `f"..."`/`f'...'` f-string's contents is matched
  and rewritten (placeholder substitution happens in that same step), so a
  real backtick template literal elsewhere in the block -- including one
  with its own `${...}` -- is never scanned or touched, and no whole-block
  bail-out is needed at all. (#10)

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
