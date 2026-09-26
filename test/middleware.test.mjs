import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeBlocks, stripCodeBlocks, adaptPythonisms, autoAwait, createCodeExecutionMiddleware } from '../src/index.mjs';
import { toolsToCapabilities, toolsToPreamble } from '../src/tool-injector.mjs';
import { formatResults, resultsToToolCalls } from '../src/result-formatter.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * A minimal fake of andbox's Worker sandbox, faithful to the real
 * constraint that matters here: capabilities are only ever supplied at
 * `createSandbox({ capabilities })` time, and `host.call(name, ...)` inside
 * evaluated code can only reach whatever was captured at that point.
 */
function makeFakeAndbox() {
  const created = [];
  async function createSandbox(opts = {}) {
    const capabilities = opts.capabilities || {};
    created.push(opts);
    return {
      async evaluate(code, evalOpts = {}) {
        const host = {
          call: async (name, params) => {
            const fn = capabilities[name];
            if (!fn) throw new Error(`Unknown capability: ${name}`);
            return fn(params);
          },
        };
        const log = (...args) => evalOpts.onConsole?.('log', ...args.map(String));
        const fn = new AsyncFunction('host', 'console', `"use strict";\n${code}`);
        return fn(host, { log });
      },
      dispose: async () => {},
    };
  }
  return { createSandbox, created };
}

describe('adaptPythonisms', () => {
  it('converts True/False/None', () => {
    assert.equal(adaptPythonisms('x = True'), 'x = true');
    assert.equal(adaptPythonisms('y = False'), 'y = false');
    assert.equal(adaptPythonisms('z = None'), 'z = null');
  });

  it('converts f-strings to template literals', () => {
    assert.equal(adaptPythonisms('f"hello {name}"'), '`hello ${name}`');
  });

  // #7 (1): only the first {name} in an f-string was being rewritten.
  it('rewrites every {name} placeholder in an f-string, not just the first', () => {
    assert.equal(adaptPythonisms('f"{a} and {b}"'), '`${a} and ${b}`');
    assert.equal(adaptPythonisms('f"{a}-{b}-{c}"'), '`${a}-${b}-${c}`');
  });

  // #7 (2): dotted/indexed names inside {...} were never rewritten at all.
  it('rewrites dotted and indexed placeholders like {o.city} and {items[0]}', () => {
    assert.equal(adaptPythonisms('f"{o.city}"'), '`${o.city}`');
    assert.equal(adaptPythonisms('f"{items[0]}"'), '`${items[0]}`');
    assert.equal(adaptPythonisms('f"{o.items[0].name}"'), '`${o.items[0].name}`');
  });

  // #7 (3): a block that already contains a real ${x} template literal was
  // getting double-dollared into $${x}, printing a stray "$".
  it('leaves a block that already contains ${...} untouched instead of double-dollaring it', () => {
    const code = 'const x = 1;\nconsole.log(`value: ${x}`);';
    assert.equal(adaptPythonisms(code), code);
    assert.ok(!adaptPythonisms(code).includes('$${'));
  });

  // #7 (4): `#` comments and `for x in y:` loops were left as Python
  // syntax, causing a SyntaxError in the sandbox.
  it('converts full-line `#` comments to `//`', () => {
    assert.equal(adaptPythonisms('# a comment\nx = 1'), '// a comment\nx = 1');
  });

  it('converts simple `for x in y:` loops to JS for-of loops with braces', () => {
    const python = 'for x in items:\n    print(x)\nprint("done")';
    const js = adaptPythonisms(python);
    assert.equal(
      js,
      'for (const x of items) {\n    print(x)\n}\nprint("done")'
    );
  });

  it('closes nested `for x in y:` loops at the right indentation', () => {
    const python = 'for x in a:\n  for y in b:\n    print(x, y)\n  print(x)\nprint("end")';
    const js = adaptPythonisms(python);
    assert.equal(
      js,
      'for (const x of a) {\n  for (const y of b) {\n    print(x, y)\n  }\n  print(x)\n}\nprint("end")'
    );
  });
});

describe('autoAwait', () => {
  it('adds await before print()', () => {
    const result = autoAwait('print("hi")');
    assert.ok(result.includes('await print'));
  });

  it('does not double-await', () => {
    const result = autoAwait('await print("hi")');
    assert.ok(!result.includes('await await'));
  });

  it('adds await before browser_ calls', () => {
    const result = autoAwait('browser_fetch({url: "x"})');
    assert.ok(result.includes('await browser_fetch'));
  });
});

describe('toolsToCapabilities', () => {
  it('creates callable capabilities from tools', async () => {
    const tools = [{ name: 'add', description: 'Add numbers' }];
    const executeFn = async (name, params) => params.a + params.b;
    const caps = toolsToCapabilities(tools, executeFn);
    assert.equal(typeof caps.add, 'function');
    assert.equal(await caps.add({ a: 2, b: 3 }), 5);
  });
});

describe('toolsToPreamble', () => {
  it('generates function stubs', () => {
    const tools = [{ name: 'fetch_data' }, { name: 'save_file' }];
    const preamble = toolsToPreamble(tools);
    assert.ok(preamble.includes('async function fetch_data'));
    assert.ok(preamble.includes('async function save_file'));
    assert.ok(preamble.includes('async function print'));
  });
});

describe('formatResults', () => {
  it('formats successful results', () => {
    const results = [{ code: '1+1', output: '2' }];
    const formatted = formatResults(results);
    assert.ok(formatted.includes('Result: 2'));
  });

  it('formats errors', () => {
    const results = [{ code: 'bad()', output: '', error: 'ReferenceError' }];
    const formatted = formatResults(results);
    assert.ok(formatted.includes('error'));
    assert.ok(formatted.includes('ReferenceError'));
  });

  // #8 (2): console output printed before a throw was being discarded from
  // the formatted summary along with the raw result.
  it('keeps partial output alongside the error message', () => {
    const results = [{ code: 'print("step 1"); bad()', output: 'step 1', error: 'ReferenceError: bad is not defined' }];
    const formatted = formatResults(results);
    assert.ok(formatted.includes('step 1'));
    assert.ok(formatted.includes('ReferenceError: bad is not defined'));
  });

  it('labels multiple blocks', () => {
    const results = [
      { code: 'a()', output: '1' },
      { code: 'b()', output: '2' },
    ];
    const formatted = formatResults(results);
    assert.ok(formatted.includes('Block 1'));
    assert.ok(formatted.includes('Block 2'));
  });

  it('truncates long results', () => {
    const longOutput = 'x'.repeat(5000);
    const results = [{ code: 'x', output: longOutput }];
    const formatted = formatResults(results, 100);
    assert.ok(formatted.length < longOutput.length);
    assert.ok(formatted.includes('truncated'));
  });
});

describe('resultsToToolCalls', () => {
  it('creates tool call entries', () => {
    const results = [{ code: '1+1', output: '2' }];
    const calls = resultsToToolCalls(results);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, '_code_exec');
    assert.ok(calls[0]._result.success);
    assert.equal(calls[0]._result.output, '2');
  });

  // #8 (2): the synthetic tool call's _result used to hardcode output: ''
  // on error, throwing away whatever the block printed before it threw.
  it('carries partial output through on error', () => {
    const results = [{ code: 'print("partial"); bad()', output: 'partial', error: 'ReferenceError' }];
    const calls = resultsToToolCalls(results);
    assert.equal(calls[0]._result.success, false);
    assert.equal(calls[0]._result.output, 'partial');
    assert.equal(calls[0]._result.error, 'ReferenceError');
  });
});

describe('createCodeExecutionMiddleware', () => {
  it('wires executeToolFn into the sandbox so host.call() reaches the real tool function', async () => {
    const { createSandbox, created } = makeFakeAndbox();
    const calls = [];
    const executeToolFn = async (name, params) => {
      calls.push({ name, params });
      return { sum: params.a + params.b };
    };

    const middleware = createCodeExecutionMiddleware({
      createSandbox,
      tools: [{ name: 'add', description: 'Add two numbers' }],
      executeToolFn,
    });

    const response = {
      content: [
        'Let me add those numbers:',
        '```js',
        'const r = await add({ a: 2, b: 3 });',
        'print(r.sum);',
        '```',
      ].join('\n'),
    };

    const result = await middleware.after(response);

    // The real tool function was actually invoked with the right args --
    // this is the core behavior that was previously broken ("Unknown capability").
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { name: 'add', params: { a: 2, b: 3 } });

    assert.equal(result._codeResults.length, 1);
    assert.equal(result._codeResults[0].error, undefined);
    assert.ok(result._codeResults[0].output.includes('5'));

    // The sandbox was created with a capabilities map derived from tools/executeToolFn.
    assert.equal(created.length, 1);
    assert.equal(typeof created[0].capabilities.add, 'function');
  });

  it('rejects unknown tool calls with "Unknown capability" instead of silently succeeding', async () => {
    const { createSandbox } = makeFakeAndbox();
    const executeToolFn = async () => ({ ok: true });

    const middleware = createCodeExecutionMiddleware({
      createSandbox,
      tools: [{ name: 'known_tool' }],
      executeToolFn,
    });

    const response = {
      content: '```js\nawait host.call("not_a_real_tool", {});\n```',
    };

    const result = await middleware.after(response);
    assert.equal(result._codeResults[0].error, 'Unknown capability: not_a_real_tool');
  });

  // #7: end-to-end proof that a python-tagged block with a multi-placeholder,
  // dotted-name f-string actually adapts and runs cleanly in the sandbox,
  // rather than just checking adaptPythonisms() in isolation.
  it('adapts a python-tagged f-string with multiple dotted placeholders and runs it', async () => {
    const { createSandbox } = makeFakeAndbox();
    const middleware = createCodeExecutionMiddleware({
      createSandbox,
      tools: [],
      executeToolFn: async () => ({}),
    });

    const response = {
      content: [
        '```python',
        'const o = {"city": "Boston"}',
        'const name = "Ada"',
        'print(f"{name} lives in {o.city}")',
        '```',
      ].join('\n'),
    };

    const result = await middleware.after(response);

    assert.equal(result._codeResults[0].error, undefined);
    assert.ok(result._codeResults[0].output.includes('Ada lives in Boston'));
  });

  it('reuses a pre-built sandbox instance as-is when `sandbox` is passed directly', async () => {
    const calls = [];
    const executeToolFn = async (name, params) => { calls.push(params); return 'ok'; };
    const capabilities = toolsToCapabilities([{ name: 'ping' }], executeToolFn);

    const { createSandbox } = makeFakeAndbox();
    const sandbox = await createSandbox({ capabilities });

    const middleware = createCodeExecutionMiddleware({
      sandbox,
      tools: [{ name: 'ping' }],
      executeToolFn,
    });

    const response = { content: '```js\nawait ping({ hello: "world" });\n```' };
    await middleware.after(response);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { hello: 'world' });
  });

  // #8 (2): a block that printed output before throwing used to lose that
  // output entirely -- `_codeResults[0].output` came back as ''.
  it('keeps console output captured before a block throws', async () => {
    const { createSandbox } = makeFakeAndbox();
    const middleware = createCodeExecutionMiddleware({
      createSandbox,
      tools: [],
      executeToolFn: async () => ({}),
    });

    const response = {
      content: '```js\nprint("before the throw");\nthrow new Error("boom");\n```',
    };

    const result = await middleware.after(response);

    assert.equal(result._codeResults.length, 1);
    assert.equal(result._codeResults[0].error, 'boom');
    assert.ok(result._codeResults[0].output.includes('before the throw'));
    assert.ok(result._resultSummary.includes('before the throw'));
    assert.ok(result._resultSummary.includes('boom'));
  });

  it('throws a clear error when neither sandbox nor createSandbox is provided', () => {
    assert.throws(
      () => createCodeExecutionMiddleware({ tools: [], executeToolFn: async () => {} }),
      /requires either a pre-built `sandbox`|createSandbox/
    );
  });
});

describe('index re-exports', () => {
  it('exports all public API', async () => {
    const mod = await import('../src/index.mjs');
    assert.equal(typeof mod.createCodeExecutionMiddleware, 'function');
    assert.equal(typeof mod.extractCodeBlocks, 'function');
    assert.equal(typeof mod.stripCodeBlocks, 'function');
    assert.equal(typeof mod.adaptPythonisms, 'function');
    assert.equal(typeof mod.autoAwait, 'function');
    assert.equal(typeof mod.toolsToCapabilities, 'function');
    assert.equal(typeof mod.toolsToPreamble, 'function');
    assert.equal(typeof mod.formatResults, 'function');
    assert.equal(typeof mod.resultsToToolCalls, 'function');
  });
});
