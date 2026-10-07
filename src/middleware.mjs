/**
 * ai.matey middleware for code-based tool execution via andbox.
 *
 * Intercepts LLM responses, extracts code blocks, adapts them,
 * executes via sandbox with tools as capabilities, and attaches results.
 *
 * IMPORTANT: andbox's Worker sandbox only accepts `capabilities` at
 * `createSandbox({ capabilities })` time -- `sandbox.evaluate()` has no
 * capabilities hook. That means `host.call('toolName', ...)` from
 * sandboxed code can only ever reach real tool functions if the sandbox
 * itself was created with `capabilities: toolsToCapabilities(tools, executeToolFn)`.
 * This middleware handles that in one of two ways:
 *
 * 1. Pass an andbox `createSandbox` factory (the function itself, not a
 *    pre-built instance) via the `createSandbox` option, plus `tools` and
 *    `executeToolFn`. The middleware builds the capabilities map and
 *    creates (and caches) the sandbox itself.
 * 2. Pass an already-built `sandbox` instance via the `sandbox` option.
 *    In this case YOU are responsible for having created it with
 *    `capabilities: toolsToCapabilities(tools, executeToolFn)` -- the
 *    middleware cannot retrofit capabilities onto an existing sandbox.
 */

import { extractCodeBlocks, stripCodeBlocks } from './code-extractor.mjs';
import { adaptPythonisms, autoAwait } from './code-adapter.mjs';
import { toolsToCapabilities, toolsToPreamble } from './tool-injector.mjs';
import { formatResults, resultsToToolCalls } from './result-formatter.mjs';

/**
 * @typedef {Object} CodeExecutionMiddlewareOptions
 * @property {import('@johnhenry/andbox').Sandbox} [sandbox] - A pre-built andbox sandbox instance. Must already have been created with `capabilities: toolsToCapabilities(tools, executeToolFn)` (or equivalent) -- capabilities cannot be added after creation.
 * @property {import('@johnhenry/andbox').createSandbox} [createSandbox] - andbox's `createSandbox` factory. If provided (and `sandbox` is not), the middleware creates the sandbox itself, wiring `tools`/`executeToolFn` in as capabilities.
 * @property {object} [sandboxOptions] - Extra options merged into the `createSandbox()` call when using the `createSandbox` factory (e.g. `importMap`, `policy`, `onConsole`). Any `capabilities` here are merged with (and can override) the tool-derived ones.
 * @property {Array<{name: string, description?: string, parameters?: object}>} tools - Tool definitions
 * @property {(name: string, params: object) => Promise<any>} executeToolFn - Tool execution function
 * @property {number} [maxResultLength=4096] - Max characters per result
 * @property {string[]} [codeLanguages] - Code block languages to execute
 * @property {number} [timeoutMs=30000] - Execution timeout
 * @property {'conversation' | 'turn'} [sandboxScope='conversation'] - How long a factory-created sandbox lives. `'conversation'` (default) creates it on first use and caches it, so andbox's per-sandbox limits (`policy.limits.maxCalls`, ...) accumulate across every `after()` call. `'turn'` creates a fresh sandbox for each `after()` call that has code to run and disposes it afterwards, so those limits apply per turn. `'turn'` requires the `createSandbox` factory.
 */

/**
 * Create an ai.matey middleware for code-based tool execution.
 *
 * The middleware intercepts LLM responses (in the `after` phase) and:
 * 1. Extracts fenced code blocks
 * 2. Adapts Python-isms and auto-inserts await
 * 3. Executes each block in the sandbox with tool stubs
 * 4. Attaches results as `_codeResults` and `_toolCalls` on the response
 *
 * @param {CodeExecutionMiddlewareOptions} options
 * @returns {{ before?: Function, after: Function }}
 */
export function createCodeExecutionMiddleware(options) {
  const {
    sandbox,
    createSandbox,
    sandboxOptions = {},
    tools = [],
    executeToolFn,
    maxResultLength = 4096,
    codeLanguages = ['js', 'javascript', 'tool_code', 'python', 'py', ''],
    timeoutMs = 30_000,
    sandboxScope = 'conversation',
  } = options;

  if (!sandbox && typeof createSandbox !== 'function') {
    throw new Error(
      'createCodeExecutionMiddleware requires either a pre-built `sandbox` ' +
      '(created with capabilities wired to executeToolFn) or a `createSandbox` factory.'
    );
  }

  if (sandboxScope !== 'conversation' && sandboxScope !== 'turn') {
    throw new TypeError(
      `createCodeExecutionMiddleware: sandboxScope must be 'conversation' or 'turn' (got ${String(sandboxScope)}).`
    );
  }
  if (sandboxScope === 'turn' && (sandbox || typeof createSandbox !== 'function')) {
    throw new Error(
      "createCodeExecutionMiddleware: sandboxScope: 'turn' needs the `createSandbox` factory " +
      '(and no pre-built `sandbox`) -- the middleware cannot recreate a sandbox it was handed.'
    );
  }

  const langSet = new Set(codeLanguages.map(l => l.toLowerCase()));
  const preamble = toolsToPreamble(tools);

  // Build a sandbox from the factory, wiring `tools`/`executeToolFn` in as
  // capabilities so `host.call()` from sandboxed code actually reaches
  // `executeToolFn`.
  function buildSandbox() {
    const capabilities = {
      ...toolsToCapabilities(tools, executeToolFn),
      ...(sandboxOptions.capabilities || {}),
    };
    return Promise.resolve(createSandbox({ ...sandboxOptions, capabilities }));
  }

  // 'conversation' scope: lazily create (and cache) one sandbox for the
  // lifetime of the middleware (or until `resetSandbox()`). A pre-built
  // `sandbox` is used as-is.
  let sandboxPromise = sandbox ? Promise.resolve(sandbox) : null;
  function getSandbox() {
    if (!sandboxPromise) sandboxPromise = buildSandbox();
    return sandboxPromise;
  }

  async function disposeQuietly(sb) {
    try {
      await sb?.dispose?.();
    } catch {
      // Best effort: a sandbox that fails to dispose must not mask the
      // turn's results (or the error that ended it).
    }
  }

  return {
    /**
     * After-phase: intercept LLM response, execute code blocks.
     */
    async after(response) {
      const content = response?.content || response?.text || '';
      if (!content) return response;

      const blocks = extractCodeBlocks(content);
      const executableBlocks = blocks.filter(b => langSet.has(b.lang));

      if (executableBlocks.length === 0) return response;

      const activeSandbox = sandboxScope === 'turn' ? await buildSandbox() : await getSandbox();
      const results = [];

      try {
        for (const { lang, code: rawCode } of executableBlocks) {
          let code = rawCode;

          // Adapt Python-ish code
          if (lang === 'python' || lang === 'py' || lang === 'tool_code') {
            code = adaptPythonisms(code);
          }
          code = autoAwait(code);

          // Prepend tool stubs
          const fullCode = preamble + '\n' + code;

          // Collect console output
          const consoleOutput = [];

          try {
            const returnValue = await activeSandbox.evaluate(fullCode, {
              timeoutMs,
              onConsole: (_level, ...args) => { consoleOutput.push(args.join(' ')); },
            });

            let output = consoleOutput.join('\n');
            if (!output && returnValue !== undefined) {
              output = typeof returnValue === 'string'
                ? returnValue
                : JSON.stringify(returnValue, null, 2);
            }

            results.push({ code: rawCode, output: output || '(no output)' });
          } catch (e) {
            // Keep whatever the block printed *before* it threw -- discarding
            // it here would hide partial output that's often the most useful
            // debugging signal for why the error happened.
            results.push({ code: rawCode, output: consoleOutput.join('\n'), error: e.message || String(e) });
          }
        }
      } finally {
        if (sandboxScope === 'turn') await disposeQuietly(activeSandbox);
      }

      // Attach results to response
      const cleanText = stripCodeBlocks(content);
      response._codeResults = results;
      response._toolCalls = resultsToToolCalls(results);
      response._cleanText = cleanText;
      response._resultSummary = formatResults(results, maxResultLength);

      return response;
    },

    /**
     * Dispose the cached sandbox so the next `after()` call builds a fresh
     * one (fresh `policy.limits` counters, fresh module state) -- e.g. to
     * recover after a "Global call limit exceeded" error without rebuilding
     * the middleware. Safe to call at any time and more than once; a no-op
     * before the first use and under `sandboxScope: 'turn'` (nothing is
     * cached there). Rejects for a pre-built `sandbox`, which this
     * middleware cannot recreate. A block still running on the old sandbox
     * is rejected with andbox's "Sandbox disposed" error.
     * @returns {Promise<void>}
     */
    async resetSandbox() {
      if (sandbox) {
        throw new Error(
          'resetSandbox() cannot recreate a pre-built `sandbox`; pass the `createSandbox` ' +
          'factory instead, or dispose and replace your own sandbox.'
        );
      }
      const pending = sandboxPromise;
      sandboxPromise = null;
      if (!pending) return;
      let old;
      try {
        old = await pending;
      } catch {
        return; // creation failed; nothing to dispose, next turn retries.
      }
      await disposeQuietly(old);
    },
  };
}
