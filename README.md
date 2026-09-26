# @johnhenry/aimatey-middleware-andbox

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-middleware-andbox.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-middleware-andbox)
[![CI](https://github.com/johnhenry/aimatey-middleware-andbox/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/aimatey-middleware-andbox/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-middleware-andbox.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/aimatey-middleware-andbox](https://opensource.johnhenry.me/aimatey-middleware-andbox/)

> **Note:** Previously published as `ai-matey-middleware-andbox@0.1.1`.

[aimatey](https://github.com/johnhenry/aimatey) middleware for code-based tool execution via the [andbox](https://github.com/johnhenry/andbox) sandbox.

LLMs that don't support native tool calling can still use tools by writing code. This middleware intercepts LLM responses, extracts fenced code blocks, adapts common Python-isms to JavaScript, and executes them in a sandboxed environment with tool stubs injected as callable functions.

## Contents

- [Install](#install)
- [Usage](#usage)
- [Using with an aimatey Bridge](#using-with-an-aimatey-bridge)
- [API](#api)
- [Security model](#security-model)
- [Family](#family)
- [License](#license)

## Install

```bash
npm install @johnhenry/aimatey-middleware-andbox
```

**Peer dependency:** This package requires `andbox` to be installed separately:

```bash
npm install andbox
```

TypeScript type declarations (`src/index.d.ts`) ship with the package --
no `@types/*` install or local shims needed.

## Usage

andbox only accepts `capabilities` (the functions reachable from sandboxed
code via `host.call(name, ...)`) at `createSandbox({ capabilities })` time --
there is no way to attach them later. So this middleware needs *either* the
andbox `createSandbox` factory itself (and it will create the sandbox for
you, wired to your tools), *or* an already-built sandbox that you created
with the capabilities already set. The factory form is recommended:

```js
import { createCodeExecutionMiddleware } from '@johnhenry/aimatey-middleware-andbox';
import { createSandbox } from 'andbox';

const tools = [
  { name: 'fetch_data', description: 'Fetch data from a URL', parameters: { url: { type: 'string' } } },
  { name: 'save_file', description: 'Save content to a file', parameters: { path: { type: 'string' }, content: { type: 'string' } } },
];

const middleware = createCodeExecutionMiddleware({
  createSandbox,       // andbox's factory -- the middleware calls this itself
  tools,
  executeToolFn: async (name, params) => {
    // Route to your actual tool implementations
    console.log(`Executing tool: ${name}`, params);
    return { success: true, output: 'done' };
  },
  maxResultLength: 4096,
  timeoutMs: 30000,
});

// Use with aimatey
// bridge.use(middleware);
```

If you need full control over the sandbox (custom `importMap`, `policy`,
`onConsole`, etc.), build it yourself with `toolsToCapabilities()` and pass
the instance as `sandbox` instead -- the middleware will use it as-is and
will **not** be able to add capabilities to it later:

```js
import { createCodeExecutionMiddleware, toolsToCapabilities } from '@johnhenry/aimatey-middleware-andbox';
import { createSandbox } from 'andbox';

const executeToolFn = async (name, params) => ({ success: true });
const sandbox = await createSandbox({
  capabilities: toolsToCapabilities(tools, executeToolFn),
  policy: { limits: { maxCalls: 50 } },
});

const middleware = createCodeExecutionMiddleware({ sandbox, tools, executeToolFn });
```

Note: andbox's own `createSandbox()` returns a `Promise<Sandbox>`, not a
`Sandbox` -- always `await` it (or pass the bare factory as the
`createSandbox` option above and let this middleware await it for you).

## Using with an aimatey Bridge

`createCodeExecutionMiddleware()` returns a plain `{ after(response) }`
object that reads/writes `response.content` directly -- it is **not**
itself an aimatey-core `bridge.use()` middleware function. `bridge.use()`
expects `(context, next) => Promise<IRChatResponse>`, `context` has no
response field (only `.request`/`.backend`/`.state`/etc.), and the
response text produced by the rest of the chain lives at
`response.message.content` (a `string`, or an array of content blocks
where text blocks are `{ type: 'text', text }`) -- returned by `await
next()`, not read off `context`.

A small adapter bridges the two shapes:

```js
function adaptAfterMiddleware(oldMiddleware) {
  return async function legacyAfterAdapter(context, next) {
    const response = await next();
    const text = typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    const result = await oldMiddleware.after({ content: text });
    return { ...response, message: { ...response.message, content: result.content } };
  };
}

bridge.use(adaptAfterMiddleware(middleware), { name: 'andbox' });
```

This keeps `createCodeExecutionMiddleware()` itself free of any dependency
on aimatey-core's specific `context`/`IRChatResponse` shapes (per the
[Family](#family) section below) while still giving you a drop-in for
`bridge.use()`. If you need `_codeResults`/`_toolCalls`/`_resultSummary`
downstream, read them off `result` in the adapter above instead of
discarding it.

## API

### `createCodeExecutionMiddleware(options)`

Creates an aimatey middleware object with an `after` hook.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `createSandbox` | `(opts) => Sandbox \| Promise<Sandbox>` | one of `createSandbox`/`sandbox` required | andbox's `createSandbox` factory. The middleware creates (and caches) the sandbox itself, with capabilities wired from `tools`/`executeToolFn`. |
| `sandbox` | `Sandbox` | one of `createSandbox`/`sandbox` required | A pre-built andbox sandbox instance. Must already have been created with `capabilities: toolsToCapabilities(tools, executeToolFn)` -- capabilities cannot be added after creation. |
| `sandboxOptions` | `object` | `{}` | Extra options merged into `createSandbox()` when using the `createSandbox` factory (e.g. `importMap`, `policy`, `onConsole`). Any `capabilities` here are merged with (and can override) the tool-derived ones. |
| `tools` | `Array<{name, description?, parameters?}>` | *required* | Tool definitions |
| `executeToolFn` | `(name, params) => Promise<any>` | *required* | Function to execute tools |
| `maxResultLength` | `number` | `4096` | Max characters per result |
| `codeLanguages` | `string[]` | `['js','javascript','tool_code','python','py','']` | Languages to execute |
| `timeoutMs` | `number` | `30000` | Execution timeout in ms |

The middleware attaches the following properties to the response:

- `_codeResults` -- Array of `{code, output, error?}` for each executed
  block. `output` holds captured `console`/`print()` output; if the block
  threw, `error` is set *and* `output` still holds whatever the block
  printed before the throw, so partial output isn't lost.
- `_toolCalls` -- Synthetic tool call entries
- `_cleanText` -- Response text with code blocks stripped
- `_resultSummary` -- Formatted summary string

### `extractCodeBlocks(text)`

Extract fenced code blocks from text. Returns `Array<{lang, code}>`.

### `stripCodeBlocks(text)`

Remove all fenced code blocks from text.

### `adaptPythonisms(code)`

Convert Python patterns to JavaScript equivalents: `True`/`False`/`None`;
f-strings, including multiple placeholders per string and dotted/indexed
placeholders (`f"{o.city}"`, `f"{items[0]}"`); full-line `#` comments; and
simple `for x in y:` loops (rewritten to `for (const x of y) { ... }`,
brace-closed by indentation, including nested loops). A block that already
contains a real `${...}` template literal is left untouched rather than
risk rewriting it into `$${...}`.

Only expression-level and these specific statement-level Python-isms are
handled -- other Python control flow (`if`/`elif`/`else`, `while`, `def`,
list comprehensions, etc.) is **not** adapted and will raise a
`SyntaxError` in the sandbox if the model emits it. Prefer prompting the
model to emit valid JavaScript for anything beyond simple f-strings,
comments, and flat/nested `for...in` loops.

### `autoAwait(code, asyncFnPatterns?)`

Insert `await` before common async calls (`print()`, `browser_*()`, and custom patterns).

### `toolsToCapabilities(tools, executeToolFn)`

Convert tool definitions to an object of callable async functions.

### `toolsToPreamble(tools)`

Generate JavaScript code that declares function stubs for each tool.

### `formatResults(results, maxResultLength?)`

Format execution results as a summary string.

### `resultsToToolCalls(results)`

Convert results to synthetic tool call entries.

## Security model

This middleware routes LLM-authored code through andbox's Worker sandbox and
gates which host functions (`tools`) that code can call via `host.call()`.
**That capability gate is not a security boundary against adversarial LLM
output.** Read this before executing model-authored code you don't fully
trust.

**What this middleware guarantees:**

- **`executeToolFn` is correctly wired into the sandbox's capabilities.**
  `createCodeExecutionMiddleware()` converts `tools`/`executeToolFn` into
  andbox `capabilities` via `toolsToCapabilities()` -- either by building the
  sandbox itself (the `createSandbox` factory option) or by requiring a
  pre-built `sandbox` that was already created with those capabilities. There
  is no code path where `host.call('toolName', ...)` silently fails to reach
  a real tool function once the middleware is configured correctly.
- **Only the tools you declare are callable via `host.call()`.** LLM-authored
  code sees exactly the capability names derived from your `tools` array --
  nothing you didn't list is added implicitly by this middleware.
- **`maxResultLength` and `timeoutMs` bound what comes back and how long
  execution can run**, inherited from andbox's own timeout/hard-kill
  semantics (see andbox's [Security model](https://github.com/johnhenry/andbox#security-model)).

**What is still yours:**

- **The tool-capability gate is not a boundary against code that is
  deliberately trying to escape it.** andbox's own README documents
  confirmed ways sandboxed code can act outside what `capabilities` appears
  to allow -- see andbox's
  [Security model](https://github.com/johnhenry/andbox#security-model)
  section for the full, current list, in short: Worker-global APIs
  (`fetch`, `WebSocket`, `Worker`, `importScripts`, `indexedDB`) are
  directly reachable regardless of which `capabilities` you supplied, and
  `sandboxImport()` will load and execute an arbitrary remote URL. This
  middleware inherits every item on that list -- it does not add its own
  isolation layer on top of andbox's.
- **A timeout stops message delivery to a killed Worker, not an in-flight
  host-side effect a capability call already triggered.** If `executeToolFn`
  has a real side effect (a write, an API call) in flight when `timeoutMs`
  fires, that side effect still completes on the host even though the
  Worker is killed. Design `executeToolFn` implementations with real side
  effects to be idempotent and/or cancellable.
- **You still need OS-level isolation for adversarial input.** Wiring
  `executeToolFn` into the sandbox (as this package now does correctly)
  lets you *organize* which tools well-behaved LLM-generated code can call,
  and gives you andbox's timeouts/rate limits for code you already trust.
  It does **not** contain code that is deliberately trying to escape. If
  you're executing output from an untrusted or adversarial model, pair this
  middleware with OS-level isolation (a separate process/container with its
  own network and filesystem restrictions) in addition to andbox's Worker
  boundary -- do not rely on the tool-capability gate alone.

## Family

This package isn't a standalone tool -- it's the connector between two
sibling packages: an [aimatey](https://github.com/johnhenry/aimatey) bridge
middleware on one side, and the [andbox](https://github.com/johnhenry/andbox)
sandbox on the other.

- **[`@johnhenry/aimatey`](https://github.com/johnhenry/aimatey)** -- this
  package ships an aimatey middleware object (an `after` hook returned by
  `createCodeExecutionMiddleware()`) meant to be passed to `bridge.use()`.
  It depends on aimatey's middleware interface shape, **not** on any
  specific backend or frontend adapter -- any aimatey `Bridge` can use it.
- **[`@johnhenry/andbox`](https://github.com/johnhenry/andbox)** -- the
  actual code execution happens here. This package is a peer dependency
  consumer of andbox (`andbox >=0.1.1`): it calls andbox's `createSandbox()`
  factory (or accepts a pre-built sandbox) and uses `toolsToCapabilities()`
  to translate `tools`/`executeToolFn` into andbox `capabilities`. Every
  guarantee and gap in andbox's own [Security model](https://github.com/johnhenry/andbox#security-model)
  applies here unchanged -- see this README's own [Security model](#security-model)
  for how the two relate.

## License

MIT
