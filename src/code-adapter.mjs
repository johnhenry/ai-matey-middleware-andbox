/**
 * Code adaptation utilities for LLM-generated code.
 * Extracted from clawser-codex.js for reuse in ai.matey middleware.
 */

// Matches a dotted/indexed identifier chain, e.g. `name`, `o.city`,
// `items[0]`, `o.items[0].name` -- what typically appears inside an
// f-string's `{...}` placeholder.
const IDENT_EXPR_SOURCE = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\[\\]]+\\])*';
const PLACEHOLDER_RE = new RegExp(`\\{(${IDENT_EXPR_SOURCE})\\}`, 'g');

// Matches a Python `for x in y:` loop header on its own line.
const FOR_HEADER_RE = /^(\s*)for\s+([A-Za-z_$][\w$]*)\s+in\s+(.+):[ \t]*$/;

/**
 * Light Python-to-JS transform for common patterns.
 * Handles the most frequent mismatches from models that think in Python.
 *
 * Only rewrites Python-isms in code that hasn't already been adapted --
 * if the block already contains a real JS template literal (`${...}`),
 * it's left untouched rather than risk double-dollaring it into `$${...}`.
 *
 * @param {string} code
 * @returns {string}
 */
export function adaptPythonisms(code) {
  if (code.includes('${')) return code;

  let adapted = code;
  // True/False/None → true/false/null
  adapted = adapted.replace(/\bTrue\b/g, 'true');
  adapted = adapted.replace(/\bFalse\b/g, 'false');
  adapted = adapted.replace(/\bNone\b/g, 'null');
  // f"..." or f'...' → template literals (simple cases)
  adapted = adapted.replace(/f"([^"]*?)"/g, '`$1`');
  adapted = adapted.replace(/f'([^']*?)'/g, '`$1`');
  // {name}, {o.city}, {items[0]} inside template literals → ${...}
  // (global within each template literal, so every placeholder is
  // rewritten, not just the first one).
  adapted = adapted.replace(/`([^`]*)`/g, (_full, inner) =>
    '`' + inner.replace(PLACEHOLDER_RE, '${$1}') + '`'
  );
  // `# comment` (full-line only) → `// comment`
  adapted = adapted.replace(/^([ \t]*)#(.*)$/gm, '$1//$2');
  // simple `for x in y:` blocks → JS for-of loops with braces
  adapted = adaptForLoops(adapted);
  return adapted;
}

/**
 * Rewrite simple, flat/nested `for x in y:` Python loop headers into JS
 * `for (const x of y) {` and close the block with `}` based on
 * indentation, since JS blocks are brace-delimited rather than
 * indentation-delimited. Only handles a single loop variable (no tuple
 * unpacking) and a header that is the entire line (nothing trailing the
 * `:` besides whitespace).
 *
 * @param {string} code
 * @returns {string}
 */
function adaptForLoops(code) {
  const lines = code.split('\n');
  const out = [];
  const stack = []; // { indentStr }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      const indent = line.match(/^[ \t]*/)[0].length;
      while (stack.length && indent <= stack[stack.length - 1].indent) {
        out.push(stack.pop().indentStr + '}');
      }
    }

    const m = line.match(FOR_HEADER_RE);
    if (m) {
      const [, indentStr, varName, iterable] = m;
      out.push(`${indentStr}for (const ${varName} of ${iterable}) {`);
      stack.push({ indent: indentStr.length, indentStr });
      continue;
    }

    out.push(line);
  }

  while (stack.length) {
    out.push(stack.pop().indentStr + '}');
  }

  return out.join('\n');
}

/**
 * Auto-insert `await` before async calls that the model forgot to await.
 * Handles: print(...), browser_*(...), and custom function names.
 * Only adds await if not already preceded by await.
 *
 * @param {string} code
 * @param {string[]} [asyncFnPatterns] - Additional function name patterns to auto-await
 * @returns {string}
 */
export function autoAwait(code, asyncFnPatterns = []) {
  // Skip matches inside string literals (single, double, backtick)
  const stringPattern = /(['"`])(?:(?!\1|\\).|\\.)*\1/g;
  const stringRanges = [];
  let m;
  while ((m = stringPattern.exec(code)) !== null) {
    stringRanges.push([m.index, m.index + m[0].length]);
  }
  function inString(idx) {
    return stringRanges.some(([s, e]) => idx >= s && idx < e);
  }

  // await before print() calls — skip if inside string
  code = code.replace(/(?<!\bawait\s+)(\bprint\s*\()/g, (match, p1, offset) => {
    if (inString(offset)) return match;
    return 'await ' + p1;
  });

  // await before browser_* tool calls at statement level
  code = code.replace(/(^|;\s*)(?!await\s)(browser_\w+\s*\()/gm, (match, p1, p2, offset) => {
    if (inString(offset)) return match;
    return p1 + 'await ' + p2;
  });

  // Auto-await additional patterns
  for (const pattern of asyncFnPatterns) {
    const re = new RegExp(`(?<!\\bawait\\s+)(\\b${pattern}\\s*\\()`, 'g');
    code = code.replace(re, (match, p1, offset) => {
      if (inString(offset)) return match;
      return 'await ' + p1;
    });
  }

  return code;
}
