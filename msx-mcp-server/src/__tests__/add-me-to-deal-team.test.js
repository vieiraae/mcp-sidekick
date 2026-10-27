import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue } from '../approval-queue.js';

const OPP_ID = '11111111-1111-1111-1111-111111111111';
const ME = 'AAAAAAAA-0000-0000-0000-000000000001';

function makeCrm({ who = { ok: true, status: 200, data: { UserId: ME } }, members = [], opp = { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Contoso Deal' } } } = {}) {
  return {
    request: vi.fn(async (path) => {
      if (path === 'WhoAmI') return who;
      if (path.startsWith('opportunities(')) return opp;
      if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { fullname: 'Alex Vieira' } };
      return { ok: true, status: 200, data: {} };
    }),
    requestAllPages: vi.fn(async (path) => {
      if (path === 'teams') {
        return { ok: true, status: 200, data: { value: members === null ? [] : [{ teamid: 't1', teammembership_association: members }] } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    }),
    search: vi.fn(),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com'),
  };
}

async function call(crm, args) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerTools(server, crm);
  const result = await server._registeredTools.add_me_to_deal_team.handler(args);
  return { result, parsed: result.isError ? null : JSON.parse(result.content[0].text) };
}

describe('add_me_to_deal_team', () => {
  beforeEach(() => resetApprovalQueue());

  it('stages AddUserToRecordTeam for the WhoAmI user', async () => {
    const { parsed } = await call(makeCrm({ members: null }), { opportunityId: OPP_ID, reason: 'joining pursuit' });

    expect(parsed.staged).toBe(true);
    expect(parsed.alreadyMember).toBe(false);
    expect(parsed.systemUserId).toBe(ME.toLowerCase());
    expect(parsed.description).toContain('Alex Vieira');
    expect(parsed.description).toContain('Contoso Deal');

    const op = getApprovalQueue().get(parsed.operationId);
    expect(op.type).toBe('add_deal_team_member');
    expect(op.method).toBe('POST');
    expect(op.entitySet).toBe(`systemusers(${ME.toLowerCase()})/Microsoft.Dynamics.CRM.AddUserToRecordTeam`);
    expect(op.payload.Record.opportunityid).toBe(OPP_ID);
    expect(op.payload.TeamTemplate.teamtemplateid).toBeTruthy();
    expect(op.reason).toBe('joining pursuit');
  });

  it('stages when the team exists without the current user', async () => {
    const { parsed } = await call(makeCrm({ members: [{ systemuserid: 'bbbbbbbb-0000-0000-0000-000000000002' }] }), { opportunityId: OPP_ID });
    expect(parsed.staged).toBe(true);
  });

  it('does not stage when already a member', async () => {
    const { parsed } = await call(makeCrm({ members: [{ systemuserid: ME.toLowerCase() }] }), { opportunityId: OPP_ID });

    expect(parsed.staged).toBe(false);
    expect(parsed.alreadyMember).toBe(true);
    expect(getApprovalQueue().listPending()).toHaveLength(0);
  });

  it('errors when WhoAmI fails', async () => {
    const { result } = await call(makeCrm({ who: { ok: false, status: 401, data: { message: 'Unauthorized' } } }), { opportunityId: OPP_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unable to resolve current CRM user');
  });

  it('errors when the opportunity is not found', async () => {
    const { result } = await call(makeCrm({ opp: { ok: false, status: 404, data: { message: 'Not found' } } }), { opportunityId: OPP_ID });
    expect(result.isError).toBe(true);
    expect(getApprovalQueue().listPending()).toHaveLength(0);
  });
});
