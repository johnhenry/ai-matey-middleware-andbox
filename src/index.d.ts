/**
 * @johnhenry/aimatey-middleware-andbox — TypeScript type definitions for
 * all public API exports.
 *
 * Hand-written and checked in alongside the `.mjs` source (no build step),
 * matching the sibling `andbox` package's convention for a package this
 * size.
 */

// ── code-extractor ──

/** A single fenced code block extracted from LLM text output. */
export interface CodeBlock {
  /** The fence's language tag, lowercased (e.g. `"js"`, `"python"`, `""` for a bare fence). */
  lang: string;
  /** The trimmed code inside the fence. */
  code: string;
}

/**
 * Extract fenced code blocks from LLM text output.
 * Matches any fenced code block: ```js, ```tool_code, ```python, bare ```, etc.
 */
export declare function extractCodeBlocks(text: string): CodeBlock[];

/** Remove all fenced code blocks from text, leaving conversational content. */
export declare function stripCodeBlocks(text: string): string;

// ── code-adapter ──

/**
 * Light Python-to-JS transform for common patterns: `True`/`False`/`None`,
 * f-strings (including dotted/indexed placeholders like `{o.city}` and
 * multiple placeholders per string), full-line `#` comments, and simple
 * `for x in y:` loops. Detection/rewriting is per string literal: only
 * actual `f"..."`/`f'...'` f-strings are rewritten, so a real JS template
 * literal (backtick string, including one with its own `${...}`)
 * elsewhere in the same block is always left untouched.
 */
export declare function adaptPythonisms(code: string): string;

/**
 * Auto-insert `await` before async calls that the model forgot to await.
 * Handles: print(...), browser_*(...), and custom function names.
 * Only adds await if not already preceded by await.
 *
 * @param asyncFnPatterns Additional function name patterns to auto-await.
 */
export declare function autoAwait(code: string, asyncFnPatterns?: string[]): string;

// ── tool-injector ──

/** A single tool definition offered to the LLM as a callable function. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** A function that actually executes a named tool call. */
export type ExecuteToolFn = (name: string, params: object) => Promise<unknown>;

/**
 * Convert an array of tool definitions into sandbox capabilities.
 * Each tool becomes a capability that calls executeToolFn.
 */
export declare function toolsToCapabilities(
  tools: ToolDefinition[],
  executeToolFn: ExecuteToolFn,
): Record<string, (params?: object) => Promise<unknown>>;

/**
 * Generate a code preamble that creates local function stubs for each tool.
 * These stubs call host.call() to route back to the host.
 */
export declare function toolsToPreamble(tools: Array<{ name: string }>): string;

// ── result-formatter ──

/** The result of executing a single extracted code block. */
export interface CodeExecutionResult {
  /** The original (pre-adaptation) code from the fenced block. */
  code: string;
  /**
   * Captured `console`/`print()` output. Populated even when `error` is
   * set, so callers can see whatever the block printed before it threw.
   */
  output: string;
  /** Present when the block threw; `e.message` (or `String(e)`) from the sandbox. */
  error?: string;
}

/** Format execution results as a concise summary for the LLM. */
export declare function formatResults(
  results: CodeExecutionResult[],
  maxResultLength?: number,
): string;

/** A synthetic tool-call entry built from a code execution result. */
export interface SyntheticToolCall {
  id: string;
  name: '_code_exec';
  arguments: string;
  _result: {
    success: boolean;
    output: string;
    error?: string;
  };
}

/** Build synthetic tool call entries from execution results. */
export declare function resultsToToolCalls(results: CodeExecutionResult[]): SyntheticToolCall[];

// ── middleware ──

/**
 * A minimal shape for whatever `sandbox`/`createSandbox` accepts/returns
 * here -- deliberately loose rather than importing andbox's own types,
 * since andbox is a peer dependency this package doesn't require at
 * type-check time.
 */
export interface AndboxLikeSandbox {
  evaluate(
    code: string,
    opts?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onConsole?: (level: string, ...args: string[]) => void;
    },
  ): Promise<unknown>;
  dispose?: () => Promise<void>;
}

export type AndboxLikeCreateSandbox = (
  opts?: Record<string, unknown>,
) => AndboxLikeSandbox | Promise<AndboxLikeSandbox>;

/** Options for {@link createCodeExecutionMiddleware}. */
export interface CodeExecutionMiddlewareOptions {
  /**
   * A pre-built andbox sandbox instance. Must already have been created
   * with `capabilities: toolsToCapabilities(tools, executeToolFn)` (or
   * equivalent) -- capabilities cannot be added after creation.
   */
  sandbox?: AndboxLikeSandbox;
  /**
   * andbox's `createSandbox` factory. If provided (and `sandbox` is not),
   * the middleware creates the sandbox itself, wiring `tools`/
   * `executeToolFn` in as capabilities. Note: andbox's own `createSandbox`
   * returns a `Promise<Sandbox>`, not a `Sandbox` -- the middleware awaits
   * it for you either way.
   */
  createSandbox?: AndboxLikeCreateSandbox;
  /**
   * Extra options merged into the `createSandbox()` call when using the
   * `createSandbox` factory (e.g. `importMap`, `policy`, `onConsole`). Any
   * `capabilities` here are merged with (and can override) the
   * tool-derived ones.
   */
  sandboxOptions?: Record<string, unknown>;
  /** Tool definitions. */
  tools?: ToolDefinition[];
  /** Function to execute tools. */
  executeToolFn: ExecuteToolFn;
  /** Max characters per result. @default 4096 */
  maxResultLength?: number;
  /** Code block languages to execute. @default ['js','javascript','tool_code','python','py',''] */
  codeLanguages?: string[];
  /** Execution timeout in milliseconds. @default 30000 */
  timeoutMs?: number;
  /**
   * How long a factory-created sandbox lives. `'conversation'` creates it on
   * first use and caches it, so andbox's per-sandbox limits
   * (`policy.limits.maxCalls`, ...) accumulate across every `after()` call.
   * `'turn'` creates a fresh sandbox per `after()` call that has code to run
   * and disposes it afterwards, so those limits apply per turn; it requires
   * the `createSandbox` factory (not a pre-built `sandbox`).
   * @default 'conversation'
   */
  sandboxScope?: 'conversation' | 'turn';
}

/**
 * A response object as passed through the `after` phase. Only the fields
 * this middleware reads/writes are typed; anything else on the response
 * passes through untouched.
 */
export interface CodeExecutionResponse {
  content?: string;
  text?: string;
  _codeResults?: CodeExecutionResult[];
  _toolCalls?: SyntheticToolCall[];
  _cleanText?: string;
  _resultSummary?: string;
  [key: string]: unknown;
}

/** An aimatey middleware object with an `after` hook. */
export interface CodeExecutionMiddleware {
  after(response: CodeExecutionResponse): Promise<CodeExecutionResponse>;
  /**
   * Dispose the cached sandbox so the next `after()` builds a fresh one
   * (fresh `policy.limits` counters). A no-op before first use and under
   * `sandboxScope: 'turn'`; rejects for a pre-built `sandbox`.
   */
  resetSandbox(): Promise<void>;
}

/**
 * Create an aimatey middleware for code-based tool execution.
 *
 * The middleware intercepts LLM responses (in the `after` phase) and:
 * 1. Extracts fenced code blocks
 * 2. Adapts Python-isms and auto-inserts await
 * 3. Executes each block in the sandbox with tool stubs
 * 4. Attaches results as `_codeResults` and `_toolCalls` on the response
 *
 * This middleware's `after(response)` hook reads/writes `response.content`
 * directly -- it is not itself an aimatey-core `bridge.use()`
 * `(context, next)` middleware function. See the README's "Using with an
 * aimatey Bridge" section for how to adapt it.
 */
export declare function createCodeExecutionMiddleware(
  options: CodeExecutionMiddlewareOptions,
): CodeExecutionMiddleware;
