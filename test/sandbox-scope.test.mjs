import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeExecutionMiddleware } from '../src/index.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * A fake andbox that, like the real one, keeps a PER-SANDBOX host-call counter
 * and enforces `policy.limits.maxCalls` against it (#13), and records dispose().
 */
function makeCountingAndbox() {
  const created = [];
  async function createSandbox(opts = {}) {
    const capabilities = opts.capabilities || {};
    const maxCalls = opts.policy?.limits?.maxCalls ?? 0;
    let totalCalls = 0;
    const sandbox = {
      disposed: false,
      async evaluate(code) {
        if (sandbox.disposed) throw new Error('Sandbox is disposed');
        const host = {
          call: async (name, params) => {
            if (maxCalls > 0 && totalCalls >= maxCalls) {
              throw new Error(`Global call limit exceeded (${maxCalls})`);
            }
            totalCalls++;
            return capabilities[name](params);
          },
        };
        return new AsyncFunction('host', `"use strict";\n${code}`)(host);
      },
      async dispose() { sandbox.disposed = true; },
    };
    created.push(sandbox);
    return sandbox;
  }
  return { createSandbox, created };
}

const BLOCK = { content: '```js\nfor (let i = 0; i < 2; i++) await host.call("readMemory", { key: "k" });\n```' };
const turn = async (mw) => {
  const r = { ...BLOCK };
  await mw.after(r);
  return r._codeResults[0].error ?? 'ok';
};
const make = (extra = {}) => {
  const { createSandbox, created } = makeCountingAndbox();
  const mw = createCodeExecutionMiddleware({
    createSandbox,
    tools: [{ name: 'readMemory' }],
    executeToolFn: async () => 'v',
    sandboxOptions: { policy: { limits: { maxCalls: 4 } } },
    ...extra,
  });
  return { mw, created };
};

describe("sandboxScope (#13)", () => {
  it("default ('conversation') keeps today's behavior: the limit accumulates across turns", async () => {
    const { mw, created } = make();
    assert.equal(await turn(mw), 'ok');
    assert.equal(await turn(mw), 'ok');
    assert.equal(await turn(mw), 'Global call limit exceeded (4)');
    assert.equal(created.length, 1, 'one cached sandbox');
  });

  it("explicit 'conversation' is the same as the default", async () => {
    const { mw, created } = make({ sandboxScope: 'conversation' });
    await turn(mw); await turn(mw);
    assert.equal(await turn(mw), 'Global call limit exceeded (4)');
    assert.equal(created.length, 1);
  });

  it("'turn' gives every after() a fresh sandbox, so the limit is per turn, and disposes it", async () => {
    const { mw, created } = make({ sandboxScope: 'turn' });
    for (let i = 0; i < 5; i++) assert.equal(await turn(mw), 'ok');
    assert.equal(created.length, 5);
    assert.ok(created.every((s) => s.disposed), 'every per-turn sandbox is disposed afterwards');
  });

  it("'turn' disposes the sandbox even when a block throws", async () => {
    const { mw, created } = make({ sandboxScope: 'turn' });
    const r = { content: '```js\nthrow new Error("boom");\n```' };
    await mw.after(r);
    assert.equal(r._codeResults[0].error, 'boom');
    assert.equal(created.length, 1);
    assert.equal(created[0].disposed, true);
  });

  it("'turn' creates no sandbox for a response with no code blocks", async () => {
    const { mw, created } = make({ sandboxScope: 'turn' });
    await mw.after({ content: 'just prose' });
    assert.equal(created.length, 0);
  });

  it("'turn' requires the createSandbox factory, not a pre-built sandbox", async () => {
    const { createSandbox } = makeCountingAndbox();
    const sandbox = await createSandbox({});
    assert.throws(
      () => createCodeExecutionMiddleware({ sandbox, sandboxScope: 'turn', tools: [], executeToolFn: async () => {} }),
      /sandboxScope: 'turn'.*createSandbox/s
    );
  });

  it('rejects an unknown sandboxScope', () => {
    const { createSandbox } = makeCountingAndbox();
    assert.throws(
      () => createCodeExecutionMiddleware({ createSandbox, sandboxScope: 'forever', tools: [], executeToolFn: async () => {} }),
      /sandboxScope/
    );
  });
});

describe('resetSandbox() (#13)', () => {
  it('disposes the cached sandbox and starts the next turn on a fresh one with fresh limits', async () => {
    const { mw, created } = make();
    await turn(mw); await turn(mw);
    assert.equal(await turn(mw), 'Global call limit exceeded (4)');
    await mw.resetSandbox();
    assert.equal(created.length, 1);
    assert.equal(created[0].disposed, true, 'old sandbox disposed');
    assert.equal(await turn(mw), 'ok');
    assert.equal(created.length, 2);
    assert.equal(created[1].disposed, false);
  });

  it('is a no-op before the first use and when called twice', async () => {
    const { mw, created } = make();
    await mw.resetSandbox();
    await mw.resetSandbox();
    assert.equal(created.length, 0);
    await turn(mw);
    await mw.resetSandbox();
    await mw.resetSandbox();
    assert.equal(created.length, 1);
  });

  it("is a no-op under sandboxScope: 'turn' (there is no cached sandbox)", async () => {
    const { mw, created } = make({ sandboxScope: 'turn' });
    await mw.resetSandbox();
    assert.equal(created.length, 0);
  });

  it('rejects for a pre-built sandbox, which the middleware cannot recreate', async () => {
    const { createSandbox } = makeCountingAndbox();
    const sandbox = await createSandbox({});
    const mw = createCodeExecutionMiddleware({ sandbox, tools: [], executeToolFn: async () => {} });
    await assert.rejects(() => mw.resetSandbox(), /pre-built/);
    assert.equal(sandbox.disposed, false, 'the caller\'s sandbox is left alone');
  });
});
