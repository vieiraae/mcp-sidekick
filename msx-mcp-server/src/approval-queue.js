// Lightweight approval queue for CRM write operations.
// Stages operations for human-in-the-loop review without blocking the agent.
// Emits events so frontends / agent flows can subscribe to queue changes.

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// Defense-in-depth: when running under the test runner, never fall back to the
// real user home dir. Any forgotten MSX_USER_DATA restore is caught here.
const _IN_TEST = !!(process.env.VITEST || process.env.NODE_ENV === 'test');

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const JANITOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let globalCounter = 0;

/**
 * Resolve the data directory from MSX_USER_DATA or an override.
 * Reuses audit-store pattern.
 * @param {string|null} [dirOverride]
 * @returns {string}
 */
function resolveDataDir(dirOverride = null) {
  if (dirOverride) return dirOverride;
  if (process.env.MSX_USER_DATA) {
    if (!existsSync(process.env.MSX_USER_DATA)) {
      mkdirSync(process.env.MSX_USER_DATA, { recursive: true });
    }
    return process.env.MSX_USER_DATA;
  }
  // Under the test runner, never fall back to homedir — use a stable tmp guard
  // dir instead so a forgotten MSX_USER_DATA restore can NEVER pollute the real
  // user data directory.
  if (_IN_TEST) {
    const guard = join(tmpdir(), '.msx-iq-test-data');
    if (!existsSync(guard)) mkdirSync(guard, { recursive: true });
    return guard;
  }
  try {
    const fallback = join(homedir(), '.msx-iq-data');
    if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return tmpdir();
  }
}

/**
 * @typedef {Object} StagedOperation
 * @property {string}      id           - Unique operation ID (OP-1, OP-2, …)
 * @property {string}      type         - Tool name that created this (e.g. "update_milestone")
 * @property {string}      entitySet    - CRM entity set path
 * @property {string}      method       - HTTP method ("POST" | "PATCH")
 * @property {object}      payload      - Request body to send to CRM
 * @property {object|null} beforeState  - Snapshot of current record (for diff)
 * @property {string}      description  - Human-readable summary of the change
 * @property {string}      stagedAt     - ISO timestamp
 * @property {number|null} expiresAt    - Unix ms when this op expires (null = no expiry)
 * @property {'pending'|'approved'|'rejected'|'executed'|'expired'|'failed'|'stale-conflict'} status
 * @property {number}      retryCount   - Number of execution attempts that failed (default 0)
 * @property {object|null} lastError    - Error info from the most recent failure
 * @property {string|null} actor        - User principal / actor who staged this op
 * @property {string|null} sessionId    - Session ID for scoping (null OK for PoC)
 * @property {string|null} correlationId - Correlation ID for batch->Activity grouping (Phase 2.6)
 * @property {string|null} etag - ETag from stage-time read for optimistic concurrency (Phase 2.4)
 * @property {string|null} dependsOn - Pending op this one waits for (e.g. a milestone staged for an
 *   opportunity that is itself still staged). It can't run until releaseDependents() fills it in
 *   from that op's result, and it is rejected or expired with it.
 * @property {string|null} [resolvedFrom] - The op whose result released this one (was its dependsOn)
 */

/**
 * Events emitted:
 *   'staged'        (op)           – new operation added to queue
 *   'approved'      (op)           – operation approved by human
 *   'rejected'      (op)           – operation rejected by human
 *   'executed'      (op, result)   – operation executed against CRM
 *   'expired'       (op)           – operation expired via TTL
 *   'op:error'      (op, error)    – execution failed (may still retry)
 *   'op:dead-letter'(op)           – operation moved to dead-letter queue after exhausting retries
 */
export const MAX_RETRIES = 3;

export class ApprovalQueue extends EventEmitter {
  /** @type {Map<string, StagedOperation>} */
  #ops = new Map();
  #deadLetterQueue = [];
  #ttlMs;
  #noExpiry = false;
  #sweepTimer;
  #dataDir;
  #persistDebounceTimer = null;
  #counter = 0;

  constructor({ ttlMs = DEFAULT_TTL_MS, dataDir = null } = {}) {
    super();
    this.#ttlMs = ttlMs;
    this.#dataDir = dataDir;
    this.#counter = globalCounter; // Start from global
    this.#rehydrate();
    // Periodic sweep for expired ops (every 60s)
    this.#sweepTimer = setInterval(() => this.#sweep(), 60_000);
    if (this.#sweepTimer.unref) this.#sweepTimer.unref(); // don't keep process alive
  }

  /**
   * Stage a new write operation. Returns the operation with its assigned ID.
   * `dependsOn` names a pending op this one can only run after (see the typedef).
   */
  stage({ type, entitySet, method, payload, beforeState = null, description, actor = null, sessionId = null, correlationId = null, etag = null, dependsOn = null }) {
    if (dependsOn && this.#ops.get(dependsOn)?.status !== 'pending') {
      throw new Error(`Cannot stage after ${dependsOn}: it is not a pending operation.`);
    }
    this.#counter += 1;
    globalCounter = this.#counter; // Sync back to global
    const id = `OP-${this.#counter}`;
    const now = Date.now();
    /** @type {StagedOperation} */
    const op = {
      id,
      type,
      entitySet,
      method,
      payload,
      beforeState,
      description,
      stagedAt: new Date(now).toISOString(),
      expiresAt: this.#noExpiry ? null : now + this.#ttlMs,
      status: 'pending',
      retryCount: 0,
      lastError: null,
      actor,
      sessionId,
      correlationId,
      etag,
      dependsOn: dependsOn || null,
    };
    this.#ops.set(id, op);
    this.emit('staged', op);
    this.#persistNow(); // Synchronous persist for durability
    return op;
  }

  /**
   * Approve a pending operation. Returns the approved op or null — also for an op still
   * waiting for another one (dependsOn), which has nothing to run against yet.
   */
  approve(id) {
    const op = this.#ops.get(id);
    if (!op || op.status !== 'pending' || op.dependsOn) return null;
    if (this.#ttlExpired(op, Date.now())) {
      op.status = 'expired';
      this.emit('expired', op);
      this.#ops.delete(id);
      this.#persistNow(); // Synchronous persist for state finalization
      return null;
    }
    op.status = 'approved';
    this.emit('approved', op);
    this.#persistNow(); // Synchronous persist for state finalization
    return op;
  }

  /**
   * Reject / cancel a pending or stale-conflict operation, together with every op still
   * waiting for it (they could never run). Returns the rejected op or null.
   */
  reject(id) {
    return this.rejectWithDependents(id)[0] ?? null;
  }

  /** Like reject(), but returns every op it rejected: `id` first, then the ops that waited for it. */
  rejectWithDependents(id) {
    const op = this.#ops.get(id);
    if (!op || (op.status !== 'pending' && op.status !== 'stale-conflict')) return [];
    const rejected = this.#rejectCascade(op);
    this.#persistNow(); // Synchronous persist for state finalization
    return rejected;
  }

  #rejectCascade(op, out = []) {
    op.status = 'rejected';
    this.emit('rejected', op);
    this.#ops.delete(op.id);
    out.push(op);
    for (const dep of this.listDependents(op.id)) {
      if (dep.status === 'pending' || dep.status === 'stale-conflict') this.#rejectCascade(dep, out);
    }
    return out;
  }

  /** Ops still waiting for `parentId` (see stage's dependsOn), in staging order. */
  listDependents(parentId) {
    if (!parentId) return [];
    return [...this.#ops.values()].filter(op => op.dependsOn === parentId);
  }

  /**
   * `parentId` ran: let the pending ops that waited for it run too. `fill(op)` completes
   * each one from the parent's result (the new record's id, say) before it is released.
   * Their clock restarts — they could not run until now. Returns the released ops.
   */
  releaseDependents(parentId, fill = null) {
    const released = [];
    const now = Date.now();
    for (const op of this.listDependents(parentId)) {
      if (op.status !== 'pending') continue;
      if (typeof fill === 'function') fill(op);
      op.dependsOn = null;
      op.resolvedFrom = parentId;
      op.expiresAt = this.#noExpiry ? null : now + this.#ttlMs;
      released.push(op);
    }
    if (released.length) this.#persistNow();
    return released;
  }

  /** Mark an approved operation as executed. Stores result and cleans up. */
  markExecuted(id, result) {
    const op = this.#ops.get(id);
    if (!op) return null;
    op.status = 'executed';
    this.emit('executed', op, result);
    this.#ops.delete(id);
    this.#persistNow(); // Synchronous persist for state finalization
    return op;
  }

  /**
   * Mark an operation as failed.
   * Increments retryCount; if retries exhausted, moves to dead-letter queue.
   * @param {string} id
   * @param {string} err   - Error message
   * @param {number} [statusCode] - HTTP status code from CRM response
   */
  markFailed(id, err, statusCode) {
    const op = this.#ops.get(id);
    if (!op) return null;
    op.retryCount = (op.retryCount ?? 0) + 1;
    op.lastError = {
      error: typeof err === 'string' ? err : String(err ?? 'unknown'),
      code: statusCode ?? null,
      attempt: op.retryCount,
      failedAt: new Date().toISOString(),
    };
    this.emit('op:error', op, err);

    if (op.retryCount >= MAX_RETRIES) {
      op.status = 'failed';
      this.#deadLetterQueue.push(op);
      this.emit('op:dead-letter', op);
    } else {
      // Keep in map so caller can retry — refresh TTL
      op.status = 'pending';
      op.expiresAt = this.#noExpiry ? null : Date.now() + this.#ttlMs;
    }
    this.#persist();
    return op;
  }

  /**
   * Mark an operation as stale-conflict (412 Precondition Failed).
   * Does NOT move to dead-letter; keeps it for re-review or override.
   * @param {string} id
   */
  markStaleConflict(id) {
    const op = this.#ops.get(id);
    if (!op) return null;
    op.status = 'stale-conflict';
    this.emit('stale-conflict', op);
    this.#persistNow(); // Synchronous persist for state finalization (same as markExecuted/markFailed)
    return op;
  }

  /** Get a single operation by ID. */
  get(id) {
    const op = this.#ops.get(id);
    if (op && op.status === 'pending' && this.#ttlExpired(op, Date.now())) {
      op.status = 'expired';
      this.emit('expired', op);
      this.#ops.delete(id);
      this.#persist();
      return null;
    }
    return op ?? null;
  }

  // An op waiting for one that is still queued but no longer pending (dead-lettered, say) is
  // parked with it: it can't run, so it isn't pending — not to PLAY, the drawer or cancel-all.
  // It follows that op: back to pending if it is retried, expired once it is cleared.
  #parked(op) {
    if (!op.dependsOn) return false;
    const waitsFor = this.#ops.get(op.dependsOn);
    return !!waitsFor && waitsFor.status !== 'pending';
  }

  /** List all pending operations. */
  listPending({ actor = null, sessionId = null } = {}) {
    this.#sweep();
    let ops = [...this.#ops.values()].filter(op => op.status === 'pending' && !this.#parked(op));
    if (actor !== null) {
      ops = ops.filter(op => op.actor === actor);
    }
    if (sessionId !== null) {
      ops = ops.filter(op => op.sessionId === sessionId);
    }
    return ops;
  }

  /** List all operations regardless of status (still in map). */
  listAll() {
    this.#sweep();
    return [...this.#ops.values()];
  }

  /** Get the raw ops Map for direct access (e.g., filtering stale-conflict). */
  getAll() {
    return this.#ops;
  }

  /** Number of pending operations. */
  get pendingCount() {
    return this.listPending({}).length;
  }

  /** Approve all pending operations. Returns approved ops. */
  approveAll() {
    const approved = [];
    for (const op of this.#ops.values()) {
      if (op.status === 'pending') {
        const result = this.approve(op.id);
        if (result) approved.push(result);
      }
    }
    return approved;
  }

  /** Reject all pending operations (and the ops waiting for them). Returns rejected ops. */
  rejectAll() {
    const rejected = [];
    for (const op of [...this.#ops.values()]) {
      // An op rejected with the one it waited for is no longer pending when it's reached.
      if (op.status === 'pending' && !this.#parked(op)) rejected.push(...this.#rejectCascade(op));
    }
    if (rejected.length) this.#persistNow();
    return rejected;
  }

  /** Return all operations in the dead-letter queue. */
  getDeadLetterQueue() {
    return [...this.#deadLetterQueue];
  }

  /** Move a failed op from the dead-letter queue back to pending. */
  retryFromDeadLetter(id) {
    const idx = this.#deadLetterQueue.findIndex(op => op.id === id);
    if (idx === -1) return null;
    const op = this.#deadLetterQueue[idx];
    this.#deadLetterQueue.splice(idx, 1);
    op.retryCount = 0;
    op.status = 'pending';
    op.lastError = null;
    op.expiresAt = this.#noExpiry ? null : Date.now() + this.#ttlMs;
    this.#persist();
    return op;
  }

  /** Permanently remove an op from the dead-letter queue. */
  clearDeadLetter(id) {
    const idx = this.#deadLetterQueue.findIndex(op => op.id === id);
    if (idx === -1) return null;
    const [op] = this.#deadLetterQueue.splice(idx, 1);
    this.#ops.delete(id);
    this.#persist();
    return op;
  }

  /** Clear the entire queue (for testing / shutdown). */
  clear() {
    this.#ops.clear();
    this.#deadLetterQueue.length = 0;
    this.#persist();
  }

  /** Stop the sweep timer (for clean shutdown). */
  dispose() {
    clearInterval(this.#sweepTimer);
    if (this.#persistDebounceTimer) {
      clearTimeout(this.#persistDebounceTimer);
      this.#persistNow(); // Flush final state
    }
  }

  /** Set TTL for new operations. Pass null to disable expiry. */
  setTtl(ms) {
    if (ms === null) {
      this.#noExpiry = true;
      this.#ttlMs = DEFAULT_TTL_MS; // Keep a default for fallback
    } else {
      this.#noExpiry = false;
      this.#ttlMs = ms;
    }
  }

  /** Disable expiry for new operations. */
  setNoExpiry(enabled) {
    this.#noExpiry = enabled;
  }

  /** Get current no-expiry state. */
  get noExpiry() {
    return this.#noExpiry;
  }

  // An op waiting for another can't run before it, so it never times out on its own
  // while that op is still queued: expiring it first would strand the record it completes.
  #ttlExpired(op, now) {
    if (op.expiresAt === null || op.expiresAt === undefined || now <= op.expiresAt) return false;
    return !(op.dependsOn && this.#ops.has(op.dependsOn));
  }

  // Expire stale operations + janitor for genuinely abandoned ops
  #sweep() {
    const now = Date.now();
    let mutated = false;
    for (const [id, op] of this.#ops) {
      // Regular TTL expiry (skip if expiresAt is null). An op whose dependency is gone
      // (rejected, expired or cleared) can never run either. Map order puts a dependency
      // before its dependents, so one that expires here takes them with it in this pass.
      const orphaned = !!op.dependsOn && !this.#ops.has(op.dependsOn);
      if (op.status === 'pending' && (orphaned || this.#ttlExpired(op, now))) {
        op.status = 'expired';
        this.emit('expired', op);
        this.#ops.delete(id);
        mutated = true;
      }
      // Janitor: clean up genuinely old ops (> 7 days) regardless of expiresAt
      const stagedTime = new Date(op.stagedAt).getTime();
      if (now - stagedTime > JANITOR_MAX_AGE_MS) {
        if (op.status === 'pending' || op.status === 'approved') {
          op.status = 'expired';
          this.emit('expired', op);
          this.#ops.delete(id);
          mutated = true;
        }
      }
    }
    if (mutated) {
      this.#persist();
    }
  }

  // Persist queue to disk (debounced, best-effort)
  #persist() {
    if (this.#persistDebounceTimer) {
      clearTimeout(this.#persistDebounceTimer);
    }
    this.#persistDebounceTimer = setTimeout(() => {
      this.#persistNow();
    }, 100);
    if (this.#persistDebounceTimer.unref) {
      this.#persistDebounceTimer.unref();
    }
  }

  #persistNow() {
    try {
      const dataDir = resolveDataDir(this.#dataDir);
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      const queueFile = join(dataDir, 'approval-queue.json');
      const tempFile = join(dataDir, `approval-queue.json.tmp.${Date.now()}`);
      const bakFile = join(dataDir, 'approval-queue.json.bak');
      const state = {
        counter: this.#counter,
        ops: [...this.#ops.values()],
        deadLetterQueue: this.#deadLetterQueue,
      };
      const json = JSON.stringify(state, null, 2);
      
      // Atomic write: write to temp, then rename over target
      writeFileSync(tempFile, json, 'utf8');
      
      // Backup last-good state if exists
      if (existsSync(queueFile)) {
        try {
          writeFileSync(bakFile, readFileSync(queueFile, 'utf8'), 'utf8');
        } catch {
          // Best-effort backup
        }
      }
      
      renameSync(tempFile, queueFile);
    } catch (err) {
      // Best-effort — never crash
      if (process.env.NODE_ENV !== 'test') {
        console.error('[approval-queue] Failed to persist:', err.message ?? String(err));
      }
    }
  }

  // Rehydrate queue from disk on startup
  #rehydrate() {
    try {
      const dataDir = resolveDataDir(this.#dataDir);
      const queueFile = join(dataDir, 'approval-queue.json');
      if (!existsSync(queueFile)) return;

      const content = readFileSync(queueFile, 'utf8');
      if (!content || !content.trim()) return; // Empty file

      const state = JSON.parse(content);

      // Calculate max counter from all sources for continuity
      let maxCounter = globalCounter;
      if (typeof state.counter === 'number') {
        maxCounter = Math.max(maxCounter, state.counter);
      }

      // Restore operations and find max op number
      if (Array.isArray(state.ops)) {
        for (const op of state.ops) {
          this.#ops.set(op.id, op);
          // Parse OP-N to avoid collisions
          const match = op.id.match(/^OP-(\d+)$/);
          if (match) {
            const opNum = parseInt(match[1], 10);
            maxCounter = Math.max(maxCounter, opNum);
          }
        }
      }

      // Restore dead-letter queue and check for max op number
      if (Array.isArray(state.deadLetterQueue)) {
        this.#deadLetterQueue.push(...state.deadLetterQueue);
        for (const op of state.deadLetterQueue) {
          const match = op.id.match(/^OP-(\d+)$/);
          if (match) {
            const opNum = parseInt(match[1], 10);
            maxCounter = Math.max(maxCounter, opNum);
          }
        }
      }

      // Set counter to max to prevent collisions
      this.#counter = maxCounter;
      globalCounter = maxCounter;
    } catch (err) {
      // Best-effort — log but continue (ignore in tests)
      if (process.env.NODE_ENV !== 'test') {
        console.error('[approval-queue] Failed to rehydrate:', err.message ?? String(err));
      }
    }
  }
}

/** Singleton instance — shared across MCP tools and external consumers. */
let _instance = null;

export function getApprovalQueue(opts) {
  if (!_instance) {
    // In test env, use a temp directory by default to avoid cross-test pollution
    const defaultOpts = process.env.NODE_ENV === 'test' 
      ? { ...opts, dataDir: opts?.dataDir ?? mkdtempSync(join(tmpdir(), 'queue-singleton-')) }
      : opts;
    _instance = new ApprovalQueue(defaultOpts);
  }
  return _instance;
}

/** Reset singleton (for testing). */
export function resetApprovalQueue() {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
  globalCounter = 0;
}
