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
  } = options;

  if (!sandbox && typeof createSandbox !== 'function') {
    throw new Error(
      'createCodeExecutionMiddleware requires either a pre-built `sandbox` ' +
      '(created with capabilities wired to executeToolFn) or a `createSandbox` factory.'
    );
  }

  const langSet = new Set(codeLanguages.map(l => l.toLowerCase()));
  const preamble = toolsToPreamble(tools);

  // Lazily create (and cache) the sandbox when a factory is supplied, so
  // `host.call()` from sandboxed code actually reaches `executeToolFn`.
  let sandboxPromise = sandbox ? Promise.resolve(sandbox) : null;
  function getSandbox() {
    if (!sandboxPromise) {
      const capabilities = {
        ...toolsToCapabilities(tools, executeToolFn),
        ...(sandboxOptions.capabilities || {}),
      };
      sandboxPromise = Promise.resolve(createSandbox({ ...sandboxOptions, capabilities }));
    }
    return sandboxPromise;
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

      const activeSandbox = await getSandbox();
      const results = [];

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

      // Attach results to response
      const cleanText = stripCodeBlocks(content);
      response._codeResults = results;
      response._toolCalls = resultsToToolCalls(results);
      response._cleanText = cleanText;
      response._resultSummary = formatResults(results, maxResultLength);

      return response;
    },
  };
}
