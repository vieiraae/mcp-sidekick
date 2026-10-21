// Structured audit logger for MCP tool invocations.
// Writes NDJSON (newline-delimited JSON) to stderr so it stays
// separate from MCP's stdio transport on stdout.

const LOG_TARGET = process.stderr;

/**
 * Emit a structured audit record for a tool invocation.
 * @param {object} entry
 * @param {string} entry.tool       - Tool name (e.g. "crm_query")
 * @param {string} [entry.entitySet]- CRM entity set queried
 * @param {string} [entry.method]   - HTTP method (GET, PATCH, …)
 * @param {number} [entry.recordCount] - Number of records returned
 * @param {boolean} [entry.blocked] - Whether the request was blocked by a guardrail
 * @param {string} [entry.reason]   - Why it was blocked
 * @param {object} [entry.params]   - Sanitized input params (no tokens/secrets)
 */
export function auditLog(entry) {
  const record = {
    ts: new Date().toISOString(),
    ...entry,
  };
  try {
    LOG_TARGET.write(JSON.stringify(record) + '\n');
  } catch {
    // Never crash the server for a logging failure
  }
}
