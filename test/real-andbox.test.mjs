/**
 * Real-andbox suite (#12). No fake: this runs the middleware against the
 * actual `@johnhenry/andbox` sandbox. Since andbox 0.0.4 the default worker
 * mode runs on `node:worker_threads` under plain Node (no global Worker), so
 * `capabilities` / `host.call()` / `policy` / `evaluate()` are all real here.
 * The fake-based suites (middleware, sandbox-scope) stay for speed and for
 * behaviour that does not need a real thread.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '@johnhenry/andbox';
import { createCodeExecutionMiddleware } from '../src/index.mjs';
import { toolsToCapabilities } from '../src/tool-injector.mjs';

const created = [];
/** The real factory, tracked so every sandbox is disposed after each test. */
async function trackedCreateSandbox(opts) {
  const sb = await createSandbox(opts);
  created.push(sb);
  return sb;
}
afterEach(async () => {
  while (created.length) await created.pop().dispose();
});

const fence = (code, lang = 'js') => ({ content: '```' + lang + '\n' + code + '\n```' });

function make(extra = {}) {
  const calls = [];
  const mw = createCodeExecutionMiddleware({
    createSandbox: trackedCreateSandbox,
    tools: [{ name: 'readMemory' }, { name: 'add' }],
    executeToolFn: async (name, params) => {
      calls.push([name, params]);
      if (name === 'add') return params.a + params.b;
      return `value-of-${params.key}`;
    },
    ...extra,
  });
  return { mw, calls };
}

describe('real andbox: tool calls reach executeToolFn through host.call', () => {
  it('runs a js block, routes the tool call, captures console output', async () => {
    const { mw, calls } = make();
    const r = await mw.after(fence('const v = await readMemory({ key: "k" });\nprint(v);'));
    assert.equal(r._codeResults.length, 1);
    assert.equal(r._codeResults[0].error, undefined);
    assert.equal(r._codeResults[0].output, 'value-of-k');
    assert.deepEqual(calls, [['readMemory', { key: 'k' }]]);
    assert.match(r._resultSummary, /value-of-k/);
  });

  it('falls back to the return value when nothing was printed', async () => {
    const { mw } = make();
    const r = await mw.after(fence('return await add({ a: 2, b: 40 });'));
    assert.equal(r._codeResults[0].output, '42');
  });

  it('adapts python-style tool_code (True/None/f-strings) and runs it for real', async () => {
    const { mw, calls } = make();
    const r = await mw.after(fence('x = await add({ a: 1, b: 2 })\nprint(f"sum is {x}", True)', 'tool_code'));
    assert.equal(r._codeResults[0].error, undefined, r._codeResults[0].error);
    assert.equal(r._codeResults[0].output, 'sum is 3 true');
    assert.deepEqual(calls, [['add', { a: 1, b: 2 }]]);
  });

  it('keeps output printed before an exception and reports the error', async () => {
    const { mw } = make();
    const r = await mw.after(fence('print("before");\nthrow new TypeError("boom");'));
    assert.equal(r._codeResults[0].output, 'before');
    assert.match(r._codeResults[0].error, /boom/);
  });

  it('propagates an executeToolFn failure as a catchable error in the block', async () => {
    const { mw } = make({ executeToolFn: async () => { throw new Error('tool exploded'); } });
    const r = await mw.after(fence('try { await readMemory({ key: "k" }); } catch (e) { print("caught: " + e.message); }'));
    assert.equal(r._codeResults[0].output, 'caught: tool exploded');
  });

  it('runs several blocks in one response, each in the same sandbox', async () => {
    const { mw, calls } = make();
    const r = await mw.after({ content: '```js\nprint(await add({ a: 1, b: 1 }))\n```\ntext\n```js\nprint(await add({ a: 2, b: 2 }))\n```' });
    assert.deepEqual(r._codeResults.map((x) => x.output), ['2', '4']);
    assert.equal(calls.length, 2);
  });
});

describe('real andbox: the capability gate protects the tool surface', () => {
  it('host.call of an undeclared tool is "Unknown capability" and executeToolFn is never called', async () => {
    const { mw, calls } = make();
    const r = await mw.after(fence('await host.call("deleteEverything", {});'));
    assert.match(r._codeResults[0].error, /Unknown capability/);
    assert.deepEqual(calls, []);
  });

  it('prototype-chain names cannot be reached through host.call', async () => {
    const { mw, calls } = make();
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = await mw.after(fence(`await host.call(${JSON.stringify(name)}, {});`));
      assert.match(r._codeResults[0].error, /Unknown capability/, name);
    }
    assert.deepEqual(calls, []);
  });

  it('policy.limits.maxCalls from sandboxOptions is enforced by the real gate', async () => {
    const { mw } = make({ sandboxOptions: { policy: { limits: { maxCalls: 2 } } } });
    const r = await mw.after(fence('await add({a:1,b:1}); await add({a:1,b:1}); await add({a:1,b:1});'));
    assert.match(r._codeResults[0].error, /call limit exceeded/i);
  });
});

describe('real andbox: sandbox lifetime', () => {
  it("'conversation' scope accumulates maxCalls across turns; resetSandbox() starts fresh", async () => {
    const { mw } = make({ sandboxOptions: { policy: { limits: { maxCalls: 2 } } } });
    const turn = async () => (await mw.after(fence('await add({a:1,b:1}); await add({a:1,b:1});')))._codeResults[0].error ?? 'ok';
    assert.equal(await turn(), 'ok');
    assert.match(await turn(), /call limit exceeded/i);
    await mw.resetSandbox();
    assert.equal(await turn(), 'ok');
  });

  it("'turn' scope gives every turn a fresh budget and disposes each sandbox", async () => {
    const { mw } = make({ sandboxScope: 'turn', sandboxOptions: { policy: { limits: { maxCalls: 2 } } } });
    for (let i = 0; i < 3; i++) {
      const r = await mw.after(fence('await add({a:1,b:1}); await add({a:1,b:1});'));
      assert.equal(r._codeResults[0].error, undefined);
    }
    assert.equal(created.length, 3);
    assert.ok(created.every((sb) => sb.isDisposed()), 'each turn sandbox is disposed');
  });

  it('resetSandbox() really disposes the real cached sandbox', async () => {
    const { mw } = make();
    await mw.after(fence('print(1)'));
    assert.equal(created.length, 1);
    assert.equal(created[0].isDisposed(), false);
    await mw.resetSandbox();
    assert.equal(created[0].isDisposed(), true);
  });

  it('a runaway block is killed at timeoutMs and the next turn still works', async () => {
    const { mw } = make({ timeoutMs: 2000 });
    const r1 = await mw.after(fence('while (true) {}'));
    assert.match(r1._codeResults[0].error, /timed out/i);
    const r2 = await mw.after(fence('print("alive")'));
    assert.equal(r2._codeResults[0].error, undefined);
    assert.equal(r2._codeResults[0].output, 'alive');
  });

  it('a pre-built real sandbox works when created with the tool capabilities', async () => {
    const calls = [];
    const tools = [{ name: 'add' }];
    const executeToolFn = async (name, p) => { calls.push(name); return p.a + p.b; };
    const sandbox = await trackedCreateSandbox({ capabilities: toolsToCapabilities(tools, executeToolFn) });
    const mw = createCodeExecutionMiddleware({ sandbox, tools, executeToolFn });
    const r = await mw.after(fence('print(await add({ a: 20, b: 22 }))'));
    assert.equal(r._codeResults[0].output, '42');
    assert.deepEqual(calls, ['add']);
  });

  it('a pre-built sandbox WITHOUT the capabilities reproduces the documented "Unknown capability" failure', async () => {
    const sandbox = await trackedCreateSandbox({});
    const mw = createCodeExecutionMiddleware({
      sandbox, tools: [{ name: 'add' }], executeToolFn: async () => 1,
    });
    const r = await mw.after(fence('await add({ a: 1, b: 2 })'));
    assert.match(r._codeResults[0].error, /Unknown capability/);
  });
});
