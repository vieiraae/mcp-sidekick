// Tests for the MCEM stage-transition etag-churn resilience (executeMcemStageTransition)
// and its patchStageWithChurnRetry helper.
//
// Bug: on opps with many milestones, Dynamics async-processes the stage transition
// (checklist rollups + milestone recalcs), churning the opportunity/BPF etag. A PATCH
// whose etag was fresh a moment ago can still 412 → the stage op hard-failed (no retry).
// Separately, re-executing a move whose target was already reached raised a false
// "BPF state changed" 409 even though the opp was where the user wanted it.
//
// Fix: retry stage PATCHes on 412 with a re-read etag; treat "already at target" as a
// no-op success (idempotent); retry the post-move verify to ride out read-after-write lag.
import { describe, it, expect, vi } from 'vitest';
import { executeMcemStageTransition, patchStageWithChurnRetry } from '../tools.js';

// Real MCEM stage GUIDs (from tools.js MCEM_STAGES)
const STAGE = {
  1: '60b911e7-32fb-4490-98c7-a9d3e06a6492', // Listen & Consult
  2: 'f5a927f6-03c6-45fc-a8af-70adc140d470', // Inspire & Design
  3: '937a8569-d7e5-41b4-a4a3-2f74cec5a6d9', // Empower & Achieve
};

// ── Router mock for executeMcemStageTransition ──────────────────────────────────
// Drives currentStage via a single mutable BPF stage id. The BPF move PATCH follows
// a caller-supplied status sequence; on success it advances the stage (optionally
// after `verifyLag` stale read-backs, to simulate read-after-write lag).
function makeStageCrm({ startStageId, movePatchStatuses = [{ ok: true, status: 204 }], verifyLag = 0 }) {
  const INSTANCE_ID = 'bpf-instance-0001';
  const BPF_ES = 'bpf_msp_mcemprocesses';
  const state = {
    stageId: startStageId,
    preMoveStageId: startStageId,
    lagRemaining: 0,
    traversedpath: `${STAGE[1]},${STAGE[2]}`,
  };
  const calls = { movePatch: 0, oppPatch: 0, bpfGet: 0, bpfRetrieve: 0 };

  const bpfStageForRead = () => {
    // After a move, return the stale pre-move stage for the first `verifyLag` reads.
    if (state.lagRemaining > 0) {
      state.lagRemaining--;
      return state.preMoveStageId;
    }
    return state.stageId;
  };

  const request = vi.fn(async (path, opts = {}) => {
    const method = opts.method;
    if (path.startsWith('RetrieveProcessInstances')) {
      calls.bpfRetrieve++;
      return { ok: true, status: 200, data: { value: [{
        businessprocessflowinstanceid: INSTANCE_ID,
        _activestageid_value: state.stageId,
        traversedpath: state.traversedpath,
        entitysetname: BPF_ES,
      }] } };
    }
    if (path.startsWith("EntityDefinitions(LogicalName='msp_mcemprocess')")) {
      return { ok: true, status: 200, data: { LogicalName: 'msp_mcemprocess', EntitySetName: BPF_ES } };
    }
    if (path.startsWith(`${BPF_ES}(`)) {
      if (method === 'PATCH') {
        const idx = Math.min(calls.movePatch, movePatchStatuses.length - 1);
        const res = movePatchStatuses[idx];
        calls.movePatch++;
        if (res.ok || res.status === 204) {
          const bind = opts.body?.['activestageid@odata.bind'] || '';
          const m = bind.match(/processstages\(([^)]+)\)/);
          if (m) {
            state.preMoveStageId = state.stageId;
            state.stageId = m[1];
            state.lagRemaining = verifyLag;
          }
        }
        return res;
      }
      calls.bpfGet++;
      return { ok: true, status: 200, data: {
        businessprocessflowinstanceid: INSTANCE_ID,
        _activestageid_value: bpfStageForRead(),
        traversedpath: state.traversedpath,
        '@odata.etag': `W/"bpf-${calls.bpfGet}"`,
      } };
    }
    if (path.startsWith('opportunities(')) {
      if (method === 'PATCH') { calls.oppPatch++; return { ok: true, status: 204 }; }
      return { ok: true, status: 200, data: { opportunityid: 'opp-1', '@odata.etag': 'W/"opp-1"' } };
    }
    return { ok: true, status: 200, data: {} };
  });

  const requestAllPages = vi.fn(async (path) => {
    if (path === 'EntityDefinitions') {
      return { ok: true, status: 200, data: { value: [{ LogicalName: 'msp_mcemprocess', EntitySetName: BPF_ES }] } };
    }
    return { ok: true, status: 200, data: { value: [] } };
  });

  return { crm: { request, requestAllPages, search: vi.fn(), buildUrl: vi.fn(), getCrmUrl: () => 'https://t' }, state, calls };
}

function backwardOp() {
  // Backward move Inspire & Design (2) -> Listen & Consult (1), empty payload (skips opp PATCH).
  return { stagePlan: { opportunityId: 'opp-1', steps: [{
    from: { number: 2, name: 'Inspire & Design' },
    to: { number: 1, name: 'Listen & Consult' },
    targetStageId: STAGE[1],
    direction: 'backward',
    opportunityPayload: {},
  }] } };
}

describe('patchStageWithChurnRetry', () => {
  const REFETCHED = 'W/"fresh"';

  it('returns immediately on first-try success (no refetch)', async () => {
    const request = vi.fn(async () => ({ ok: true, status: 204 }));
    const refetch = vi.fn(async () => REFETCHED);
    const res = await patchStageWithChurnRetry({ request }, 'x(1)', { a: 1 }, 'W/"e0"', refetch);
    expect(res.status).toBe(204);
    expect(request).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('retries once on 412, re-reading a fresh etag, then succeeds', async () => {
    const seq = [{ ok: false, status: 412, data: { message: 'stale' } }, { ok: true, status: 204 }];
    let i = 0;
    const request = vi.fn(async (_p, opts) => seq[i++] ?? seq[seq.length - 1]);
    const refetch = vi.fn(async () => REFETCHED);
    const res = await patchStageWithChurnRetry({ request }, 'x(1)', { a: 1 }, 'W/"e0"', refetch);
    expect(res.status).toBe(204);
    expect(request).toHaveBeenCalledTimes(2);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Second attempt must use the freshly re-read etag.
    expect(request.mock.calls[1][1].etag).toBe(REFETCHED);
  });

  it('does NOT retry a non-412 error (returns it immediately)', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 500, data: { message: 'boom' } }));
    const refetch = vi.fn(async () => REFETCHED);
    const res = await patchStageWithChurnRetry({ request }, 'x(1)', {}, 'W/"e0"', refetch);
    expect(res.status).toBe(500);
    expect(request).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('gives up and returns the last 412 after exhausting retries', async () => {
    // Driven on FAKE timers. The helper's backoff ladder is [0, 250, 500, 900,
    // 1400] ms, so exhausting it spends 3,050 ms of real sleeping — the single
    // slowest test in this workspace, and ~40% of its whole runtime, for no
    // signal: what is under test is "five attempts, then return the last 412",
    // not how long Node can sleep. See `npm run test:census`.
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ ok: false, status: 412, data: { message: 'stale' } }));
      const refetch = vi.fn(async () => REFETCHED);
      const pending = patchStageWithChurnRetry({ request }, 'x(1)', {}, 'W/"e0"', refetch);
      // Each backoff is awaited between attempts, so the timers only appear as
      // the retries unfold — advance repeatedly rather than once.
      await vi.runAllTimersAsync();
      const res = await pending;
      expect(res.status).toBe(412);
      expect(request).toHaveBeenCalledTimes(5); // STAGE_PATCH_CHURN_BACKOFFS_MS length
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executeMcemStageTransition — etag-churn resilience', () => {
  it('recovers from a transient 412 on the BPF move PATCH (retries, then succeeds)', async () => {
    const { crm, calls } = makeStageCrm({
      startStageId: STAGE[2], // at "from"
      movePatchStatuses: [{ ok: false, status: 412, data: { message: 'stale-conflict' } }, { ok: true, status: 204 }],
    });
    const res = await executeMcemStageTransition(crm, backwardOp());
    expect(res.ok).toBe(true);
    expect(calls.movePatch).toBe(2); // 412 then 204
    expect(res.data.executedSteps[0]).toMatchObject({ to: 'Listen & Consult', verified: true });
  });

  it('is idempotent: already at the target stage → success with no PATCH (no false "state changed")', async () => {
    const { crm, calls } = makeStageCrm({ startStageId: STAGE[1] }); // already at target (1)
    const res = await executeMcemStageTransition(crm, backwardOp());
    expect(res.ok).toBe(true);
    expect(calls.movePatch).toBe(0);
    expect(res.data.executedSteps[0]).toMatchObject({ alreadyApplied: true });
  });

  it('still rejects a genuine unexpected stage (neither from nor target) with 409', async () => {
    const { crm, calls } = makeStageCrm({ startStageId: STAGE[3] }); // at stage 3, expected from=2/to=1
    const res = await executeMcemStageTransition(crm, backwardOp());
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.message).toMatch(/BPF state changed before execution/);
    expect(calls.movePatch).toBe(0);
  });

  it('tolerates read-after-write lag on the post-move verify', async () => {
    const { crm } = makeStageCrm({
      startStageId: STAGE[2],
      movePatchStatuses: [{ ok: true, status: 204 }],
      verifyLag: 1, // first verify read still shows the old stage
    });
    const res = await executeMcemStageTransition(crm, backwardOp());
    expect(res.ok).toBe(true);
    expect(res.data.executedSteps[0]).toMatchObject({ verified: true });
  });
});
