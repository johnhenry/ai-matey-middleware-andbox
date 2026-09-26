/**
 * Format sandbox execution results for LLM consumption.
 */

/**
 * Format execution results as a concise summary for the LLM.
 *
 * @param {Array<{code: string, output: string, error?: string}>} results
 * @param {number} [maxResultLength=4096] - Truncation limit per result
 * @returns {string}
 */
export function formatResults(results, maxResultLength = 4096) {
  if (results.length === 0) return '';

  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const label = results.length > 1 ? `Block ${i + 1}` : 'Result';

    if (r.error) {
      const partial = r.output ? `${truncate(r.output, maxResultLength)}\n` : '';
      parts.push(`${label} (error): ${partial}${truncate(r.error, maxResultLength)}`);
    } else {
      const output = r.output || '(no output)';
      parts.push(`${label}: ${truncate(output, maxResultLength)}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build synthetic tool call entries from execution results.
 *
 * @param {Array<{code: string, output: string, error?: string}>} results
 * @returns {Array<{id: string, name: string, arguments: string, _result: {success: boolean, output: string, error?: string}}>}
 */
export function resultsToToolCalls(results) {
  return results.map((r, i) => ({
    id: `code_exec_${Date.now()}_${i}`,
    name: '_code_exec',
    arguments: JSON.stringify({ code: r.code }),
    _result: r.error
      ? { success: false, output: r.output || '', error: r.error }
      : { success: true, output: r.output || '(executed successfully)' },
  }));
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 20) + `\n... (truncated, ${str.length} chars total)`;
}
