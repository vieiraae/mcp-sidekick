// Vitest setup for mcp/msx — redirect all local data writes (audit log NDJSON,
// approval-queue persistence) to a throwaway temp dir so tests never pollute the
// real user-data dir (MSX_USER_DATA / %AppData% / ~/.msx-iq-data).
//
// Tests that intentionally exercise the "MSX_USER_DATA unset" fallback manage the
// env var themselves (set/delete + restore), so this global default does not
// interfere with them.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.MSX_USER_DATA) {
  process.env.MSX_USER_DATA = mkdtempSync(join(tmpdir(), 'msx-test-data-'));
}
