import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, ALLOWED_ENTITY_SETS, CRM_QUERY_MAX_RECORDS, isEntityAllowed, MILESTONE_CATEGORIES, resetSolutionSalesPlayCache } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue } from '../approval-queue.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChangeRecord } from '../audit-store.js';
import { makeChangeRecord } from '../change-record.js';

// Build a mock CRM client that records calls and returns configurable responses
function mockCrmClient(responses = {}) {
  return {
    request: vi.fn(async (path, opts) => {
      if (responses[path]) return responses[path];
      // Default: success with empty data
      return { ok: true, status: 200, data: {} };
    }),
    requestAllPages: vi.fn(async (path, opts) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 200, data: { value: [] } };
    }),
    search: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com')
  };
}

// Helper: call a registered tool by invoking the server's tool handler
async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

// Helper: mock requestAllPages to return a specific play map (for getSolutionAreaSalesPlayMap resolution)
// plays: [{ id, playValue, globalSolutionArea, solutionArea }]
function mockPlayMap(crm, plays) {
  const books = plays.map(p => ({ msp_accountplansalesplaybookid: p.id, msp_name: `Play ${p.playValue}`, msp_globalsolutionarea: p.globalSolutionArea }));
  const extensions = plays.map(p => ({ _msp_solutionplaybook_value: p.id, msp_priorityplay: null, msp_subsegment: null, msp_area: null }));
  const mappings = plays.map(p => ({ _msp_salesplayid_value: p.id, msp_salesplayoptionset: p.playValue, msp_opportunitysolutionarea: p.solutionArea, msp_solutionareaglobal: p.globalSolutionArea }));
  crm.requestAllPages.mockImplementation(async (path) => {
    if (path === 'msp_salesplaymappings') return { ok: true, status: 200, data: { value: mappings } };
    if (path === 'msp_accountplansalesplaybooks') return { ok: true, status: 200, data: { value: books } };
    if (path === 'msp_solutionplayextensions') return { ok: true, status: 200, data: { value: extensions } };
    return { ok: true, status: 200, data: { value: [] } };
  });
}

describe('registerTools', () => {
  let server;
  let crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'abc-123', BusinessUnitId: 'bu-1' } }
    });
    registerTools(server, crm);
  });

  it('registers all expected tools', () => {
    const toolNames = Object.keys(server._registeredTools);
    expect(toolNames).toContain('crm_whoami');
    expect(toolNames).toContain('crm_query');
    expect(toolNames).toContain('crm_get_record');
    expect(toolNames).toContain('list_opportunities');
    expect(toolNames).toContain('get_my_active_opportunities');
    expect(toolNames).toContain('get_milestones');
    expect(toolNames).toContain('create_milestone');
    expect(toolNames).toContain('create_task');
    expect(toolNames).toContain('update_task');
    expect(toolNames).toContain('close_task');
    expect(toolNames).toContain('update_milestone');
    expect(toolNames).toContain('list_accounts_by_tpid');
    expect(toolNames).toContain('get_milestone_field_options');
    expect(toolNames).toContain('get_task_status_options');
    expect(toolNames).toContain('get_milestone_activities');
    expect(toolNames).toContain('find_milestones_needing_tasks');
    expect(toolNames).toContain('crm_auth_status');
    expect(toolNames).toContain('view_milestone_timeline');
    expect(toolNames).toContain('view_opportunity_cost_trend');
    expect(toolNames).toContain('mcem_stage_preflight');
    expect(toolNames).toContain('update_opportunity_stage');
    expect(toolNames).toContain('query_audit_log');
    expect(toolNames).toContain('get_audit_entry');
    expect(toolNames).toContain('view_staged_changes_diff');
    expect(toolNames).toContain('list_pending_operations');
    expect(toolNames).toContain('execute_operation');
    expect(toolNames).toContain('execute_all');
    expect(toolNames).toContain('cancel_operation');
    expect(toolNames).toContain('cancel_all');
    expect(toolNames).toContain('get_team_accounts');
    expect(toolNames).toContain('crm_creation_lookup_search');
    expect(toolNames).toContain('create_opportunity_preflight');
    expect(toolNames).toContain('create_opportunity');
    expect(toolNames).toContain('delete_opportunity');
    expect(toolNames).toContain('change_owner');
    expect(toolNames).toContain('create_milestone_preflight');
  });

  describe('crm_whoami', () => {
    it('returns user data on success', async () => {
      const result = await callTool(server, 'crm_whoami');
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('abc-123');
    });

    it('returns error when CRM is unreachable', async () => {
      crm.request.mockResolvedValueOnce({ ok: false, status: 500, data: { message: 'Server error' } });
      const result = await callTool(server, 'crm_whoami');
      expect(result.isError).toBe(true);
    });
  });

  describe('crm_query', () => {
    it('requires entitySet', async () => {
      const result = await callTool(server, 'crm_query', {});
      expect(result.isError).toBe(true);
    });

    it('blocks queries to entity sets not in the allowlist', async () => {
      const result = await callTool(server, 'crm_query', {
        entitySet: 'emails',
        select: 'subject'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not in the allowed list');
      expect(crm.requestAllPages).not.toHaveBeenCalled();
    });

    it('allows queries to permitted entity sets', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ name: 'Test' }] }
      });
      const result = await callTool(server, 'crm_query', {
        entitySet: 'opportunities',
        select: 'name'
      });
      expect(result.isError).toBeUndefined();
      expect(crm.requestAllPages).toHaveBeenCalled();
    });

    it('passes query params to requestAllPages with maxRecords', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ name: 'Test' }] }
      });
      const result = await callTool(server, 'crm_query', {
        entitySet: 'accounts',
        filter: "name eq 'Test'",
        select: 'name,accountid',
        top: 5
      });
      expect(result.isError).toBeUndefined();
      expect(crm.requestAllPages).toHaveBeenCalledWith('accounts', {
        query: expect.objectContaining({
          $filter: "name eq 'Test'",
          $select: 'name,accountid',
          $top: '5'
        }),
        maxRecords: CRM_QUERY_MAX_RECORDS
      });
    });

    it('caps top to CRM_QUERY_MAX_RECORDS when top exceeds limit', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      await callTool(server, 'crm_query', {
        entitySet: 'accounts',
        top: 99999
      });
      expect(crm.requestAllPages).toHaveBeenCalledWith('accounts', {
        query: expect.objectContaining({
          $top: String(CRM_QUERY_MAX_RECORDS)
        }),
        maxRecords: CRM_QUERY_MAX_RECORDS
      });
    });

    it('lowercases _*_value lookup tokens in filter/select/orderby/expand (#5 deterministic casing fix)', async () => {
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      await callTool(server, 'crm_query', {
        entitySet: 'opportunities',
        filter: "_msp_OpportunityId_value eq 'abc' and _OwnerId_value ne null",
        select: 'name,_msp_OpportunityId_value',
        orderby: '_OwnerId_value desc',
        expand: '_msp_OpportunityId_value'
      });
      const call = crm.requestAllPages.mock.calls.find(c => c[0] === 'opportunities');
      expect(call).toBeTruthy();
      const q = call[1].query;
      // Lookup tokens are lowercased; values ('abc') and other identifiers are untouched.
      expect(q.$filter).toContain("_msp_opportunityid_value eq 'abc'");
      expect(q.$filter).toContain('_ownerid_value ne null');
      expect(q.$filter).not.toContain('_msp_OpportunityId_value');
      expect(q.$filter).not.toContain('_OwnerId_value');
      expect(q.$select).toBe('name,_msp_opportunityid_value');
      expect(q.$orderby).toBe('_ownerid_value desc');
      expect(q.$expand).toBe('_msp_opportunityid_value');
    });
  });

  describe('crm_get_record', () => {
    it('rejects invalid GUID', async () => {
      const result = await callTool(server, 'crm_get_record', {
        entitySet: 'accounts',
        id: 'not-a-guid'
      });
      expect(result.isError).toBe(true);
    });

    it('blocks entity sets not in the allowlist', async () => {
      const result = await callTool(server, 'crm_get_record', {
        entitySet: 'annotations',
        id: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not in the allowed list');
      expect(crm.request).not.toHaveBeenCalledWith(
        expect.stringContaining('annotations'),
        expect.anything()
      );
    });

    it('fetches a single record from an allowed entity', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: { accountid: '12345678-1234-1234-1234-123456789abc', name: 'Contoso' }
      });
      const result = await callTool(server, 'crm_get_record', {
        entitySet: 'accounts',
        id: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Contoso');
    });
  });

  describe('list_opportunities', () => {
    it('rejects when neither accountIds nor customerKeyword provided', async () => {
      const result = await callTool(server, 'list_opportunities', {});
      expect(result.isError).toBe(true);
    });

    it('loads opportunities for valid account IDs', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ opportunityid: 'opp-1', name: 'Deal A' }] }
      });
      const result = await callTool(server, 'list_opportunities', {
        accountIds: ['12345678-1234-1234-1234-123456789abc']
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
    });

    it('resolves accounts from customerKeyword and returns opportunities', async () => {
      // First call: account search by keyword
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { accountid: '11111111-1111-1111-1111-111111111111', name: 'Contoso Corp' }
        ] }
      });
      // Second call: opportunities for resolved account
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'Contoso Azure Migration' }
        ] }
      });
      const result = await callTool(server, 'list_opportunities', { customerKeyword: 'Contoso' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.opportunities[0].name).toBe('Contoso Azure Migration');
      // Verify account search was called with contains filter
      expect(crm.requestAllPages).toHaveBeenCalledWith('accounts', expect.objectContaining({
        query: expect.objectContaining({ $filter: expect.stringContaining('contains(name') })
      }));
    });

    it('returns empty when customerKeyword matches no accounts', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'list_opportunities', { customerKeyword: 'NonexistentCorp' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.message).toContain('NonexistentCorp');
    });
  });

  describe('get_milestones', () => {
    it('returns scoping error when no filter is provided', async () => {
      const result = await callTool(server, 'get_milestones', {});
      expect(result.isError).toBe(true);
      const msg = result.content[0].text;
      expect(msg).toContain('Scoping required');
    });

    it('returns an error if mine is disabled and no identifiers are provided', async () => {
      const result = await callTool(server, 'get_milestones', { mine: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Scoping required');
    });

    it('searches by milestone number', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ msp_milestonenumber: '7-123456789' }] }
      });
      const result = await callTool(server, 'get_milestones', { milestoneNumber: '7-123456789' });
      expect(result.isError).toBeUndefined();
    });

    it('supports ownerId filter', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ msp_milestonenumber: '7-123456780' }] }
      });
      const result = await callTool(server, 'get_milestones', {
        ownerId: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBeUndefined();
      expect(crm.requestAllPages).toHaveBeenCalledWith(
        'msp_engagementmilestones',
        {
          query: expect.objectContaining({
            $filter: "_ownerid_value eq '12345678-1234-1234-1234-123456789abc'"
          })
        }
      );
    });

    it('includes azureRegion and azureCapacity fields in compact projection', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-1',
          msp_milestonenumber: '7-123456789',
          msp_name: 'Test Milestone',
          msp_milestonepreferredazureregion: 861980001,
          'msp_milestonepreferredazureregion@OData.Community.Display.V1.FormattedValue': 'West Europe',
          msp_milestoneazurecapacitytype: '861980081,861980065',
          'msp_milestoneazurecapacitytype@OData.Community.Display.V1.FormattedValue': 'Azure OpenAI Service, Azure SQL Database',
          msp_milestonestatus: 861980000,
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          msp_commitmentrecommendation: 861980003,
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].azureRegion).toBe('West Europe');
      expect(parsed.milestones[0].azureRegionCode).toBe(861980001);
      expect(parsed.milestones[0].azureCapacityType).toBe('Azure OpenAI Service, Azure SQL Database');
      expect(parsed.milestones[0].azureCapacityCode).toBe('861980081,861980065');
      expect(parsed.milestones[0].hasAzureRegion).toBe(true);
      expect(parsed.milestones[0].hasAzureCapacityType).toBe(true);
      expect(parsed.milestones[0].statusCode).toBe(861980000);
      expect(parsed.milestones[0].commitmentCode).toBe(861980003);
    });

    it('includes statusReason and statusReasonCode in compact projection', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-blocked',
          msp_milestonenumber: '7-999888777',
          msp_name: 'Blocked Milestone',
          msp_milestonestatusreason: 861980012,
          'msp_milestonestatusreason@OData.Community.Display.V1.FormattedValue': 'No Intent',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Blocked',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].statusReason).toBe('No Intent');
      expect(parsed.milestones[0].statusReasonCode).toBe(861980012);
    });

    it('includes null statusReason and statusReasonCode when absent', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-noreason',
          msp_milestonenumber: '7-111222333',
          msp_name: 'Milestone without statusReason',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].statusReason).toBe(null);
      expect(parsed.milestones[0].statusReasonCode).toBe(null);
    });

    it('triage compact carries azureRegionCode/azureCapacityCode + labels', async () => {
      // Phase 1 — buildMilestoneTriage must thread the raw region/capacity codes
      // (and labels) so the dashboard matrix can prefill the Update Capacity modal.
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-triage-1',
          msp_milestonenumber: '7-123456789',
          msp_name: 'Triage Milestone',
          msp_milestonepreferredazureregion: 861980001,
          'msp_milestonepreferredazureregion@OData.Community.Display.V1.FormattedValue': 'West Europe',
          msp_milestoneazurecapacitytype: '861980081,861980065',
          'msp_milestoneazurecapacitytype@OData.Community.Display.V1.FormattedValue': 'Azure OpenAI Service, Azure SQL Database',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // No date → active "On Track" status lands in the on_track bucket.
      const ms = parsed.on_track[0];
      expect(ms).toBeDefined();
      expect(ms.azureRegionCode).toBe(861980001);
      expect(ms.azureCapacityCode).toBe('861980081,861980065');
      expect(ms.azureRegion).toBe('West Europe');
      expect(ms.azureCapacityType).toBe('Azure OpenAI Service, Azure SQL Database');
    });

    it('triage compact carries workloadTypeCode (raw msp_milestoneworkload)', async () => {
      // Azure-scope fix — buildMilestoneTriage must thread the raw workload TYPE
      // optionset code so the dashboard scopes Azure nudges by TYPE (861980000),
      // NOT by the workload label (which can be prefixed e.g. "AI: Azure …").
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-triage-wt',
          msp_milestonenumber: '7-111222333',
          msp_name: 'AI: Azure Machine Learning',
          msp_milestoneworkload: 861980000,
          'msp_milestoneworkload@OData.Community.Display.V1.FormattedValue': 'Azure',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const ms = parsed.on_track[0];
      expect(ms).toBeDefined();
      expect(ms.workloadTypeCode).toBe(861980000);
    });

    it('triage compact carries null capacity codes when unset', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-triage-2',
          msp_milestonenumber: '7-987654321',
          msp_name: 'Bare Milestone',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const ms = parsed.on_track[0];
      expect(ms).toBeDefined();
      expect(ms.azureRegionCode).toBeNull();
      expect(ms.azureCapacityCode).toBeNull();
      expect(ms.workloadTypeCode).toBeNull();
    });

    it('detects missing region (None code 861980076)', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-1',
          msp_milestonenumber: '7-123456789',
          msp_milestonepreferredazureregion: 861980076,
          'msp_milestonepreferredazureregion@OData.Community.Display.V1.FormattedValue': 'None',
          msp_milestoneazurecapacitytype: '861980081',
          'msp_milestoneazurecapacitytype@OData.Community.Display.V1.FormattedValue': 'Azure OpenAI Service',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].hasAzureRegion).toBe(false);
      expect(parsed.milestones[0].hasAzureCapacityType).toBe(true);
    });

    it('detects missing capacity (None code 861980000 only)', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-1',
          msp_milestonenumber: '7-123456789',
          msp_milestonepreferredazureregion: 861980001,
          'msp_milestonepreferredazureregion@OData.Community.Display.V1.FormattedValue': 'West Europe',
          msp_milestoneazurecapacitytype: '861980000',
          'msp_milestoneazurecapacitytype@OData.Community.Display.V1.FormattedValue': 'None',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].hasAzureRegion).toBe(true);
      expect(parsed.milestones[0].hasAzureCapacityType).toBe(false);
    });

    it('detects capacity when None is mixed with real codes', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{
          msp_engagementmilestoneid: 'ms-1',
          msp_milestonenumber: '7-123456789',
          msp_milestonepreferredazureregion: 861980001,
          'msp_milestonepreferredazureregion@OData.Community.Display.V1.FormattedValue': 'West Europe',
          msp_milestoneazurecapacitytype: '861980000,861980081',
          'msp_milestoneazurecapacitytype@OData.Community.Display.V1.FormattedValue': 'None, Azure OpenAI Service',
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          _ownerid_value: 'abc-123'
        }] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].hasAzureCapacityType).toBe(true); // Mixed None+real = has
    });

    it('filters by capacityFilter: missing-region', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-1',
            msp_milestonenumber: '7-123456789',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980076, // None
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-2',
            msp_milestonenumber: '7-987654321',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980001, // West Europe
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, capacityFilter: 'missing-region' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('ms-1');
    });

    it('filters by capacityFilter: has-capacity', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-1',
            msp_milestonenumber: '7-123456789',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestoneazurecapacitytype: '861980081', // OpenAI
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-2',
            msp_milestonenumber: '7-987654321',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestoneazurecapacitytype: '861980000', // None
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, capacityFilter: 'has-capacity' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('ms-1');
    });

    it('filters by capacityFilter: missing-any', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-1',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980076, // None region
            msp_milestoneazurecapacitytype: '861980081', // has capacity
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-2',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980001, // has region
            msp_milestoneazurecapacitytype: '861980000', // None capacity
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-3',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980001, // has both
            msp_milestoneazurecapacitytype: '861980081',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, capacityFilter: 'missing-any' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
      expect(parsed.milestones.map(m => m.msp_engagementmilestoneid)).toEqual(['ms-1', 'ms-2']);
    });


    it('capacityFilter: missing-region excludes non-Azure workload milestones', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-azure-1',
            msp_milestonenumber: '7-111111111',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980076, // None region
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-modernwork-1',
            msp_milestonenumber: '7-222222222',
            msp_milestoneworkload: 861980003, // Modern Work
            msp_milestonepreferredazureregion: null, // No region (meaningless for Modern Work)
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-d365-1',
            msp_milestonenumber: '7-333333333',
            msp_milestoneworkload: 861980001, // D365
            msp_milestonepreferredazureregion: 861980076, // None region (meaningless for D365)
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, capacityFilter: 'missing-region' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Only the Azure milestone should be returned
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('ms-azure-1');
    });

    it('capacityFilter: missing-capacity excludes non-Azure workload milestones', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-azure-1',
            msp_milestonenumber: '7-111111111',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestoneazurecapacitytype: '861980000', // None capacity
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-security-1',
            msp_milestonenumber: '7-444444444',
            msp_milestoneworkload: 861980002, // Security
            msp_milestoneazurecapacitytype: null, // No capacity (meaningless for Security)
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, capacityFilter: 'missing-capacity' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Only the Azure milestone should be returned
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('ms-azure-1');
    });

    it('capacityFilter: missing-any excludes non-Azure workload milestones', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-azure-1',
            msp_milestonenumber: '7-111111111',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: null, // Missing region
            msp_milestoneazurecapacitytype: '861980081', // Has capacity
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-modernwork-1',
            msp_milestonenumber: '7-222222222',
            msp_milestoneworkload: 861980003, // Modern Work
            msp_milestonepreferredazureregion: null, // Missing region (but irrelevant)
            msp_milestoneazurecapacitytype: null, // Missing capacity (but irrelevant)
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, capacityFilter: 'missing-any' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Only the Azure milestone should be returned
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('ms-azure-1');
    });

    it('applies capacityFilter in opportunityIds path', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-1',
            _msp_opportunityid_value: '11111111-1111-1111-1111-111111111111',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980001,
            msp_milestoneazurecapacitytype: '861980081',
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-2',
            _msp_opportunityid_value: '11111111-1111-1111-1111-111111111111',
            msp_milestoneworkload: 861980000, // Azure
            msp_milestonepreferredazureregion: 861980076, // None
            msp_milestoneazurecapacitytype: '861980000', // None
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111'],
        capacityFilter: 'has-both'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('ms-1');
    });
  });

  describe('get_my_active_opportunities', () => {
    it('returns the deterministic union of owned + active-milestone-owned opps', async () => {
      // 1. owned opportunities
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'Contoso AI Platform', estimatedclosedate: '2026-12-31',
            _parentaccountid_value: 'acct-1',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso Ltd' }
        ] }
      });
      // 2. milestone-ownership discovery: opp-1 (owned → deduped), opp-2 (active → kept),
      //    opp-3 (Completed milestone → excluded; must NOT drag its parent opp in)
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _msp_opportunityid_value: 'opp-1', msp_milestonestatus: 861980001,
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'In Progress' },
          { _msp_opportunityid_value: 'opp-2', msp_milestonestatus: 861980001,
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track' },
          { _msp_opportunityid_value: 'opp-3', msp_milestonestatus: 861980003,
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Completed' }
        ] }
      });
      // 3. fetch the milestone-owned opps (only opp-2 — opp-1 deduped, opp-3 inactive)
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-2', name: 'Fabrikam Cloud', estimatedclosedate: '2026-09-30',
            _parentaccountid_value: 'acct-2',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Fabrikam Inc' }
        ] }
      });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
      expect(parsed.opportunities[0].customer).toBe('Contoso Ltd');
      expect(parsed.opportunities[0].relationship).toBe('owner');
      expect(parsed.opportunities[1].name).toBe('Fabrikam Cloud');
      expect(parsed.opportunities[1].relationship).toBe('milestone');
      // opp-3 (Completed milestone) was never fetched → its parent opp is absent
      expect(parsed.opportunities.some(o => o.opportunityid === 'opp-3')).toBe(false);
    });

    it('does NOT query msp_dealteams (deal-team-membership leak closed)', async () => {
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } }); // owned
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } }); // milestone discovery
      await callTool(server, 'get_my_active_opportunities', {});
      expect(crm.requestAllPages).not.toHaveBeenCalledWith('msp_dealteams', expect.anything());
    });

    it('filters by customerKeyword across owned + milestone opps', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'Contoso AI', _parentaccountid_value: 'acct-1',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso Ltd' },
          { opportunityid: 'opp-2', name: 'Fabrikam Cloud', _parentaccountid_value: 'acct-2',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Fabrikam Inc' }
        ] }
      });
      // milestone-ownership discovery: none
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'get_my_active_opportunities', { customerKeyword: 'contoso' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.opportunities[0].name).toBe('Contoso AI');
    });

    it('returns error when WhoAmI fails', async () => {
      crm.request.mockResolvedValueOnce({ ok: false, status: 401, data: { message: 'Unauthorized' } });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBe(true);
    });

    it('returns only owned opps when milestone discovery fails (graceful, deterministic — no territory dump)', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'Contoso AI', _parentaccountid_value: 'acct-1',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso Ltd' }
        ] }
      });
      // milestone-ownership discovery errors → we still return owned opps, and nothing else
      crm.requestAllPages.mockResolvedValueOnce({ ok: false, status: 500, data: { message: 'Server error' } });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.opportunities[0].relationship).toBe('owner');
    });

    it('includes an opp you do not own but where you own an active milestone', async () => {
      // owned: none
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      // milestone-ownership discovery: one active milestone on opp-2
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _msp_opportunityid_value: 'opp-2', msp_milestonestatus: 861980001,
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'In Progress' }
        ] }
      });
      // fetch milestone-owned opps
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-2', name: 'Fabrikam Cloud', _parentaccountid_value: 'acct-2',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Fabrikam Inc' }
        ] }
      });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.opportunities[0].opportunityid).toBe('opp-2');
      expect(parsed.opportunities[0].relationship).toBe('milestone');
    });

    it('aggregates seats (usage) and monthlyUse (consumption ACR) per opp, excluding terminal milestones (#2)', async () => {
      // 1: owned opportunities
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'Contoso Usage', _parentaccountid_value: 'acct-1',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso Ltd' }
        ] }
      });
      // 2: milestone-ownership discovery — empty (no extra opps)
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      // 3: batch milestone aggregation query — two active + one Cancelled (code 861980004)
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _msp_opportunityid_value: 'opp-1', msp_noofactivations: 10, msp_monthlyuse: 100, msp_milestonestatus: 861980000 },
          { _msp_opportunityid_value: 'opp-1', msp_noofactivations: 5,  msp_monthlyuse: 50,  msp_milestonestatus: 861980000 },
          { _msp_opportunityid_value: 'opp-1', msp_noofactivations: 999, msp_monthlyuse: 999, msp_milestonestatus: 861980004 }
        ] }
      });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      const opp = parsed.opportunities[0];
      // 10 + 5 = 15 (Cancelled milestone's 999 excluded)
      expect(opp.seats).toBe(15);
      // 100 + 50 = 150 (Cancelled milestone's 999 excluded)
      expect(opp.monthlyUse).toBe(150);
    });
  });

  describe('pipeline_health presentation (#7)', () => {
    it('exposes totalIssues + healthGrade + issueScore/issueScoreMax and a deterministic summary (no healthScore, no /100)', async () => {
      // All requestAllPages default to empty → no opps, no milestones → zero issues
      const result = await callTool(server, 'pipeline_health', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('totalIssues');
      expect(parsed).toHaveProperty('healthGrade');
      expect(parsed).toHaveProperty('issueScore');
      expect(parsed.issueScoreMax).toBe(100);
      // The misleading bare 0–100 healthScore is gone.
      expect(parsed).not.toHaveProperty('healthScore');
      expect(parsed.totalIssues).toBe(0);
      expect(parsed.healthGrade).toBe('A');
      // Summary leads with the issue COUNT + grade, never "{score}/100".
      expect(parsed.summary).toBe(`${parsed.totalIssues} issues — grade ${parsed.healthGrade}`);
      expect(parsed.summary).not.toContain('/100');
    });
  });

  describe('get_team_accounts', () => {
    it('returns accounts from the My Team Accounts savedquery', async () => {
      // savedquery lookup
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-001' }] }
      });
      // accounts via savedQuery
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { accountid: 'acct-1', name: 'Contoso Ltd', msp_mstopparentid: 'tp-100' },
          { accountid: 'acct-2', name: 'Fabrikam Inc', msp_mstopparentid: 'tp-200' }
        ] }
      });
      const result = await callTool(server, 'get_team_accounts', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
      expect(parsed.accounts[0].name).toBe('Contoso Ltd');
      expect(parsed.accounts[0].tpid).toBe('tp-100');
      expect(parsed.accounts[1].name).toBe('Fabrikam Inc');
    });

    it('filters by customerKeyword', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-001' }] }
      });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { accountid: 'acct-1', name: 'Contoso Ltd', msp_mstopparentid: 'tp-100' },
          { accountid: 'acct-2', name: 'Fabrikam Inc', msp_mstopparentid: 'tp-200' }
        ] }
      });
      const result = await callTool(server, 'get_team_accounts', { customerKeyword: 'contoso' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.accounts[0].name).toBe('Contoso Ltd');
    });

    it('returns error when savedquery is not found', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'get_team_accounts', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('My Team Accounts');
    });
  });

  describe('get_my_active_opportunities scoping (no deal-team / no territory leak)', () => {
    it('does NOT fall back to a territory dump when you own no opps and no milestones', async () => {
      // owned — empty
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      // milestone-ownership discovery — empty
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      // The old behavior queried the "My Team Accounts" saved view and dumped the
      // entire territory into My Opps (Leak #2). That must be gone:
      expect(crm.request).not.toHaveBeenCalledWith('savedqueries', expect.anything());
      expect(crm.requestAllPages).not.toHaveBeenCalledWith('accounts', expect.anything());
    });

    it('is deterministic on the owned-only path: never widens to unowned opps', async () => {
      // owned — one opp
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'My Deal', _parentaccountid_value: 'acct-1',
            '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso Ltd' }
        ] }
      });
      // milestone-ownership discovery — empty
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.opportunities[0].relationship).toBe('owner');
      // no territory saved-view lookup
      expect(crm.request).not.toHaveBeenCalledWith('savedqueries', expect.anything());
    });

    it('excludes an active opp when the only milestone you own on it is Completed', async () => {
      // owned — empty
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      // milestone-ownership discovery — a single Completed milestone on opp-9
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _msp_opportunityid_value: 'opp-9', msp_milestonestatus: 861980003,
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Completed' }
        ] }
      });
      const result = await callTool(server, 'get_my_active_opportunities', {});
      const parsed = JSON.parse(result.content[0].text);
      // opp-9 is never fetched because its only owned milestone is inactive
      expect(parsed.count).toBe(0);
      expect(crm.requestAllPages).not.toHaveBeenCalledWith('opportunities', expect.objectContaining({
        query: expect.objectContaining({ $filter: expect.stringContaining('opp-9') })
      }));
    });
  });

  describe('get_milestones (enhanced)', () => {
    // End of the current month: always within the "due_soon" window
    // (today <= date <= end-of-month), regardless of when the test runs.
    const pad2 = n => String(n).padStart(2, '0');
    const eom = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
    const dueSoonDate = `${eom.getFullYear()}-${pad2(eom.getMonth() + 1)}-${pad2(eom.getDate())}`;
    const makeMilestone = (name, status, oppName, wlName, categoryCode = 861980000, categoryLabel = 'PoC/Pilot') => ({
      msp_engagementmilestoneid: 'ms-1',
      msp_milestonenumber: '7-100',
      msp_name: name,
      msp_milestonedate: dueSoonDate,
      msp_monthlyuse: 1000,
      msp_milestonecategory: categoryCode,
      'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': status,
      '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': oppName,
      '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': wlName,
      'msp_milestonecategory@OData.Community.Display.V1.FormattedValue': categoryLabel
    });

    it('statusFilter=active excludes Completed milestones', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('MS-A', 'In Progress', 'Opp1', 'Azure'),
          makeMilestone('MS-B', 'Completed', 'Opp1', 'Azure'),
          makeMilestone('MS-C', 'Not Started', 'Opp2', 'M365')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, statusFilter: 'active' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
    });

    it('keyword filters across milestone name, opportunity, and workload', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('Deploy Copilot', 'In Progress', 'Contoso AI', 'Azure OpenAI'),
          makeMilestone('Network Setup', 'In Progress', 'Fabrikam Cloud', 'Azure Networking')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, keyword: 'contoso' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_name).toBe('Deploy Copilot');
    });

    it('format=summary returns grouped compact output', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('MS-A', 'In Progress', 'Opp1', 'Azure'),
          makeMilestone('MS-B', 'Not Started', 'Opp1', 'M365')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'summary' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.byStatus).toBeDefined();
      expect(parsed.byStatus['In Progress']).toBe(1);
      expect(parsed.byStatus['Not Started']).toBe(1);
      expect(parsed.byOpportunity).toBeDefined();
      expect(parsed.milestones[0]).toHaveProperty('status');
      expect(parsed.milestones[0]).toHaveProperty('opportunity');
    });

    it('format=triage projects milestone category and marketplace flag', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('MBS MS', 'On Track', 'Opp1', 'Azure', 725300001, 'ISV/ Marketplace')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage', statusFilter: 'all' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.due_soon[0]).toMatchObject({
        category: 'ISV/ Marketplace',
        categoryCode: 725300001,
        isMarketplace: true
      });
    });

    it('format=triage flags marketplace when live category code is absent but workload identifies it', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('MBS Workload MS', 'On Track', 'Opp1', 'Data: MIDP ISV Marketplace', 861980002, 'Production')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage', statusFilter: 'all' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.due_soon[0]).toMatchObject({
        category: 'Production',
        categoryCode: 861980002,
        isMarketplace: true,
        workload: 'Data: MIDP ISV Marketplace'
      });
    });

    it('combines statusFilter and keyword', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('Deploy Copilot', 'Completed', 'Contoso AI', 'Azure'),
          makeMilestone('Copilot Pilot', 'In Progress', 'Contoso AI', 'Azure'),
          makeMilestone('Network Setup', 'In Progress', 'Fabrikam', 'Azure')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, statusFilter: 'active', keyword: 'contoso' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_name).toBe('Copilot Pilot');
    });

    it('format=triage excludes Lost to Competitor milestones from all buckets', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-lost-1',
            msp_milestonenumber: '7-111111111',
            msp_name: 'Lost Milestone',
            msp_milestonedate: '2027-12-01',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Lost to Competitor',
            msp_milestonestatus: 861980005,
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-active-1',
            msp_milestonenumber: '7-222222222',
            msp_name: 'Active Milestone',
            msp_milestonedate: '2027-12-01',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
            msp_milestonestatus: 861980000,
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Lost to Competitor milestone should not appear in any bucket
      const allMilestones = [
        ...(parsed.overdue || []),
        ...(parsed.due_soon || []),
        ...(parsed.blocked || []),
        ...(parsed.on_track || []),
        ...(parsed.completed || [])
      ];
      expect(allMilestones.find(m => m.id === 'ms-lost-1')).toBeUndefined();
      expect(allMilestones.find(m => m.id === 'ms-active-1')).toBeDefined();
      // Should not be in date_urgent either
      const urgentMilestones = [
        ...(parsed.date_urgent?.overdue || []),
        ...(parsed.date_urgent?.due_soon || [])
      ];
      expect(urgentMilestones.find(m => m.id === 'ms-lost-1')).toBeUndefined();
    });

    it('format=triage excludes Hygiene/Duplicate milestones from all buckets', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-hygiene-1',
            msp_milestonenumber: '7-333333333',
            msp_name: 'Hygiene Milestone',
            msp_milestonedate: '2027-12-01',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Hygiene/Duplicate',
            msp_milestonestatus: 861980006,
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-blocked-1',
            msp_milestonenumber: '7-444444444',
            msp_name: 'Blocked Milestone',
            msp_milestonedate: '2027-12-01',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Blocked',
            msp_milestonestatus: 861980002,
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Hygiene/Duplicate milestone should not appear in any bucket
      const allMilestones = [
        ...(parsed.overdue || []),
        ...(parsed.due_soon || []),
        ...(parsed.blocked || []),
        ...(parsed.on_track || []),
        ...(parsed.completed || [])
      ];
      expect(allMilestones.find(m => m.id === 'ms-hygiene-1')).toBeUndefined();
      expect(allMilestones.find(m => m.id === 'ms-blocked-1')).toBeDefined();
      // Should not be in date_urgent either
      const urgentMilestones = [
        ...(parsed.date_urgent?.overdue || []),
        ...(parsed.date_urgent?.due_soon || [])
      ];
      expect(urgentMilestones.find(m => m.id === 'ms-hygiene-1')).toBeUndefined();
    });

    it('format=triage Completed bucket includes Completed milestones but excludes Cancelled/Lost/Hygiene', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-completed-1',
            msp_milestonenumber: '7-555555555',
            msp_name: 'Completed Milestone',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Completed',
            msp_milestonestatus: 861980003,
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-cancelled-1',
            msp_milestonenumber: '7-666666666',
            msp_name: 'Cancelled Milestone',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Cancelled',
            msp_milestonestatus: 861980004,
            _ownerid_value: 'abc-123'
          },
          {
            msp_engagementmilestoneid: 'ms-lost-2',
            msp_milestonenumber: '7-777777777',
            msp_name: 'Lost Milestone',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Lost to Competitor',
            msp_milestonestatus: 861980005,
            _ownerid_value: 'abc-123'
          }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, format: 'triage', statusFilter: 'all' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Only Completed should appear in completed bucket
      expect(parsed.completed.length).toBe(1);
      expect(parsed.completed[0].id).toBe('ms-completed-1');
      // Cancelled and Lost should not appear anywhere
      const allMilestones = [
        ...(parsed.overdue || []),
        ...(parsed.due_soon || []),
        ...(parsed.blocked || []),
        ...(parsed.on_track || []),
        ...(parsed.completed || [])
      ];
      expect(allMilestones.find(m => m.id === 'ms-cancelled-1')).toBeUndefined();
      expect(allMilestones.find(m => m.id === 'ms-lost-2')).toBeUndefined();
    });

    it('supports batch opportunityIds array', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('MS-A', 'In Progress', 'Opp1', 'Azure'),
          makeMilestone('MS-B', 'Not Started', 'Opp2', 'M365')
        ] }
      });
      const result = await callTool(server, 'get_milestones', {
        opportunityIds: [
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222'
        ]
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
      // Verify the filter used OR clauses for both IDs
      expect(crm.requestAllPages).toHaveBeenCalledWith(
        'msp_engagementmilestones',
        expect.objectContaining({
          query: expect.objectContaining({
            $filter: expect.stringContaining("_msp_opportunityid_value eq '11111111-1111-1111-1111-111111111111'")
          })
        })
      );
    });

    it('rejects opportunityIds with no valid GUIDs', async () => {
      const result = await callTool(server, 'get_milestones', { opportunityIds: ['bad-id'] });
      expect(result.isError).toBe(true);
    });

    it('taskFilter=without-tasks returns only milestones without linked tasks', async () => {
      const ms1 = { ...makeMilestone('MS-A', 'In Progress', 'Opp1', 'Azure'), msp_engagementmilestoneid: '11111111-1111-1111-1111-111111111111' };
      const ms2 = { ...makeMilestone('MS-B', 'In Progress', 'Opp1', 'Azure'), msp_engagementmilestoneid: '22222222-2222-2222-2222-222222222222' };
      // Milestone query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [ms1, ms2] }
      });
      // Task query — only ms1 has tasks
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _regardingobjectid_value: '11111111-1111-1111-1111-111111111111' }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, taskFilter: 'without-tasks' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('22222222-2222-2222-2222-222222222222');
    });

    it('taskFilter=with-tasks returns only milestones with linked tasks', async () => {
      const ms1 = { ...makeMilestone('MS-A', 'In Progress', 'Opp1', 'Azure'), msp_engagementmilestoneid: '11111111-1111-1111-1111-111111111111' };
      const ms2 = { ...makeMilestone('MS-B', 'In Progress', 'Opp1', 'Azure'), msp_engagementmilestoneid: '22222222-2222-2222-2222-222222222222' };
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [ms1, ms2] }
      });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _regardingobjectid_value: '11111111-1111-1111-1111-111111111111' }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, taskFilter: 'with-tasks' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_engagementmilestoneid).toBe('11111111-1111-1111-1111-111111111111');
    });
  });

  describe('get_milestones (customerKeyword / opportunityKeyword / includeTasks)', () => {
    const makeMilestone = (name, status, oppName, wlName, msId = 'ms-1') => ({
      msp_engagementmilestoneid: msId,
      msp_milestonenumber: '7-100',
      msp_name: name,
      msp_milestonedate: new Date().toISOString().slice(0, 10),
      msp_monthlyuse: 1000,
      'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': status,
      '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': oppName,
      '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': wlName,
      'msp_milestonecategory@OData.Community.Display.V1.FormattedValue': 'PoC/Pilot'
    });

    it('customerKeyword resolves customer → accounts → opportunities → milestones in one tool call', async () => {
      // 1. accounts query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { accountid: 'acct-1', name: 'Contoso Ltd' }
        ] }
      });
      // 2. opportunities query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: '11111111-1111-1111-1111-111111111111', name: 'Contoso AI' }
        ] }
      });
      // 3. milestones query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('Deploy Copilot', 'In Progress', 'Contoso AI', 'Azure')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { customerKeyword: 'Contoso' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_name).toBe('Deploy Copilot');
      // Verify accounts query
      expect(crm.requestAllPages).toHaveBeenCalledWith('accounts', expect.objectContaining({
        query: expect.objectContaining({ $filter: "contains(name,'Contoso')" })
      }));
    });

    it('customerKeyword returns message when no accounts found', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'get_milestones', { customerKeyword: 'NonExistent' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.message).toContain('No accounts found');
    });

    it('customerKeyword returns message when no opportunities found', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ accountid: 'acct-1', name: 'Contoso' }] }
      });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'get_milestones', { customerKeyword: 'Contoso' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.message).toContain('No active opportunities');
    });

    it('opportunityKeyword resolves opportunity name → milestones in one tool call', async () => {
      // 1. opportunities query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: '11111111-1111-1111-1111-111111111111', name: 'Azure Migration' }
        ] }
      });
      // 2. milestones query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('Migrate DB', 'Not Started', 'Azure Migration', 'Azure SQL')
        ] }
      });
      const result = await callTool(server, 'get_milestones', { opportunityKeyword: 'Azure Migration' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_name).toBe('Migrate DB');
    });

    it('opportunityKeyword returns message when no opportunities found', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'get_milestones', { opportunityKeyword: 'NonExistent' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.message).toContain('No active opportunities');
    });

    it('includeTasks embeds linked tasks inline on each milestone', async () => {
      const ms1Id = '11111111-1111-1111-1111-111111111111';
      const ms2Id = '22222222-2222-2222-2222-222222222222';
      // milestones query
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('MS-A', 'In Progress', 'Opp1', 'Azure', ms1Id),
          makeMilestone('MS-B', 'Not Started', 'Opp1', 'Azure', ms2Id)
        ] }
      });
      // tasks query (for includeTasks)
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { activityid: 'task-1', subject: 'Review arch', _regardingobjectid_value: ms1Id },
          { activityid: 'task-2', subject: 'Deploy POC', _regardingobjectid_value: ms1Id }
        ] }
      });
      const result = await callTool(server, 'get_milestones', { mine: true, includeTasks: true });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].tasks).toHaveLength(2);
      expect(parsed.milestones[0].tasks[0].subject).toBe('Review arch');
      expect(parsed.milestones[1].tasks).toHaveLength(0);
    });

    it('customerKeyword + statusFilter + includeTasks combines all features', async () => {
      const ms1Id = '11111111-1111-1111-1111-111111111111';
      // accounts
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ accountid: 'acct-1', name: 'Contoso' }] }
      });
      // opportunities
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: '11111111-1111-1111-1111-111111111111', name: 'Contoso AI' }
        ] }
      });
      // milestones
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          makeMilestone('Active MS', 'On Track', 'Contoso AI', 'Azure', ms1Id),
          makeMilestone('Done MS', 'Completed', 'Contoso AI', 'Azure', '33333333-3333-3333-3333-333333333333')
        ] }
      });
      // tasks (for includeTasks)
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { activityid: 'task-1', subject: 'Task A', _regardingobjectid_value: ms1Id }
        ] }
      });
      const result = await callTool(server, 'get_milestones', {
        customerKeyword: 'Contoso',
        statusFilter: 'active',
        includeTasks: true
      });
      const parsed = JSON.parse(result.content[0].text);
      // statusFilter should exclude Completed
      expect(parsed.count).toBe(1);
      expect(parsed.milestones[0].msp_name).toBe('Active MS');
      expect(parsed.milestones[0].tasks).toHaveLength(1);
    });

    it('customerKeyword + mine:true filters milestones by owner (regression: 1.1.13 dropped this)', async () => {
      // Mock WhoAmI returns UserId 'abc-123' (matches default crm mock).
      // Build 5 milestones on 1 opportunity: 2 owned by current user, 3 by someone else.
      // Expected: count=2 after post-fetch owner filter, all assignedToMe=true.
      const mineMs = (name, msId) => ({
        ...makeMilestone(name, 'In Progress', 'Antolin Opp', 'Azure', msId),
        _ownerid_value: 'abc-123',
        '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Jose Rubio',
        _msp_opportunityid_value: '11111111-1111-1111-1111-111111111111'
      });
      const otherMs = (name, msId) => ({
        ...makeMilestone(name, 'In Progress', 'Antolin Opp', 'Azure', msId),
        _ownerid_value: 'other-user-guid',
        '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Someone Else',
        _msp_opportunityid_value: '11111111-1111-1111-1111-111111111111'
      });
      // 1. accounts → 2. opportunities → 3. milestones (5 total)
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ accountid: 'acct-1', name: 'Antolin' }] }
      });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: '11111111-1111-1111-1111-111111111111', name: 'Antolin Opp', _parentaccountid_value: 'acct-1' }
        ] }
      });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          mineMs('Mine A', 'a1111111-1111-1111-1111-111111111111'),
          otherMs('Other A', 'b1111111-1111-1111-1111-111111111111'),
          mineMs('Mine B', 'a2222222-2222-2222-2222-222222222222'),
          otherMs('Other B', 'b2222222-2222-2222-2222-222222222222'),
          otherMs('Other C', 'b3333333-3333-3333-3333-333333333333')
        ] }
      });
      const result = await callTool(server, 'get_milestones', {
        customerKeyword: 'Antolin',
        mine: true,
        statusFilter: 'all'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Owner post-filter must drop 5 → 2 (only "Mine A" / "Mine B").
      expect(parsed.count).toBe(2);
      expect(parsed.milestones.map(m => m.msp_name).sort()).toEqual(['Mine A', 'Mine B']);
      // Compact projection must surface owner identity so the LLM can prove ownership.
      for (const m of parsed.milestones) {
        expect(m.ownerName).toBe('Jose Rubio');
        expect(m.ownerId).toBe('abc-123');
        expect(m.assignedToMe).toBe(true);
      }
    });
  });

  describe('get_milestone_activities (batch)', () => {
    it('supports batch milestoneIds array', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { activityid: 'task-1', subject: 'Task A', _regardingobjectid_value: '11111111-1111-1111-1111-111111111111' },
          { activityid: 'task-2', subject: 'Task B', _regardingobjectid_value: '22222222-2222-2222-2222-222222222222' }
        ] }
      });
      const result = await callTool(server, 'get_milestone_activities', {
        milestoneIds: [
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222'
        ]
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
      expect(parsed.byMilestone).toBeDefined();
      expect(parsed.byMilestone['11111111-1111-1111-1111-111111111111']).toHaveLength(1);
      expect(parsed.byMilestone['22222222-2222-2222-2222-222222222222']).toHaveLength(1);
    });

    it('single milestoneId still returns flat tasks array', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { activityid: 'task-1', subject: 'Task A' }
        ] }
      });
      const result = await callTool(server, 'get_milestone_activities', {
        milestoneId: '11111111-1111-1111-1111-111111111111'
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tasks).toBeDefined();
      expect(parsed.byMilestone).toBeUndefined();
    });

    it('rejects when neither milestoneId nor milestoneIds provided', async () => {
      const result = await callTool(server, 'get_milestone_activities', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_milestone_field_options', () => {
    it('returns picklist options for a milestone field', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: {
          OptionSet: {
            Options: [
              { Value: 861980000, Label: { UserLocalizedLabel: { Label: 'Standard' } } },
              { Value: 861980001, Label: { UserLocalizedLabel: { Label: 'Premium' } } }
            ]
          }
        }
      });

      const result = await callTool(server, 'get_milestone_field_options', { field: 'workloadType' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.field).toBe('workloadType');
      expect(parsed.logicalName).toBe('msp_milestoneworkload');
      expect(parsed.options).toHaveLength(2);
      expect(parsed.options[0]).toEqual({ value: 861980000, label: 'Standard' });
    });

    it('returns error on metadata query failure', async () => {
      crm.request.mockResolvedValueOnce({ ok: false, status: 404, data: { message: 'Not found' } });
      const result = await callTool(server, 'get_milestone_field_options', { field: 'deliveredBy' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Metadata query failed');
    });
  });

  describe('find_milestones_needing_tasks', () => {
    it('resolves customers → opps → milestones and returns those without tasks', async () => {
      // 1. Account search for "Contoso"
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { accountid: 'acct-1', name: 'Contoso Corp' }
        ] }
      });
      // 2. Opportunities for that account
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { opportunityid: 'opp-1', name: 'Contoso Azure AI' }
        ] }
      });
      // 3. Milestones for the opportunity
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          {
            msp_engagementmilestoneid: 'ms-1',
            msp_milestonenumber: '7-100',
            msp_name: 'Kickoff',
            msp_milestonedate: new Date().toISOString().slice(0, 10),
            _msp_opportunityid_value: 'opp-1',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'In Progress',
            '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure'
          },
          {
            msp_engagementmilestoneid: 'ms-2',
            msp_milestonenumber: '7-101',
            msp_name: 'PoC',
            msp_milestonedate: '2026-07-01',
            _msp_opportunityid_value: 'opp-1',
            'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'Not Started',
            '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure'
          }
        ] }
      });
      // 4. Task check — ms-1 has a task, ms-2 does not
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [
          { _regardingobjectid_value: 'ms-1' }
        ] }
      });

      const result = await callTool(server, 'find_milestones_needing_tasks', {
        customerKeywords: ['Contoso']
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalMilestonesNeedingTasks).toBe(1);
      expect(parsed.customers[0].customer).toBe('Contoso');
      expect(parsed.customers[0].milestonesNeedingTasks).toBe(1);
      expect(parsed.customers[0].milestones[0].name).toBe('PoC');
    });

    it('handles customer with no matching accounts', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [] }
      });
      const result = await callTool(server, 'find_milestones_needing_tasks', {
        customerKeywords: ['NonexistentCorp']
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalMilestonesNeedingTasks).toBe(0);
      expect(parsed.customers[0].error).toBe('No matching accounts found');
    });

    it('rejects empty customerKeywords', async () => {
      const result = await callTool(server, 'find_milestones_needing_tasks', { customerKeywords: [] });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_task', () => {
    it('validates milestoneId', async () => {
      const result = await callTool(server, 'create_task', { milestoneId: 'bad', subject: 'Test' });
      expect(result.isError).toBe(true);
    });

    it('requires subject', async () => {
      const result = await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBe(true);
    });

    it('creates a task with valid params (stages operation)', async () => {
      const result = await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Architecture Design Session',
        category: 861980004
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.operationId).toMatch(/^OP-/);
      expect(parsed.payload.subject).toBe('Architecture Design Session');
      expect(parsed.payload.msp_taskcategory).toBe(861980004);
    });
  });

  describe('creation lookup and opportunity create', () => {
    const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
    const CURRENCY_ID = '22222222-2222-2222-2222-222222222222';
    const OWNER_ID = '33333333-3333-3333-3333-333333333333';

    beforeEach(() => {
      resetSolutionSalesPlayCache();
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: OWNER_ID } };
        if (path.startsWith('accounts(')) return { ok: true, status: 200, data: { accountid: ACCOUNT_ID, name: 'Contoso' } };
        if (path.startsWith('opportunities(')) return { ok: true, status: 200, data: { opportunityid: '44444444-4444-4444-4444-444444444444', name: 'Contoso Opp', statecode: 0 } };
        if (path.startsWith('msp_workloads(')) return { ok: true, status: 200, data: { msp_workloadid: 'aaaaaaaa-1111-2222-3333-444444444444', msp_name: 'AI: Azure Machine Learning' } };
        if (path.startsWith('transactioncurrencies(')) return { ok: true, status: 200, data: { transactioncurrencyid: CURRENCY_ID, currencyname: 'EURO', isocurrencycode: 'EUR' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: OWNER_ID, fullname: 'ATU Owner', msp_rolegroup: 'ATU' } };
        return { ok: true, status: 200, data: {} };
      });
      crm.requestAllPages.mockResolvedValue({ ok: true, status: 200, data: { value: [] } });
    });

    it('searches workload lookup aliases with the real milestone bind casing', async () => {
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [{ msp_workloadid: 'aaaaaaaa-1111-2222-3333-444444444444', msp_name: 'AI: Azure Machine Learning' }] } });
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'msp_Workloadlk', term: 'Azure' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entity).toBe('workload');
      expect(parsed.options[0]).toMatchObject({
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        entitySet: 'msp_workloads',
        entityType: 'msp_workload',
        bind: 'msp_WorkloadlkId@odata.bind'
      });
    });

    it('searches account lookup options via Dataverse Search', async () => {
      crm.search.mockResolvedValueOnce({
        ok: true, status: 200, data: {
          value: [{
            text: 'Contoso',
            document: { '@search.objectid': ACCOUNT_ID, '@search.entityname': 'account', name: 'Contoso' }
          }]
        }
      });
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'account', term: 'contoso' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.scope).toBe('dataverse-search');
      expect(parsed.options[0]).toMatchObject({ id: ACCOUNT_ID, entitySet: 'accounts', bind: 'parentaccountid@odata.bind', label: 'Contoso' });

      // Lock the call-site: operation name must be 'suggest' (NOT 'search/suggest'),
      // and body must carry filter:'statecode eq 0' to exclude inactive accounts.
      expect(crm.search).toHaveBeenCalledOnce();
      const [operation, body] = crm.search.mock.calls[0];
      expect(operation).toBe('suggest');
      expect(body.filter).toBe('statecode eq 0');
      expect(body.entities).toEqual(['account']);
    });

    it('ACCEPTANCE: account with no recent opportunity still appears via Dataverse Search', async () => {
      const WAGEN_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      crm.search.mockResolvedValueOnce({
        ok: true, status: 200, data: {
          value: [{
            text: 'Wageningen Universiteit en Research Centrum',
            document: {
              '@search.objectid': WAGEN_ID,
              '@search.entityname': 'account',
              name: 'Wageningen Universiteit en Research Centrum'
            }
          }]
        }
      });
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'account', term: 'wageningen' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.scope).toBe('dataverse-search');
      expect(parsed.options).toHaveLength(1);
      expect(parsed.options[0]).toMatchObject({
        id: WAGEN_ID,
        entitySet: 'accounts',
        bind: 'parentaccountid@odata.bind',
        label: 'Wageningen Universiteit en Research Centrum'
      });
    });

    it('B1: term shorter than 3 chars returns empty options with hint and does NOT call crm.search', async () => {
      for (const shortTerm of ['', 'wa']) {
        crm.search.mockClear();
        const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'account', term: shortTerm });
        expect(result.isError).toBeUndefined();
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.options).toEqual([]);
        expect(parsed.hint).toMatch(/Type 3\+/);
        expect(crm.search).not.toHaveBeenCalled();
      }
    });

    it('B2: falls back to odata-fallback with startswith (not contains) when crm.search rejects', async () => {
      crm.search.mockRejectedValueOnce(new Error('Network error'));
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: {
          value: [{ accountid: ACCOUNT_ID, name: 'Contoso' }]
        }
      });
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'account', term: 'contoso' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.scope).toBe('odata-fallback');
      expect(parsed.degraded).toBe(true);
      expect(parsed.hint).toMatch(/prefix matches/);
      // Verify the OData filter uses startswith and NOT contains
      const rapCalls = crm.requestAllPages.mock.calls;
      const accountsCall = rapCalls.find(c => c[0] === 'accounts');
      expect(accountsCall).toBeDefined();
      const filterStr = accountsCall[1].query.$filter;
      expect(filterStr).toMatch(/startswith\(/);
      expect(filterStr).not.toMatch(/contains\(/);
    });

    it('B2: falls back to odata-fallback when crm.search returns ok:false (e.g. 429)', async () => {
      crm.search.mockResolvedValueOnce({ ok: false, status: 429, data: { message: 'Too Many Requests' } });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: {
          value: [{ accountid: ACCOUNT_ID, name: 'Contoso' }]
        }
      });
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'account', term: 'contoso' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.scope).toBe('odata-fallback');
      expect(parsed.degraded).toBe(true);
    });

    it('sanitize cap: long and control-char term in fallback stays within OData filter length limits', async () => {
      crm.search.mockRejectedValueOnce(new Error('Unavailable'));
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      const longTerm = 'a'.repeat(200) + '\x01\x02\x03evil';
      await callTool(server, 'crm_creation_lookup_search', { entity: 'account', term: longTerm });
      const rapCalls = crm.requestAllPages.mock.calls;
      const accountsCall = rapCalls.find(c => c[0] === 'accounts');
      expect(accountsCall).toBeDefined();
      const filterStr = accountsCall[1].query.$filter;
      // Term portion must be <= 100 chars (sanitizeODataString maxLength:100)
      // Extract the string literal inside startswith(name,'...')
      const match = filterStr.match(/startswith\(name,'([^']*)'\)/);
      expect(match).not.toBeNull();
      expect(match[1].length).toBeLessThanOrEqual(100);
      // No control chars in filter
      expect(filterStr).not.toMatch(/[\x00-\x1F\x7F]/);
    });

    it('preflights opportunity create and returns ATU owner flags', async () => {
      const result = await callTool(server, 'create_opportunity_preflight', {
        name: 'Contoso AI',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        ownerId: OWNER_ID,
        opportunityType: '606820001',
        solutionArea: 394380000,
        salesPlay: 861980037
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.canCreate).toBe(true);
      expect(parsed.ownerIsAtu).toBe(true);
      expect(parsed.defaults.currency).toMatchObject({ id: CURRENCY_ID, isoCode: 'EUR' });
      expect(parsed.normalizedPayload['parentaccountid@odata.bind']).toBe(`/accounts(${ACCOUNT_ID})`);
    });

    it('finds owner lookup results without accents', async () => {
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [{ systemuserid: OWNER_ID, fullname: 'David González Gallardo', internalemailaddress: 'dgallardo@microsoft.com' }] } });
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'owner', term: 'david gonzalez gallardo' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.options[0]).toMatchObject({ id: OWNER_ID, label: 'David González Gallardo' });
    });

    it('preflights milestone create with EUR default currency and backend-defaulted workload type', async () => {
      crm.requestAllPages.mockResolvedValue({ ok: true, status: 200, data: { value: [] } });
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [{ transactioncurrencyid: CURRENCY_ID, currencyname: 'EURO', isocurrencycode: 'EUR' }] } });
      const result = await callTool(server, 'create_milestone_preflight', {
        opportunityId: '44444444-4444-4444-4444-444444444444',
        name: 'Test Milestone',
        milestoneDate: '2026-06-02',
        monthlyUse: 1,
        milestoneCategory: 861980000,
        customerCommitment: 861980000,
        workloadId: 'aaaaaaaa-1111-2222-3333-444444444444',
        deliveredBy: '606820000',
        preferredAzureRegion: '861980076',
        azureCapacityType: '861980000',
        milestoneStatus: 861980005,
        milestoneStatusReason: 861980010,
        milestoneComments: 'test'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.defaults.currency).toMatchObject({ id: CURRENCY_ID, isoCode: 'EUR' });
      expect(parsed.normalizedPayload['transactioncurrencyid@odata.bind']).toBe(`/transactioncurrencies(${CURRENCY_ID})`);
      expect(parsed.normalizedPayload.msp_milestoneworkload).toBe(861980000);
      expect(parsed.normalizedPayload.msp_commitmentrecommendation).toBe(861980000);
      expect(parsed.normalizedPayload.msp_deliveryspecifiedfield).toBe(606820000);
      expect(parsed.normalizedPayload.msp_milestonepreferredazureregion).toBe(861980076);
      expect(parsed.fields.find(f => f.fieldName === 'workloadType')).toMatchObject({ required: false, defaultedByBackend: true });
    });

    it('stages opportunity create with normalized payload', async () => {
      const result = await callTool(server, 'create_opportunity', {
        name: 'Contoso AI',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        ownerId: OWNER_ID,
        opportunityType: '606820001',
        solutionArea: 394380000,
        salesPlay: 861980037,
        estimatedStartDate: '2026-06-02',
        estimatedCompletionDate: '2026-06-30'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.operationId).toMatch(/^OP-/);
      expect(parsed.payloadPreview.msp_opportunitytype).toBe('606820001');
      expect(parsed.payloadPreview['ownerid@odata.bind']).toBe(`/systemusers(${OWNER_ID})`);
    });

    // ── Change B backend tests ─────────────────────────────────

    it('B.1 fixture fallback: all play entries have playId:null and globalSolutionArea:null', async () => {
      // requestAllPages returns empty → getSolutionAreaSalesPlayMap falls back to fixture
      const result = await callTool(server, 'crm_creation_lookup_search', { entity: 'solutionAreaSalesPlay' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.mappingSource).toBe('fixture');
      const allPlays = Object.values(parsed.map).flat();
      expect(allPlays.length).toBeGreaterThan(0);
      for (const play of allPlays) {
        expect(play).toHaveProperty('playId', null);
        expect(play).toHaveProperty('globalSolutionArea', null);
      }
    });

    it('B.5 backend derives msp_solutionarea from plays[0].globalSolutionArea via SOLUTION_AREA_PLAY_TO_OPPORTUNITY', async () => {
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';
      mockPlayMap(crm, [{ id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 }]);
      const result = await callTool(server, 'create_opportunity_preflight', {
        name: 'Multi-Play Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }]
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.canCreate).toBe(true);
      // globalSolutionArea 861980000 → SOLUTION_AREA_PLAY_TO_OPPORTUNITY[861980000] = 394380000
      expect(parsed.normalizedPayload.msp_solutionarea).toBe(394380000);
      expect(parsed.normalizedPayload.msp_salesplay).toBe(861980097);
    });

    it('B.6 staged response includes checklistPreview with correct order and primary flag', async () => {
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';
      const PLAY_2_ID = '22222222-aaaa-bbbb-cccc-222222222222';
      mockPlayMap(crm, [
        { id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 },
        { id: PLAY_2_ID, playValue: 861980087, globalSolutionArea: 861980000, solutionArea: 394380000 },
      ]);
      const result = await callTool(server, 'create_opportunity', {
        name: 'Preview Test Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }, { playValue: 861980087 }]
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(Array.isArray(parsed.checklistPreview)).toBe(true);
      expect(parsed.checklistPreview).toHaveLength(2);
      expect(parsed.checklistPreview[0]).toMatchObject({ playId: PLAY_1_ID, playValue: 861980097, isPrimary: true });
      expect(parsed.checklistPreview[1]).toMatchObject({ playId: PLAY_2_ID, playValue: 861980087, isPrimary: false });
      expect(parsed.message).toContain('2 checklist row(s)');
    });

    it('B.6 multi-play execute: writes primary scalar fields + N checklist rows, primary first', async () => {
      const NEW_OPP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';
      const PLAY_2_ID = '22222222-aaaa-bbbb-cccc-222222222222';
      const checklistCalls = [];

      mockPlayMap(crm, [
        { id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 },
        { id: PLAY_2_ID, playValue: 861980087, globalSolutionArea: 861980000, solutionArea: 394380000 },
      ]);

      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: OWNER_ID } };
        if (path.startsWith('accounts(')) return { ok: true, status: 200, data: { accountid: ACCOUNT_ID, name: 'Contoso' } };
        if (path.startsWith('transactioncurrencies(')) return { ok: true, status: 200, data: { transactioncurrencyid: CURRENCY_ID, currencyname: 'EURO', isocurrencycode: 'EUR' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: OWNER_ID, fullname: 'ATU Owner', msp_rolegroup: 'ATU' } };
        if (path === 'opportunities' && opts.method === 'POST') return { ok: true, status: 200, data: { opportunityid: NEW_OPP_ID } };
        if (path === 'msp_salesplaychecklists' && opts.method === 'POST') { checklistCalls.push(opts.body); return { ok: true, status: 204, data: null }; }
        if (path.startsWith(`opportunities(${NEW_OPP_ID})`) && opts.method === 'PATCH') return { ok: true, status: 204, data: null };
        if (path.startsWith(`opportunities(${NEW_OPP_ID})`)) return { ok: true, status: 200, data: { opportunityid: NEW_OPP_ID, name: 'Multi-Play Opp', msp_solutionarea: 394380000, msp_salesplay: 861980097 } };
        return { ok: true, status: 200, data: {} };
      });

      const stageResult = await callTool(server, 'create_opportunity', {
        name: 'Multi-Play Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }, { playValue: 861980087 }],
        estimatedStartDate: '2026-07-01',
        estimatedCompletionDate: '2027-06-30'
      });
      expect(stageResult.isError).toBeUndefined();
      const staged = JSON.parse(stageResult.content[0].text);
      expect(staged.staged).toBe(true);

      const execResult = await callTool(server, 'execute_operation', { id: staged.operationId });
      const exec = JSON.parse(execResult.content[0].text);

      expect(exec.success).toBe(true);
      expect(exec.opportunityId).toBe(NEW_OPP_ID);
      expect(exec.partial).toBeFalsy();

      // Primary first, then non-primary
      expect(checklistCalls).toHaveLength(2);
      expect(checklistCalls[0]['msp_OpportunityId@odata.bind']).toBe(`/opportunities(${NEW_OPP_ID})`);
      expect(checklistCalls[0]['msp_SalesPlay@odata.bind']).toBe(`/msp_accountplansalesplaybooks(${PLAY_1_ID})`);
      expect(checklistCalls[0].msp_primary).toBe(true);
      expect(checklistCalls[1]['msp_SalesPlay@odata.bind']).toBe(`/msp_accountplansalesplaybooks(${PLAY_2_ID})`);
      expect(checklistCalls[1].msp_primary).toBe(false);

      // Opp scalar fields: SA derived from plays[0].globalSolutionArea
      const oppPost = crm.request.mock.calls.find(c => c[0] === 'opportunities' && c[1]?.method === 'POST');
      expect(oppPost[1].body.msp_solutionarea).toBe(394380000);
      expect(oppPost[1].body.msp_salesplay).toBe(861980097);

      // Perf (docs §7): dates are folded INTO the create POST; NO separate date PATCH is issued.
      expect(oppPost[1].body.msp_eststartdate).toBe('2026-07-01');
      expect(oppPost[1].body.msp_estcompletiondate).toBe('2027-06-30');
      const datePatch = crm.request.mock.calls.find(c => String(c[0]).startsWith(`opportunities(${NEW_OPP_ID})`) && c[1]?.method === 'PATCH');
      expect(datePatch).toBeUndefined();
    });

    it('B.3 primary checklist creation failure → ok:false hard failure, not partial', async () => {
      const NEW_OPP_ID = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';

      mockPlayMap(crm, [{ id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 }]);

      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: OWNER_ID } };
        if (path.startsWith('accounts(')) return { ok: true, status: 200, data: { accountid: ACCOUNT_ID, name: 'Contoso' } };
        if (path.startsWith('transactioncurrencies(')) return { ok: true, status: 200, data: { transactioncurrencyid: CURRENCY_ID, currencyname: 'EURO', isocurrencycode: 'EUR' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: OWNER_ID, fullname: 'ATU Owner', msp_rolegroup: 'ATU' } };
        if (path === 'opportunities' && opts.method === 'POST') return { ok: true, status: 200, data: { opportunityid: NEW_OPP_ID } };
        if (path === 'msp_salesplaychecklists' && opts.method === 'POST') return { ok: false, status: 500, data: { message: 'CRM plugin error' } };
        return { ok: true, status: 200, data: {} };
      });

      const stageResult = await callTool(server, 'create_opportunity', {
        name: 'Primary Fail Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }]
      });
      const staged = JSON.parse(stageResult.content[0].text);

      const execResult = await callTool(server, 'execute_operation', { id: staged.operationId });
      const exec = JSON.parse(execResult.content[0].text);

      // Hard failure: error:true, failedStep is createPrimaryChecklist, no partial:true
      expect(exec.error).toBe(true);
      expect(exec.failedStep?.step).toBe('createPrimaryChecklist');
      expect(exec.partial).not.toBe(true);
    });

    it('B.3 non-primary checklist failure → ok:true with partial:true and warnings', async () => {
      const NEW_OPP_ID = 'aaaaaaaa-bbbb-cccc-dddd-aaaaaaaaabbb';
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';
      const PLAY_2_ID = '22222222-aaaa-bbbb-cccc-222222222222';
      let checklistCallCount = 0;

      mockPlayMap(crm, [
        { id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 },
        { id: PLAY_2_ID, playValue: 861980087, globalSolutionArea: 861980000, solutionArea: 394380000 },
      ]);

      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: OWNER_ID } };
        if (path.startsWith('accounts(')) return { ok: true, status: 200, data: { accountid: ACCOUNT_ID, name: 'Contoso' } };
        if (path.startsWith('transactioncurrencies(')) return { ok: true, status: 200, data: { transactioncurrencyid: CURRENCY_ID, currencyname: 'EURO', isocurrencycode: 'EUR' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: OWNER_ID, fullname: 'ATU Owner', msp_rolegroup: 'ATU' } };
        if (path === 'opportunities' && opts.method === 'POST') return { ok: true, status: 200, data: { opportunityid: NEW_OPP_ID } };
        if (path === 'msp_salesplaychecklists' && opts.method === 'POST') {
          checklistCallCount++;
          // Primary (first call) succeeds; non-primary (second call) fails
          return checklistCallCount === 1
            ? { ok: true, status: 204, data: null }
            : { ok: false, status: 500, data: { message: 'Non-primary checklist error' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const stageResult = await callTool(server, 'create_opportunity', {
        name: 'Partial Fail Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }, { playValue: 861980087 }]
      });
      const staged = JSON.parse(stageResult.content[0].text);

      const execResult = await callTool(server, 'execute_operation', { id: staged.operationId });
      const exec = JSON.parse(execResult.content[0].text);

      // Partial success: opp + primary exist, non-primary failed
      expect(exec.success).toBe(true);
      expect(exec.partial).toBe(true);
      expect(exec.opportunityId).toBe(NEW_OPP_ID);
      expect(Array.isArray(exec.warnings)).toBe(true);
      expect(exec.warnings.some(w => w.code === 'checklist_create_failed')).toBe(true);
    });

    it('B.N1 unresolvable PRIMARY play → preflight blocks with clear error before any write', async () => {
      // Default mock: requestAllPages returns empty → fixture fallback → all plays have playId:null → unresolvable
      const result = await callTool(server, 'create_opportunity_preflight', {
        name: 'Blocked Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }]
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.canCreate).toBe(false);
      // Fixture fallback (empty/slow map) → clear retryable message, not the opaque "reselect" one.
      expect(parsed.validation.blockers.some(b => b.fieldName === 'plays' && b.message.includes('temporarily unavailable'))).toBe(true);
    });

    it('B.N2 unresolvable PRIMARY play → create_opportunity returns staged:false, no op queued', async () => {
      // Default mock: fixture fallback → primary unresolvable → plan blocked
      const result = await callTool(server, 'create_opportunity', {
        name: 'Blocked Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }]
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(false);
      expect(parsed.blockers.some(b => b.fieldName === 'plays')).toBe(true);
    });

    it('B.N3 unresolvable NON-primary play → excluded from checklist, playWarnings surfaced', async () => {
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';
      // Only playValue 861980097 is in the map; 861980087 is not → second play excluded
      mockPlayMap(crm, [{ id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 }]);
      const result = await callTool(server, 'create_opportunity', {
        name: 'Partial Plays Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }, { playValue: 861980087 }]
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.checklistPreview).toHaveLength(1);
      expect(parsed.checklistPreview[0]).toMatchObject({ playValue: 861980097, isPrimary: true });
      expect(Array.isArray(parsed.playWarnings)).toBe(true);
      expect(parsed.playWarnings.some(w => w.code === 'unresolvable_play' && String(w.message).includes('861980087'))).toBe(true);
    });

    it('B.N4 resolved plays staged with playId + globalSolutionArea — execute uses pre-resolved data, no map call at execute time', async () => {
      const PLAY_1_ID = '11111111-aaaa-bbbb-cccc-111111111111';
      mockPlayMap(crm, [{ id: PLAY_1_ID, playValue: 861980097, globalSolutionArea: 861980000, solutionArea: 394380000 }]);
      const result = await callTool(server, 'create_opportunity', {
        name: 'Resolved Plays Opp',
        account: { id: ACCOUNT_ID },
        transactionCurrencyId: CURRENCY_ID,
        opportunityType: '606820001',
        plays: [{ playValue: 861980097 }]
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.checklistPreview[0]).toMatchObject({
        playValue: 861980097, playId: PLAY_1_ID, globalSolutionArea: 861980000, isPrimary: true,
      });
      // Staged op payload has pre-resolved plays — execute reads these directly
      const op = getApprovalQueue().get(parsed.operationId);
      expect(op.payload.plays[0]).toMatchObject({
        playValue: 861980097, playId: PLAY_1_ID, globalSolutionArea: 861980000, isPrimary: true,
      });
    });
  });

  describe('change_owner', () => {
    const OPP_ID = '55555555-5555-5555-5555-555555555555';
    const MILESTONE_ID = '66666666-6666-6666-6666-666666666666';
    const NEW_OWNER_ID = '33333333-3333-3333-3333-333333333333';

    beforeEach(() => {
      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path.startsWith('opportunities(') && !opts.method) return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Change Owner Opp', _ownerid_value: 'old-owner', '@odata.etag': 'W/"opp-etag-001"' } };
        if (path.startsWith('msp_engagementmilestones(') && !opts.method) return { ok: true, status: 200, data: { msp_engagementmilestoneid: MILESTONE_ID, msp_name: 'Change Owner MS', _ownerid_value: 'old-owner', '@odata.etag': 'W/"ms-etag-001"' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: NEW_OWNER_ID, fullname: 'New Owner', internalemailaddress: 'new@microsoft.com', isdisabled: false } };
        if (opts.method === 'PATCH') return { ok: true, status: 204, data: null };
        return { ok: true, status: 200, data: {} };
      });
    });

    it('stages opportunity owner change with owner bind', async () => {
      const result = await callTool(server, 'change_owner', { entityType: 'opportunity', recordId: OPP_ID, newOwnerId: NEW_OWNER_ID });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.payload).toEqual({ 'ownerid@odata.bind': `/systemusers(${NEW_OWNER_ID})` });
      const op = getApprovalQueue().get(parsed.operationId);
      expect(op.entitySet).toBe(`opportunities(${OPP_ID})`);
    });

    it('stages milestone owner change with owner bind', async () => {
      const result = await callTool(server, 'change_owner', { entityType: 'msp_engagementmilestone', recordId: MILESTONE_ID, newOwnerId: NEW_OWNER_ID });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      const op = getApprovalQueue().get(parsed.operationId);
      expect(op.entitySet).toBe(`msp_engagementmilestones(${MILESTONE_ID})`);
      expect(op.payload).toEqual({ 'ownerid@odata.bind': `/systemusers(${NEW_OWNER_ID})` });
    });

    it('rejects disabled new owner', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path.startsWith('opportunities(')) return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Opp', _ownerid_value: 'old-owner', '@odata.etag': 'W/"opp-etag-002"' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: NEW_OWNER_ID, fullname: 'Disabled', isdisabled: true } };
        return { ok: true, status: 200, data: {} };
      });
      const result = await callTool(server, 'change_owner', { entityType: 'opportunity', recordId: OPP_ID, newOwnerId: NEW_OWNER_ID });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disabled');
    });

    it('resolves accountName from the opportunity parent account (audit customer)', async () => {
      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path.startsWith('opportunities(') && !opts.method) return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Change Owner Opp', _ownerid_value: 'old-owner', _parentaccountid_value: 'acc-guid', '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'ACME Corp', '@odata.etag': 'W/"opp-etag-003"' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: NEW_OWNER_ID, fullname: 'New Owner', isdisabled: false } };
        if (opts.method === 'PATCH') return { ok: true, status: 204, data: null };
        return { ok: true, status: 200, data: {} };
      });
      const result = await callTool(server, 'change_owner', { entityType: 'opportunity', recordId: OPP_ID, newOwnerId: NEW_OWNER_ID });
      const parsed = JSON.parse(result.content[0].text);
      const op = getApprovalQueue().get(parsed.operationId);
      expect(op.accountName).toBe('ACME Corp');
    });

    it('resolves accountName for a milestone via its parent opportunity', async () => {
      const PARENT_OPP = '77777777-7777-7777-7777-777777777777';
      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path.startsWith('msp_engagementmilestones(') && !opts.method) return { ok: true, status: 200, data: { msp_engagementmilestoneid: MILESTONE_ID, msp_name: 'Change Owner MS', _ownerid_value: 'old-owner', _msp_opportunityid_value: PARENT_OPP, '@odata.etag': 'W/"ms-etag-002"' } };
        if (path.startsWith(`opportunities(${PARENT_OPP}`) && !opts.method) return { ok: true, status: 200, data: { opportunityid: PARENT_OPP, _parentaccountid_value: 'acc-guid', '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Globex SA' } };
        if (path.startsWith('systemusers(')) return { ok: true, status: 200, data: { systemuserid: NEW_OWNER_ID, fullname: 'New Owner', isdisabled: false } };
        if (opts.method === 'PATCH') return { ok: true, status: 204, data: null };
        return { ok: true, status: 200, data: {} };
      });
      const result = await callTool(server, 'change_owner', { entityType: 'msp_engagementmilestone', recordId: MILESTONE_ID, newOwnerId: NEW_OWNER_ID });
      const parsed = JSON.parse(result.content[0].text);
      const op = getApprovalQueue().get(parsed.operationId);
      expect(op.accountName).toBe('Globex SA');
    });
  });

  describe('delete_opportunity', () => {
    const OPP_ID = '55555555-5555-5555-5555-555555555555';
    const USER_ID = '33333333-3333-3333-3333-333333333333';

    beforeEach(() => {
      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: USER_ID } };
        if (path === 'LoseOpportunity' && opts.method === 'POST') return { ok: true, status: 204, data: null };
        if (path.startsWith('opportunities(')) return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Rollback Opp', _ownerid_value: USER_ID, createdon: new Date().toISOString(), statecode: 0 } };
        return { ok: true, status: 200, data: {} };
      });
      crm.requestAllPages.mockResolvedValue({ ok: true, status: 200, data: { value: [] } });
    });

    it('cancels a recently-created owned opportunity with no milestones', async () => {
      const result = await callTool(server, 'delete_opportunity', { opportunityId: OPP_ID });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toMatchObject({ ok: true, deleted: false, canceled: true, opportunityId: OPP_ID });
      expect(crm.request).toHaveBeenCalledWith('LoseOpportunity', expect.objectContaining({ method: 'POST' }));
      expect(crm.request).not.toHaveBeenCalledWith(`opportunities(${OPP_ID})`, { method: 'DELETE' });
    });

    it('refuses to delete when milestones exist', async () => {
      crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [{ msp_engagementmilestoneid: 'ms-1', msp_name: 'Existing MS' }] } });
      const result = await callTool(server, 'delete_opportunity', { opportunityId: OPP_ID });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('has_milestones');
      expect(crm.request).not.toHaveBeenCalledWith(`opportunities(${OPP_ID})`, { method: 'DELETE' });
    });

    it('refuses to delete opportunities not owned by current user', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: USER_ID } };
        if (path.startsWith('opportunities(')) return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Other Opp', _ownerid_value: '99999999-9999-9999-9999-999999999999', createdon: new Date().toISOString() } };
        return { ok: true, status: 200, data: {} };
      });
      const result = await callTool(server, 'delete_opportunity', { opportunityId: OPP_ID });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBe('owner_mismatch');
    });
  });

  describe('create_milestone', () => {
    it('validates opportunityId', async () => {
      const result = await callTool(server, 'create_milestone', {
        opportunityId: 'bad',
        name: 'Test Milestone'
      });
      expect(result.isError).toBe(true);
    });

    it('requires name', async () => {
      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects missing required milestone view fields', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { name: 'Test Opp' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'Test Milestone'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required milestone view fields');
      expect(result.content[0].text).not.toContain('workloadType');
      expect(result.content[0].text).toContain('deliveredBy');
      expect(result.content[0].text).toContain('preferredAzureRegion');
      expect(result.content[0].text).toContain('azureCapacityType');
      expect(result.content[0].text).toContain('get_milestone_field_options');
    });

    it('rejects partially provided milestone view fields', async () => {
      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'Test Milestone',
        workloadType: 861980000
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('deliveredBy');
      expect(result.content[0].text).not.toContain('workloadType');
    });

    it('stages create operation with expected bindings and fields', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { name: 'FY26 - Elevance | Benefits AI | Associate | #AIDesignWinHLS' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'FY25 - Benefits - AI App Service Performance Tuning',
        milestoneDate: '2026-03-27',
        monthlyUse: 1500,
        milestoneCategory: 861980002,
        customerCommitment: 861980000,
        milestoneStatus: 861980000,
        workloadId: 'aaaaaaaa-1111-2222-3333-444444444444',
        ownerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        workloadType: 861980000,
        deliveredBy: 606820000,
        preferredAzureRegion: 861980000,
        azureCapacityType: '861980000'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.operationId).toMatch(/^OP-/);
      expect(parsed.payload.msp_name).toBe('FY25 - Benefits - AI App Service Performance Tuning');
      expect(parsed.payload['msp_OpportunityId@odata.bind']).toBe('/opportunities(12345678-1234-1234-1234-123456789abc)');
      expect(parsed.payload.msp_milestonedate).toBe('2026-03-27');
      expect(parsed.payload.msp_monthlyuse).toBe(1500);
      expect(parsed.payload.msp_milestonecategory).toBe(861980002);
      expect(parsed.payload.msp_milestonestatus).toBe(861980000);
      expect(parsed.payload['ownerid@odata.bind']).toBe('/systemusers(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)');
      expect(parsed.payload['msp_WorkloadlkId@odata.bind']).toBe('/msp_workloads(aaaaaaaa-1111-2222-3333-444444444444)');
      expect(parsed.description).toContain('Benefits AI');

      // Required milestone view fields match provided values
      expect(parsed.payload.msp_milestoneworkload).toBe(861980000);
      expect(parsed.payload.msp_deliveryspecifiedfield).toBe(606820000);
      expect(parsed.payload.msp_milestonepreferredazureregion).toBe(861980000);
      expect(parsed.payload.msp_milestoneazurecapacitytype).toBe('861980000');

      // Full field summary with human-readable labels
      expect(parsed.fieldSummary).toBeDefined();
      expect(parsed.fieldSummary.msp_milestoneworkload).toBe('Azure (861980000)');
      expect(parsed.fieldSummary.msp_deliveryspecifiedfield).toBe('Customer (606820000)');
      expect(parsed.fieldSummary.msp_milestoneazurecapacitytype).toBe('None (861980000)');
      expect(parsed.fieldSummary.msp_milestonecategory).toBe('Production (861980002)');
      expect(parsed.fieldSummary.msp_milestonestatus).toBe('On Track (861980000)');
      expect(parsed.fieldSummary.msp_milestonedate).toBe('2026-03-27');
      expect(parsed.fieldSummary.msp_monthlyuse).toBe(1500);
      expect(parsed.fieldSummary.msp_name).toBe('FY25 - Benefits - AI App Service Performance Tuning');
    });

    it('stages with frontend payload shape after preflight passes', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { name: 'Test Opp' } };
        }
        if (path.startsWith('msp_workloads(')) {
          return { ok: true, status: 200, data: { msp_workloadid: 'cccccccc-1111-2222-3333-444444444444', msp_name: 'AI: Azure Machine Learning' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'Frontend Shape Milestone',
        milestoneDate: '2026-06-15',
        monthlyUse: 2000,
        milestoneCategory: 861980000,
        customerCommitment: 861980000,
        milestoneStatus: 861980005,
        milestoneComments: 'frontend payload comments',
        workloadId: 'cccccccc-1111-2222-3333-444444444444',
        deliveredBy: '606820000',
        preferredAzureRegion: '861980076',
        azureCapacityType: '861980000'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.payload.msp_milestoneworkload).toBe(861980000);
      expect(parsed.payload.msp_deliveryspecifiedfield).toBe(606820000);
      expect(parsed.payload.msp_milestonepreferredazureregion).toBe(861980076);
      expect(parsed.payload.msp_commitmentrecommendation).toBe(861980000);
      expect(parsed.payload.msp_milestonestatusreason).toBeUndefined();
    });

    it('stages with user-specified milestone view field values', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { name: 'Test Opp' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'Custom Fields Milestone',
        milestoneDate: '2026-06-15',
        monthlyUse: 2000,
        milestoneCategory: 861980000,
        customerCommitment: 861980000,
        workloadId: 'cccccccc-1111-2222-3333-444444444444',
        workloadType: 861980001,
        deliveredBy: 606820001,
        preferredAzureRegion: 861980002,
        azureCapacityType: '861980081,861980065'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payload.msp_milestoneworkload).toBe(861980001);
      expect(parsed.payload.msp_deliveryspecifiedfield).toBe(606820001);
      expect(parsed.payload.msp_milestonepreferredazureregion).toBe(861980002);
      expect(parsed.payload.msp_milestoneazurecapacitytype).toBe('861980081,861980065');
    });

    it('adds quota capacity blocker reason fields for blocked capacity milestones', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { name: 'Capacity Opp' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'Azure OpenAI capacity blocker',
        milestoneDate: '2026-06-15',
        monthlyUse: 2000,
        milestoneCategory: 861980000,
        customerCommitment: 861980000,
        milestoneStatus: 'Blocked',
        workloadId: 'cccccccc-1111-2222-3333-444444444444',
        workloadType: 861980000,
        deliveredBy: 606820000,
        preferredAzureRegion: 861980006,
        azureCapacityType: '861980081'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payload.msp_milestonestatus).toBe(861980002);
      expect(parsed.payload.msp_milestonestatusreason).toBe(861980009);
      expect(parsed.payload.msp_helpneeded).toBe(861980001);
      expect(parsed.fieldSummary.msp_milestonestatusreason).toBe('Capacity/Service Availability (861980009)');
      expect(parsed.fieldSummary.msp_helpneeded).toBe('Azure Capacity (861980001)');
    });

    it('requires a status reason when creating a blocked non-capacity milestone', async () => {
      const result = await callTool(server, 'create_milestone', {
        opportunityId: '12345678-1234-1234-1234-123456789abc',
        name: 'Blocked milestone',
        milestoneDate: '2026-06-15',
        monthlyUse: 2000,
        milestoneCategory: 861980000,
        customerCommitment: 861980000,
        milestoneStatus: 'Blocked',
        workloadId: 'cccccccc-1111-2222-3333-444444444444',
        workloadType: 861980000,
        deliveredBy: 606820000,
        preferredAzureRegion: 861980006,
        azureCapacityType: '861980000'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('milestoneStatusReason is required');
      expect(result.content[0].text).toContain('Capacity/Service Availability');
    });
  });

  describe('update_task', () => {
    it('rejects empty update', async () => {
      const result = await callTool(server, 'update_task', {
        taskId: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBe(true);
    });

    it('stages update with before-state', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: { subject: 'Old Subject', '@odata.etag': 'W/"12345"' }
      });
      const result = await callTool(server, 'update_task', {
        taskId: '12345678-1234-1234-1234-123456789abc',
        subject: 'New Subject'
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.before.subject).toBe('Old Subject');
      expect(parsed.after.subject).toBe('New Subject');
    });
  });

  describe('close_task', () => {
    it('requires statusCode', async () => {
      const result = await callTool(server, 'close_task', {
        taskId: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBe(true);
    });

    it('stages close operation', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true, status: 200, data: { subject: 'My Task', statuscode: 2 }
      });
      const result = await callTool(server, 'close_task', {
        taskId: '12345678-1234-1234-1234-123456789abc',
        statusCode: 5
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.statusCode).toBe(5);
    });
  });

  describe('update_milestone', () => {
    const MILESTONE_GUID = '12345678-1234-1234-1234-123456789abc';
    const OPP_GUID = 'aaaa1111-2222-3333-4444-555566667777';

    const makeMilestoneRecord = (overrides = {}) => ({
      msp_engagementmilestoneid: MILESTONE_GUID,
      msp_milestonenumber: '7-100000001',
      msp_name: 'Kickoff Meeting',
      _msp_opportunityid_value: OPP_GUID,
      '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Contoso AI Platform',
      _ownerid_value: 'abc-123', // matches WhoAmI
      msp_milestonedate: '2026-03-01',
      msp_monthlyuse: 500,
      msp_forecastcomments: 'On track',
      '@odata.etag': 'W/"staged-etag-001"',
      ...overrides
    });

    it('rejects invalid milestoneId GUID', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: 'not-a-guid',
        milestoneDate: '2026-04-15'
      });
      expect(result.isError).toBe(true);
    });

    it('rejects empty update (no fields)', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID
      });
      expect(result.isError).toBe(true);
    });

    it('rejects passing BOTH monthlyUse and seats', async () => {
      // A milestone has one quantity; which CRM field holds it depends on whether the
      // milestone is consumption (msp_monthlyuse) or usage (msp_noofactivations). Writing
      // both in one PATCH leaves the record self-contradictory, and the reader would pick
      // whichever its unit classification prefers — so the conflict would never surface.
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        monthlyUse: 5000,
        seats: 250
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not both');
    });

    it('stages seats into the usage field, not the currency one', async () => {
      // The reason update_milestone gained `seats` at all: msp_noofactivations is where a
      // usage milestone's quantity lives, and there was previously no way to write it.
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: makeMilestoneRecord({ msp_noofactivations: 10 }) };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        seats: 250
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.after.msp_noofactivations).toBe(250);
      expect(parsed.after.msp_monthlyuse).toBeUndefined();
      expect(parsed.before.msp_noofactivations).toBe(10);
    });

    it('stages monthlyUse into the currency field, not the usage one', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: makeMilestoneRecord() };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        monthlyUse: 5000
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.after.msp_monthlyuse).toBe(5000);
      expect(parsed.after.msp_noofactivations).toBeUndefined();
    });

    it('returns error when milestone is not found', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: false, status: 404, data: { message: 'Not Found' } };
        return { ok: true, status: 200, data: {} };
      });
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneDate: '2026-04-15'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found or inaccessible');
    });

    it('stages update with identity metadata when user owns milestone', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneDate: '2026-04-15'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      expect(parsed.identity.milestoneNumber).toBe('7-100000001');
      expect(parsed.identity.milestoneName).toBe('Kickoff Meeting');
      expect(parsed.identity.opportunityName).toBe('Contoso AI Platform');
      expect(parsed.description).toContain('7-100000001');
      expect(parsed.description).toContain('Contoso AI Platform');
      expect(parsed.before.msp_milestonedate).toBe('2026-03-01');
      expect(parsed.after.msp_milestonedate).toBe('2026-04-15');
    });

    it('allows update when user is on the deal team (owns other milestones under same opp)', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: makeMilestoneRecord({ _ownerid_value: 'other-user-id' }) };
        }
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { _ownerid_value: 'other-user-id' } };
        }
        return { ok: true, status: 200, data: {} };
      });
      crm.requestAllPages.mockImplementation(async (entity) => {
        if (entity === 'msp_engagementmilestones') {
          return { ok: true, status: 200, data: { value: [{ msp_engagementmilestoneid: 'other-ms' }] } };
        }
        return { ok: true, status: 200, data: { value: [] } };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        monthlyUse: 1000
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
    });

    it('rejects update when user is not owner and not on deal team', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: makeMilestoneRecord({ _ownerid_value: 'other-user-id' }) };
        }
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { _ownerid_value: 'other-user-id' } };
        }
        return { ok: true, status: 200, data: {} };
      });
      crm.requestAllPages.mockImplementation(async () => {
        return { ok: true, status: 200, data: { value: [] } };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneDate: '2026-04-15'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Ownership check failed');
      expect(result.content[0].text).toContain('not on the deal team');
    });

    it('rejects update when milestone has no opportunity and user is not owner', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: makeMilestoneRecord({
            _ownerid_value: 'other-user-id',
            _msp_opportunityid_value: null
          }) };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        monthlyUse: 999
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no linked opportunity');
    });

    it('allows update when user owns the parent opportunity', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: makeMilestoneRecord({ _ownerid_value: 'other-user-id' }) };
        }
        if (path.startsWith('opportunities(')) {
          return { ok: true, status: 200, data: { _ownerid_value: 'abc-123' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        forecastComments: 'Updated forecast'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
    });

    it('maps milestone comments into the staged payload', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneComments: 'Waiting on quota approval from Azure capacity team.'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payload.msp_milestonecomments).toBe('Waiting on quota approval from Azure capacity team.');
      expect(parsed.after.msp_milestonecomments).toBe('Waiting on quota approval from Azure capacity team.');
      expect(parsed.before.msp_milestonecomments).toBeNull();
    });

    it('milestoneComments also appends to forecast history fields with commentAuthorName', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return {
          ok: true, status: 200,
          data: makeMilestoneRecord({
            msp_forecastcomments: 'HCM - 18/Mar - Earlier note\n',
            msp_forecastcommentsjsonfield: JSON.stringify([
              { userId: 'Hector Calvarro Martin', modifiedOn: '2025-03-18T11:41:54.596Z', comment: 'Earlier note' }
            ])
          })
        };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneComments: 'Test comment',
        commentAuthorName: 'Joaquin Perez del Real',
        commentAuthorGuid: 'ef8aee05-07b5-e711-8114-c4346bdca111'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // msp_milestonecomments is the plain overwrite
      expect(parsed.payload.msp_milestonecomments).toBe('Test comment');
      // msp_forecastcomments should be prepended
      expect(parsed.payload.msp_forecastcomments).toMatch(/^JPdR - .+ - Test comment\n/);
      expect(parsed.payload.msp_forecastcomments).toContain('HCM - 18/Mar - Earlier note\n');
      // msp_forecastcommentsjsonfield should append with full-name userId (NOT GUID —
      // using a GUID triggers CRM's post-save plugin that overwrites msp_forecastcomments)
      const entries = JSON.parse(parsed.payload.msp_forecastcommentsjsonfield);
      expect(entries).toHaveLength(2);
      expect(entries[1].userId).toBe('Joaquin Perez del Real');
      expect(entries[1].comment).toBe('Test comment');
    });

    it('rejects resubmission of the existing forecast rollup as a new comment', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return {
          ok: true, status: 200,
          data: makeMilestoneRecord({
            msp_forecastcomments: 'HCM - 18/Mar - Earlier note\n',
            msp_forecastcommentsjsonfield: JSON.stringify([
              { userId: 'Hector Calvarro Martin', modifiedOn: '2025-03-18T11:41:54.596Z', comment: 'Earlier note' }
            ])
          })
        };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneComments: 'HCM - 18/Mar - Earlier note\nJPdR - 21/May - New note',
        commentAuthorName: 'Joaquin Perez del Real',
        commentAuthorGuid: 'ef8aee05-07b5-e711-8114-c4346bdca111'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/append-only/i);
    });

    it('milestoneComments does not overwrite explicit forecastComments', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneComments: 'Status comment',
        forecastComments: 'Explicit forecast text',
        commentAuthorName: 'Joaquin Perez del Real',
        commentAuthorGuid: 'ef8aee05-07b5-e711-8114-c4346bdca111'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Explicit forecastComments wins — no auto-append
      expect(parsed.payload.msp_forecastcomments).toBe('Explicit forecast text');
      expect(parsed.payload.msp_milestonecomments).toBe('Status comment');
    });

    it('rejects empty name (prevents blanking)', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        name: ''
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name cannot be empty');
    });

    it('rejects whitespace-only name', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        name: '   '
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('name cannot be empty');
    });

    it('stages name update without touching other fields', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        name: 'Renamed Milestone'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.staged).toBe(true);
      // Payload only contains the single field being updated
      expect(parsed.after).toEqual({ msp_name: 'Renamed Milestone' });
      expect(parsed.before).toEqual({ msp_name: 'Kickoff Meeting' });
    });

    it('stages status and category update with minimal payload', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneStatus: 861980001,
        milestoneCategory: 2
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.after.msp_milestonestatus).toBe('At Risk (861980001)');
      expect(parsed.after.msp_milestonecategory).toBe('2');  // not in MILESTONE_CATEGORIES — resolves to string fallback
      // Must NOT include fields not being updated
      expect(parsed.after.msp_name).toBeUndefined();
      expect(parsed.after.msp_milestonedate).toBeUndefined();
      expect(parsed.after.msp_monthlyuse).toBeUndefined();
      expect(parsed.after.msp_forecastcomments).toBeUndefined();
    });

    it('accepts milestoneStatus as string label', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneStatus: 'Cancelled'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payload.msp_milestonestatus).toBe(861980004);
      expect(parsed.after.msp_milestonestatus).toBe('Cancelled (861980004)');
    });

    it('adds quota capacity blocker reason fields when updating status to blocked', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return {
            ok: true,
            status: 200,
            data: makeMilestoneRecord({ msp_milestoneazurecapacitytype: '861980081' })
          };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneStatus: 'Blocked'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payload.msp_milestonestatus).toBe(861980002);
      expect(parsed.payload.msp_milestonestatusreason).toBe(861980009);
      expect(parsed.payload.msp_helpneeded).toBe(861980001);
      expect(parsed.after.msp_milestonestatusreason).toBe('Capacity/Service Availability (861980009)');
      expect(parsed.after.msp_helpneeded).toBe('Azure Capacity (861980001)');
    });

    it('rejects invalid milestoneStatus string', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneStatus: 'InvalidStatus'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid milestoneStatus');
    });

    it('stages workload binding update', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const WORKLOAD_GUID = 'bbbbbbbb-1111-2222-3333-444444444444';
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        workloadId: WORKLOAD_GUID
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.after['msp_WorkloadlkId@odata.bind']).toBe(`/msp_workloads(${WORKLOAD_GUID.toLowerCase()})`);
    });

    it('rejects invalid workloadId GUID', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        workloadId: 'not-a-guid'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid workloadId GUID');
    });

    it('stages owner binding update', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) return { ok: true, status: 200, data: makeMilestoneRecord() };
        return { ok: true, status: 200, data: {} };
      });

      const NEW_OWNER = 'cccccccc-1111-2222-3333-444444444444';
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        ownerId: NEW_OWNER
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.after['ownerid@odata.bind']).toBe(`/systemusers(${NEW_OWNER.toLowerCase()})`);
    });

    it('rejects invalid ownerId GUID', async () => {
      const result = await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        ownerId: 'bad-owner'
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid ownerId GUID');
    });
  });

  describe('update_milestone execution integrity', () => {
    const MILESTONE_GUID = '12345678-1234-1234-1234-123456789abc';
    const OPP_GUID = 'aaaa1111-2222-3333-4444-555566667777';

    it('execute_operation blocks when milestone number does not match staged identity', async () => {
      // Stage an update with identity
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: {
            msp_engagementmilestoneid: MILESTONE_GUID,
            msp_milestonenumber: '7-100000001',
            msp_name: 'Kickoff',
            _msp_opportunityid_value: OPP_GUID,
            _ownerid_value: 'abc-123',
            msp_milestonedate: '2026-03-01',
            '@odata.etag': 'W/"staged-etag-002"'
          } };
        }
        return { ok: true, status: 200, data: {} };
      });

      await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneDate: '2026-04-15'
      });

      // Now at execution time, the record returns a different milestone number
      crm.request.mockImplementation(async (path, opts) => {
        if (path.startsWith('msp_engagementmilestones(') && !opts?.method) {
          return { ok: true, status: 200, data: {
            msp_milestonenumber: '7-DIFFERENT',
            msp_name: 'Wrong Milestone',
            _msp_opportunityid_value: 'other-opp'
          } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'execute_operation', { id: 'OP-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('identity mismatch');
      expect(result.content[0].text).toContain('7-100000001');
    });

    it('execute_operation proceeds when milestone number matches', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: {
            msp_engagementmilestoneid: MILESTONE_GUID,
            msp_milestonenumber: '7-100000001',
            msp_name: 'Kickoff',
            _msp_opportunityid_value: OPP_GUID,
            _ownerid_value: 'abc-123',
            msp_milestonedate: '2026-03-01',
            '@odata.etag': 'W/"staged-etag-003"'
          } };
        }
        return { ok: true, status: 200, data: {} };
      });

      await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneDate: '2026-04-15'
      });

      // Execution-time re-check returns matching number, then PATCH succeeds
      crm.request.mockImplementation(async (path, opts) => {
        if (path.startsWith('msp_engagementmilestones(') && !opts?.method) {
          return { ok: true, status: 200, data: { msp_milestonenumber: '7-100000001' } };
        }
        if (opts?.method === 'PATCH') {
          return { ok: true, status: 204, data: null };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'execute_operation', { id: 'OP-1' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('execute_operation preserves structured partial state when milestone create fails after parent patch', async () => {
      const op = getApprovalQueue().stage({
        type: 'create_milestone',
        entitySet: 'msp_engagementmilestones',
        method: 'POST',
        payload: {
          opportunityId: OPP_GUID,
          opportunityPatch: { msp_eststartdate: '2026-06-02' },
          create: { msp_name: 'Partial Milestone' },
          ownerPatch: {}
        },
        description: 'Create partial milestone test'
      });

      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path.startsWith('opportunities(') && opts.method === 'PATCH') {
          return { ok: true, status: 204, data: null };
        }
        if (path === 'msp_engagementmilestones' && opts.method === 'POST') {
          return { ok: false, status: 400, data: { message: 'CRM validation failed' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'execute_operation', { id: op.id });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe(true);
      expect(parsed.partial).toBe(true);
      expect(parsed.completedSteps).toEqual(['patchParentOpportunityDates']);
      expect(parsed.failedStep).toMatchObject({ step: 'createMilestone', status: 400 });
    });

    it('execute_operation aborts when milestone is no longer accessible', async () => {
      crm.request.mockImplementation(async (path) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
        if (path.startsWith('msp_engagementmilestones(')) {
          return { ok: true, status: 200, data: {
            msp_engagementmilestoneid: MILESTONE_GUID,
            msp_milestonenumber: '7-100000001',
            msp_name: 'Kickoff',
            _msp_opportunityid_value: OPP_GUID,
            _ownerid_value: 'abc-123',
            msp_milestonedate: '2026-03-01',
            '@odata.etag': 'W/"staged-etag-004"'
          } };
        }
        return { ok: true, status: 200, data: {} };
      });

      await callTool(server, 'update_milestone', {
        milestoneId: MILESTONE_GUID,
        milestoneDate: '2026-04-15'
      });

      // At execution time, record is gone
      crm.request.mockImplementation(async (path, opts) => {
        if (path.startsWith('msp_engagementmilestones(') && !opts?.method) {
          return { ok: false, status: 404, data: { message: 'Not Found' } };
        }
        return { ok: true, status: 200, data: {} };
      });

      const result = await callTool(server, 'execute_operation', { id: 'OP-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no longer accessible');
    });
  });

  describe('list_accounts_by_tpid', () => {
    it('rejects non-numeric TPIDs', async () => {
      const result = await callTool(server, 'list_accounts_by_tpid', { tpids: ['abc'] });
      expect(result.isError).toBe(true);
    });

    it('looks up accounts by valid TPID', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true, status: 200, data: { value: [{ accountid: 'a-1', name: 'Contoso' }] }
      });
      const result = await callTool(server, 'list_accounts_by_tpid', { tpids: ['12345'] });
      expect(result.isError).toBeUndefined();
    });
  });

  describe('view_milestone_timeline', () => {
    it('requires ownerId or opportunityId', async () => {
      const result = await callTool(server, 'view_milestone_timeline', {});
      expect(result.isError).toBe(true);
    });

    it('returns timeline events with render hints', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          value: [{
            msp_engagementmilestoneid: '11111111-1111-1111-1111-111111111111',
            msp_name: 'Kickoff',
            msp_milestonenumber: '7-100000001',
            msp_milestonedate: '2026-03-01',
            msp_milestonestatus: 1,
            _msp_opportunityid_value: '22222222-2222-2222-2222-222222222222'
          }]
        }
      });
      crm.request.mockResolvedValueOnce({ ok: true, status: 200, data: { name: 'Deal A' } });

      const result = await callTool(server, 'view_milestone_timeline', {
        ownerId: '12345678-1234-1234-1234-123456789abc'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.renderHints.view).toBe('timeline');
    });
  });

  describe('view_opportunity_cost_trend', () => {
    it('requires valid opportunityId', async () => {
      const result = await callTool(server, 'view_opportunity_cost_trend', { opportunityId: 'bad-id' });
      expect(result.isError).toBe(true);
    });

    it('returns points and KPI values', async () => {
      crm.request.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          opportunityid: '12345678-1234-1234-1234-123456789abc',
          name: 'Deal A',
          msp_consumptionconsumedrecurring: 500
        }
      });
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          value: [
            { msp_milestonedate: '2026-03-01', msp_monthlyuse: 100 },
            { msp_milestonedate: '2026-03-15', msp_monthlyuse: 200 },
            { msp_milestonedate: '2026-04-01', msp_monthlyuse: 300 }
          ]
        }
      });

      const result = await callTool(server, 'view_opportunity_cost_trend', {
        opportunityId: '12345678-1234-1234-1234-123456789abc'
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.points.length).toBe(2);
      expect(parsed.kpis.totalPlannedMonthlyUse).toBe(600);
      expect(parsed.renderHints.view).toBe('timeseries');
    });
  });

  describe('view_staged_changes_diff', () => {
    it('returns changed fields in diff rows', async () => {
      const result = await callTool(server, 'view_staged_changes_diff', {
        before: { subject: 'Old', due: '2026-03-10', unchanged: 'x' },
        after: { subject: 'New', due: null, unchanged: 'x', owner: 'me' },
        context: 'OP-1'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.context).toBe('OP-1');
      expect(parsed.summary.changedFieldCount).toBe(3);
      expect(parsed.renderHints.view).toBe('diffTable');
    });
  });

  describe('approval queue tools', () => {
    it('list_pending_operations returns empty when queue is clean', async () => {
      const result = await callTool(server, 'list_pending_operations', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.operations).toHaveLength(0);
    });

    it('list_pending_operations shows staged writes', async () => {
      // Stage a task via create_task
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Test Task'
      });
      const result = await callTool(server, 'list_pending_operations', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.operations[0].type).toBe('create_task');
    });

    it('execute_operation approves and executes a staged write', async () => {
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Test Task'
      });
      crm.request.mockResolvedValueOnce({ ok: true, status: 201, data: { activityid: 'new-task-1' } });
      const result = await callTool(server, 'execute_operation', { id: 'OP-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.executed).toBe('OP-1');
    });

    it('execute_operation returns error for missing op', async () => {
      const result = await callTool(server, 'execute_operation', { id: 'OP-999' });
      expect(result.isError).toBe(true);
    });

    it('cancel_operation rejects a staged write', async () => {
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Test Task'
      });
      const result = await callTool(server, 'cancel_operation', { id: 'OP-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.cancelled).toBe('OP-1');
      // Verify it's gone
      const list = await callTool(server, 'list_pending_operations', {});
      const listParsed = JSON.parse(list.content[0].text);
      expect(listParsed.count).toBe(0);
    });

    it('execute_all executes all pending ops', async () => {
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Task A'
      });
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Task B'
      });
      crm.request.mockResolvedValue({ ok: true, status: 201, data: {} });
      const result = await callTool(server, 'execute_all', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.executed).toBe(2);
      expect(parsed.failed).toBe(0);
    });

    it('cancel_all cancels all pending ops', async () => {
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Task A'
      });
      await callTool(server, 'create_task', {
        milestoneId: '12345678-1234-1234-1234-123456789abc',
        subject: 'Task B'
      });
      const result = await callTool(server, 'cancel_all', {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.cancelled).toBe(2);
    });
  });
});

describe('isEntityAllowed', () => {
  it('allows base entity set names', () => {
    expect(isEntityAllowed('accounts')).toBe(true);
    expect(isEntityAllowed('opportunities')).toBe(true);
    expect(isEntityAllowed('msp_engagementmilestones')).toBe(true);
    expect(isEntityAllowed('tasks')).toBe(true);
  });

  it('allows entity sets with key suffix', () => {
    expect(isEntityAllowed('accounts(12345678-1234-1234-1234-123456789abc)')).toBe(true);
    expect(isEntityAllowed('tasks(some-guid)')).toBe(true);
  });

  it('rejects entity sets not in the allowlist', () => {
    expect(isEntityAllowed('emails')).toBe(false);
    expect(isEntityAllowed('annotations')).toBe(false);
    expect(isEntityAllowed('phonecalls')).toBe(false);
    expect(isEntityAllowed('letters')).toBe(false);
    expect(isEntityAllowed('activitypointers')).toBe(false);
  });

  it('rejects empty or invalid inputs', () => {
    expect(isEntityAllowed('')).toBe(false);
    expect(isEntityAllowed(null)).toBe(false);
    expect(isEntityAllowed(undefined)).toBe(false);
  });
});

describe('ALLOWED_ENTITY_SETS', () => {
  it('contains expected core entity sets', () => {
    expect(ALLOWED_ENTITY_SETS.has('accounts')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('opportunities')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('msp_engagementmilestones')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('tasks')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('msp_dealteams')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('systemusers')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('connections')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('connectionroles')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('processstages')).toBe(true);
    expect(ALLOWED_ENTITY_SETS.has('savedqueries')).toBe(true);
  });

  it('does not contain high-risk PII entity sets', () => {
    expect(ALLOWED_ENTITY_SETS.has('emails')).toBe(false);
    expect(ALLOWED_ENTITY_SETS.has('annotations')).toBe(false);
    expect(ALLOWED_ENTITY_SETS.has('phonecalls')).toBe(false);
  });
});

describe('CRM_QUERY_MAX_RECORDS', () => {
  it('is a positive number set to 500', () => {
    expect(CRM_QUERY_MAX_RECORDS).toBe(500);
    expect(typeof CRM_QUERY_MAX_RECORDS).toBe('number');
  });
});

// ── MILESTONE_CATEGORIES regression guard ────────────────────────────────────
// Asserts the full live-validated 10-option picklist is present and the phantom
// "Pre-Production" (861980001) has been removed.  This prevents the bug where
// normalizeNumericOption rejected valid categories with "option X is not supported."
describe('MILESTONE_CATEGORIES', () => {
  const EXPECTED_CATEGORIES = [
    { label: 'POC/Pilot',            value: 861980000 },
    { label: 'Production',           value: 861980002 },
    { label: 'Deal Registration',    value: 861980003 },
    { label: 'Dual Credit',          value: 861980004 },
    { label: 'Other Adjustments',    value: 861980005 },
    { label: 'Partner Reported ACR', value: 861980006 },
    { label: 'Credit Offer',         value: 861980007 },
    { label: 'Optimization',         value: 861980008 },
    { label: 'Intent (MW, BA, Sec)', value: 861980009 },
    { label: 'ISV/ Marketplace',     value: 725300001 },
  ];

  it('contains exactly the 10 live-validated categories', () => {
    expect(MILESTONE_CATEGORIES).toHaveLength(10);
  });

  it.each(EXPECTED_CATEGORIES)('includes $label ($value)', ({ value }) => {
    expect(MILESTONE_CATEGORIES.some(o => o.value === value)).toBe(true);
  });

  it('does NOT contain phantom Pre-Production (861980001)', () => {
    expect(MILESTONE_CATEGORIES.some(o => o.value === 861980001)).toBe(false);
  });
});

// ── Audit read tools ──────────────────────────────────────────────────────────
// Tests for query_audit_log and get_audit_entry MCP tools
describe('audit read tools', () => {
  let server;
  let crm;
  let testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    resetApprovalQueue();
    testDir = mkdtempSync(join(tmpdir(), 'audit-test-'));
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'abc-123', BusinessUnitId: 'bu-1' } }
    });
    registerTools(server, crm);
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  function sampleRecord(overrides = {}) {
    return makeChangeRecord({
      operationId: 'OP-1',
      correlationId: null,
      phase: 'executed',
      actor: 'user@microsoft.com',
      sessionId: 'sess_test',
      tool: 'update_opportunity',
      entitySet: 'opportunities(abc-123)',
      recordId: '12345678-1234-1234-1234-123456789abc',
      recordName: 'Contoso Q2',
      method: 'PATCH',
      description: 'Update stage',
      beforeState: { stage: 'proposal' },
      intendedAfter: { stage: 'won' },
      result: { ok: true, status: 204 },
      ...overrides,
    });
  }

  it('query_audit_log returns filtered results', async () => {
    const r1 = sampleRecord({ correlationId: 'batch_abc', entitySet: 'opportunities(a)' });
    const r2 = sampleRecord({ correlationId: null, entitySet: 'milestones(b)' });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });

    // Override audit-store dir resolution for this test
    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { entitySet: 'opportunities' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0].entitySet).toContain('opportunities');

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log filters by correlationId', async () => {
    const r1 = sampleRecord({ correlationId: 'batch_abc' });
    const r2 = sampleRecord({ correlationId: 'batch_xyz' });
    const r3 = sampleRecord({ correlationId: null });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });
    appendChangeRecord(r3, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { correlationId: 'batch_abc' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0].correlationId).toBe('batch_abc');

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log returns all records when no filters (incl. batch and manual)', async () => {
    const r1 = sampleRecord({ correlationId: 'batch_abc' });
    const r2 = sampleRecord({ correlationId: null });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.entries.some(e => e.correlationId === 'batch_abc')).toBe(true);
    expect(parsed.entries.some(e => e.correlationId === null)).toBe(true);

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('get_audit_entry returns a single record', async () => {
    const record = sampleRecord();
    appendChangeRecord(record, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'get_audit_entry', { id: record.id });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(record.id);
    expect(parsed.description).toBe('Update stage');

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('get_audit_entry returns error for non-existent ID', async () => {
    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'get_audit_entry', { id: 'chg_nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Audit entry not found');

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log coerces blank correlationId to undefined (returns all)', async () => {
    const r1 = sampleRecord({ correlationId: 'batch_abc' });
    const r2 = sampleRecord({ correlationId: null });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { correlationId: '' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2); // blank correlationId → undefined → returns all

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log clamps negative limit to 1', async () => {
    for (let i = 0; i < 5; i++) {
      appendChangeRecord(sampleRecord({ operationId: `OP-${i}` }), { dir: testDir });
    }

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { limit: -1 });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(5);
    expect(parsed.entries).toHaveLength(1); // clamped to 1

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log ignores invalid startDate', async () => {
    appendChangeRecord(sampleRecord(), { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { startDate: 'invalid-date' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(1); // not filtered to zero

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log accepts source filter (batch)', async () => {
    const r1 = sampleRecord({ correlationId: 'batch_abc' });
    const r2 = sampleRecord({ correlationId: null });
    const r3 = sampleRecord({ correlationId: 'batch_def' });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });
    appendChangeRecord(r3, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { source: 'batch' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.entries.every(e => e.correlationId != null)).toBe(true);

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log accepts source filter (manual)', async () => {
    const r1 = sampleRecord({ correlationId: 'batch_abc' });
    const r2 = sampleRecord({ correlationId: null });
    const r3 = sampleRecord({ correlationId: null });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });
    appendChangeRecord(r3, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { source: 'manual' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.entries.every(e => e.correlationId == null)).toBe(true);

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log accepts outcome filter (ok)', async () => {
    const r1 = sampleRecord({ phase: 'executed' });
    const r2 = sampleRecord({ phase: 'failed' });
    const r3 = sampleRecord({ phase: 'executed' });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });
    appendChangeRecord(r3, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { outcome: 'ok' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.entries.every(e => e.phase === 'executed')).toBe(true);

    process.env.MSX_USER_DATA = savedUserData;
  });

  it('query_audit_log accepts outcome filter (attention)', async () => {
    const r1 = sampleRecord({ phase: 'executed' });
    const r2 = sampleRecord({ phase: 'failed' });
    const r3 = sampleRecord({ phase: 'stale-conflict' });
    const r4 = sampleRecord({ phase: 'dead-letter' });
    const r5 = sampleRecord({ phase: 'uncertain' });
    appendChangeRecord(r1, { dir: testDir });
    appendChangeRecord(r2, { dir: testDir });
    appendChangeRecord(r3, { dir: testDir });
    appendChangeRecord(r4, { dir: testDir });
    appendChangeRecord(r5, { dir: testDir });

    process.env.MSX_USER_DATA = testDir;

    const result = await callTool(server, 'query_audit_log', { outcome: 'attention' });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(4);
    const attentionPhases = new Set(['failed', 'stale-conflict', 'dead-letter', 'uncertain']);
    expect(parsed.entries.every(e => attentionPhases.has(e.phase))).toBe(true);

    process.env.MSX_USER_DATA = savedUserData;
  });
});

// ── Optimistic Concurrency Tests (Phase 2.4) ────────────────────────────────

describe('execute_operation with 412 stale-conflict handling', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-test-412-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('marks op as stale-conflict and audits on 412 Precondition Failed', async () => {
    // Stage a PATCH operation
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(abc-123)',
      method: 'PATCH',
      payload: { subject: 'Updated' },
      etag: 'W/"old-etag"',
      beforeState: { subject: 'Original' },
      description: 'Update task abc-123'
    });

    // Mock CRM to return 412
    crm.request.mockResolvedValueOnce({
      ok: false,
      status: 412,
      data: { message: 'Precondition Failed' }
    });

    const result = await callTool(server, 'execute_operation', { id: op.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale-conflict');
    expect(result.content[0].text).toContain('412');

    // Verify op status is stale-conflict
    const finalOp = queue.get(op.id);
    expect(finalOp.status).toBe('stale-conflict');

    // Verify audit record was captured
    const auditEntries = JSON.parse((await callTool(server, 'query_audit_log', { limit: 10 })).content[0].text).entries;
    const staleEntry = auditEntries.find(e => e.operationId === op.id && e.phase === 'stale-conflict');
    expect(staleEntry).toBeDefined();
    expect(staleEntry.result.status).toBe(412);
  });

  it('does NOT dead-letter a stale-conflict op', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(abc-123)',
      method: 'PATCH',
      payload: { subject: 'Updated' },
      etag: 'W/"old-etag"',
      beforeState: { subject: 'Original' },
      description: 'Update task abc-123'
    });

    // Mock CRM to return 412
    crm.request.mockResolvedValueOnce({
      ok: false,
      status: 412,
      data: { message: 'Precondition Failed' }
    });

    await callTool(server, 'execute_operation', { id: op.id });

    // Verify op is still in the map (not deleted, not dead-lettered)
    const finalOp = queue.get(op.id);
    expect(finalOp).toBeDefined();
    expect(finalOp.status).toBe('stale-conflict');
    // retryCount is not incremented for stale-conflict
    expect(finalOp.retryCount || 0).toBe(0);
  });

  it('exposes retryCount and lastError fields in list_pending_operations', async () => {
    const queue = getApprovalQueue();
    
    // Stage a clean pending op
    const cleanOp = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(clean-123)',
      method: 'PATCH',
      payload: { subject: 'Clean' },
      beforeState: { subject: 'Original' },
      description: 'Clean pending op'
    });

    // Stage an op and mark it as stale-conflict
    const staleOp = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(stale-456)',
      method: 'PATCH',
      payload: { subject: 'Stale' },
      etag: 'W/"old-etag"',
      beforeState: { subject: 'Original' },
      description: 'Stale conflict op'
    });
    staleOp.status = 'stale-conflict';

    // Stage an op with retryCount and lastError (failed auto-execute)
    const failedOp = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(failed-789)',
      method: 'PATCH',
      payload: { subject: 'Failed' },
      beforeState: { subject: 'Original' },
      description: 'Failed retry op'
    });
    failedOp.retryCount = 1;
    failedOp.lastError = { error: 'Network timeout', code: 500 };

    // Call list_pending_operations
    const result = await callTool(server, 'list_pending_operations', {});
    const parsed = JSON.parse(result.content[0].text);

    // Should include all three ops (pending + stale-conflict)
    expect(parsed.operations.length).toBe(3);

    // Verify clean op has retryCount=0 and lastError=null
    const cleanInList = parsed.operations.find(o => o.id === cleanOp.id);
    expect(cleanInList).toBeDefined();
    expect(cleanInList.retryCount).toBe(0);
    expect(cleanInList.lastError).toBeNull();

    // Verify stale-conflict op has retryCount=0 and lastError=null (stale-conflict doesn't increment retry)
    const staleInList = parsed.operations.find(o => o.id === staleOp.id);
    expect(staleInList).toBeDefined();
    expect(staleInList.status).toBe('stale-conflict');
    expect(staleInList.retryCount).toBe(0);
    expect(staleInList.lastError).toBeNull();

    // Verify failed retry op has retryCount=1 and lastError set
    const failedInList = parsed.operations.find(o => o.id === failedOp.id);
    expect(failedInList).toBeDefined();
    expect(failedInList.retryCount).toBe(1);
    expect(failedInList.lastError).toEqual({ error: 'Network timeout', code: 500 });
  });
});

describe('execute_all with 412 stale-conflict handling', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-test-batch-412-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('marks batch op as stale-conflict on 412 and continues with remaining ops', async () => {
    const queue = getApprovalQueue();
    
    // Stage two ops: one will 412, one will succeed
    const op1 = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-1)',
      method: 'PATCH',
      payload: { subject: 'First' },
      etag: 'W/"stale"',
      beforeState: { subject: 'Original 1' },
      description: 'Update task 1'
    });
    
    const op2 = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-2)',
      method: 'PATCH',
      payload: { subject: 'Second' },
      etag: 'W/"fresh"',
      beforeState: { subject: 'Original 2' },
      description: 'Update task 2'
    });

    // Do NOT manually approve — execute_all will do it

    // Mock CRM: first call returns 412, second succeeds
    crm.request
      .mockResolvedValueOnce({ ok: false, status: 412, data: { message: 'Precondition Failed' } })
      .mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result = await callTool(server, 'execute_all');
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    
    expect(parsed.executed).toBe(1);
    expect(parsed.failed).toBe(1);

    // Verify op1 is stale-conflict
    const finalOp1 = queue.get(op1.id);
    expect(finalOp1.status).toBe('stale-conflict');

    // Verify op2 is executed (deleted from map)
    const finalOp2 = queue.get(op2.id);
    expect(finalOp2).toBeNull();

    // Verify audit for stale-conflict
    const auditEntries = JSON.parse((await callTool(server, 'query_audit_log', { limit: 10 })).content[0].text).entries;
    const staleEntry = auditEntries.find(e => e.operationId === op1.id && e.phase === 'stale-conflict');
    expect(staleEntry).toBeDefined();
    expect(staleEntry.result.status).toBe(412);
  });

  it('sends etag with batch PATCH/DELETE requests', async () => {
    const queue = getApprovalQueue();
    
    queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-1)',
      method: 'PATCH',
      payload: { subject: 'Updated' },
      etag: 'W/"captured-etag"',
      beforeState: { subject: 'Original' },
      description: 'Update task 1'
    });

    // Do NOT manually approve — execute_all will do it

    crm.request.mockResolvedValueOnce({ ok: true, status: 204, data: null });

    await callTool(server, 'execute_all');

    // Verify etag was passed to CRM request
    expect(crm.request).toHaveBeenCalledWith(
      'tasks(task-1)',
      expect.objectContaining({
        method: 'PATCH',
        body: { subject: 'Updated' },
        etag: 'W/"captured-etag"'
      })
    );
  });
});

describe('override handling with 404 abort', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-test-override-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('aborts override and returns error when record is deleted (404)', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(deleted-123)',
      method: 'PATCH',
      payload: { subject: 'Updated' },
      etag: 'W/"old-etag"',
      beforeState: { subject: 'Original' },
      description: 'Update deleted task'
    });
    op.status = 'stale-conflict';

    // Mock re-read returning 404
    crm.request.mockResolvedValueOnce({
      ok: false,
      status: 404,
      data: { message: 'Not Found' }
    });

    const result = await callTool(server, 'execute_operation', { id: op.id, override: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('deleted since staging');

    // Verify audit for override-abort-404
    const auditEntries = JSON.parse((await callTool(server, 'query_audit_log', { limit: 10 })).content[0].text).entries;
    const abortEntry = auditEntries.find(e => e.operationId === op.id && e.phase === 'override-abort-404');
    expect(abortEntry).toBeDefined();
  });

  it('notes override in audit when override is used', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(task-123)',
      method: 'PATCH',
      payload: { subject: 'Updated' },
      etag: 'W/"old-etag"',
      beforeState: { subject: 'Original' },
      description: 'Update task with override'
    });
    op.status = 'stale-conflict';

    // Mock re-read returning fresh etag, then successful PATCH
    crm.request
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { subject: 'Original', '@odata.etag': 'W/"fresh-etag"' }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        data: null
      });

    const result = await callTool(server, 'execute_operation', { id: op.id, override: true });
    expect(result.isError).toBeUndefined();

    // Verify audit notes override
    const auditEntries = JSON.parse((await callTool(server, 'query_audit_log', { limit: 10 })).content[0].text).entries;
    const execEntry = auditEntries.find(e => e.operationId === op.id && e.phase === 'executed');
    expect(execEntry).toBeDefined();
    expect(execEntry.override).toBe(true);
    expect(execEntry.note).toContain('override');
  });
});

describe('staging tools etag capture', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-test-staging-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('update_task rejects staging when etag is missing', async () => {
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { subject: 'Original', activityid: '12345678-1234-1234-1234-123456789abc' } // No @odata.etag
    });

    const result = await callTool(server, 'update_task', {
      taskId: '12345678-1234-1234-1234-123456789abc',
      subject: 'Updated'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
  });

  it('update_task rejects staging when read fails', async () => {
    crm.request.mockResolvedValueOnce({
      ok: false,
      status: 404,
      data: { message: 'Not Found' }
    });

    const result = await callTool(server, 'update_task', {
      taskId: '12345678-1234-1234-1234-123456789abc',
      subject: 'Updated'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to read task');
  });
});

// ─── Phase 2.4 Second Ring — B1: PATCH staging tools fail closed on missing etag ───
describe('Phase 2.4 B1: staging PATCH tools reject missing etag', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-b1-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('update_opportunity rejects staging when read returns no etag', async () => {
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { name: 'Test Opp', _parentaccountid_value: 'acct-1' } // no @odata.etag
    });

    const result = await callTool(server, 'update_opportunity', {
      opportunityId: '12345678-1234-1234-1234-123456789abc',
      estimatedRevenue: 50000
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    // Op must NOT be enqueued
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('update_milestone rejects staging when read returns no etag', async () => {
    const MILESTONE_GUID = '12345678-1234-1234-1234-123456789abc';
    crm.request.mockImplementation(async (path) => {
      if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'abc-123' } };
      if (path.startsWith('msp_engagementmilestones(')) {
        return { ok: true, status: 200, data: {
          msp_engagementmilestoneid: MILESTONE_GUID,
          msp_milestonenumber: '7-100',
          msp_name: 'Kickoff',
          _msp_opportunityid_value: 'opp-1',
          _ownerid_value: 'abc-123',
          msp_milestonedate: '2026-03-01'
          // no @odata.etag
        } };
      }
      return { ok: true, status: 200, data: {} };
    });

    const result = await callTool(server, 'update_milestone', {
      milestoneId: MILESTONE_GUID,
      milestoneDate: '2026-06-01'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('update_account rejects staging when read returns no etag', async () => {
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { accountid: '12345678-1234-1234-1234-123456789abc', name: 'Contoso' } // no etag
    });

    const result = await callTool(server, 'update_account', {
      accountId: '12345678-1234-1234-1234-123456789abc',
      fields: { description: 'new description' }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('update_contact rejects staging when read returns no etag', async () => {
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { contactid: '12345678-1234-1234-1234-123456789abc', fullname: 'John Doe' } // no etag
    });

    const result = await callTool(server, 'update_contact', {
      contactId: '12345678-1234-1234-1234-123456789abc',
      fields: { jobtitle: 'VP Engineering' }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('change_owner rejects staging when opportunity read returns no etag', async () => {
    const OPP_ID = '55555555-5555-5555-5555-555555555555';
    const OWNER_ID = '33333333-3333-3333-3333-333333333333';
    crm.request.mockImplementation(async (path) => {
      if (path.startsWith('opportunities(')) {
        return { ok: true, status: 200, data: { opportunityid: OPP_ID, name: 'Opp', _ownerid_value: 'old' } }; // no etag
      }
      return { ok: true, status: 200, data: {} };
    });

    const result = await callTool(server, 'change_owner', {
      entityType: 'opportunity',
      recordId: OPP_ID,
      newOwnerId: OWNER_ID
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('close_msx_opportunity rejects staging when read returns no etag', async () => {
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        name: 'MSX Opp',
        statecode: 0,
        statuscode: 1,
        msp_opportunitytype: '606820001', // consumption
        msp_engagementstatus: 861980000,
        _parentaccountid_value: 'acct-1'
        // no @odata.etag
      }
    });

    const result = await callTool(server, 'close_msx_opportunity', {
      opportunityId: '12345678-1234-1234-1234-123456789abc',
      closeReason: 'completed'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('reassign_opportunity rejects staging when the pre-read returns no etag', async () => {
    const OPP_ID = '11111111-1111-1111-1111-111111111111';
    const OWNER_ID = '22222222-2222-2222-2222-222222222222';
    crm.request.mockImplementation(async (path) => {
      if (path.startsWith('opportunities(')) {
        return { ok: true, status: 200, data: { name: 'Opp Without Etag', _ownerid_value: 'old-owner' } }; // no @odata.etag
      }
      return { ok: true, status: 200, data: { fullname: 'New Owner' } };
    });

    const result = await callTool(server, 'reassign_opportunity', {
      opportunityId: OPP_ID,
      newOwnerId: OWNER_ID
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });

  it('reactivate_msx_opportunity rejects staging when the pre-read returns no etag', async () => {
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        name: 'Closed Opp',
        statecode: 1,
        statuscode: 2,
        msp_opportunitytype: '606820001',
        msp_engagementstatus: 861980003,
        _parentaccountid_value: 'acct-1'
        // no @odata.etag
      }
    });

    const result = await callTool(server, 'reactivate_msx_opportunity', {
      opportunityId: '33333333-3333-3333-3333-333333333333'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no etag');
    expect(getApprovalQueue().listPending().length).toBe(0);
  });
});

// ─── Phase 2.4 Second Ring — B2: secondary PATCH concurrency protection ───
describe('Phase 2.4 B2: milestone cascade and close_task fallback carry etag', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-b2-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('close_msx_opportunity milestone cascade PATCH includes If-Match etag from list result', async () => {
    const OPP_ID = 'aaaabbbb-1111-2222-3333-444455556666';
    const MS_ID_1 = '11112222-aaaa-bbbb-cccc-ddddeeee0001';
    const MS_ETAG = 'W/"milestone-list-etag-001"';

    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'close_msx_opportunity',
      entitySet: `opportunities(${OPP_ID})`,
      method: 'PATCH',
      payload: {
        opportunityId: OPP_ID,
        opportunityPatch: { msp_engagementstatus: 861980003 },
        closeRecord: { 'opportunityid@odata.bind': `/opportunities(${OPP_ID})`, opportunitystatecode: 1, opportunitystatuscode: 861980021, statuscode: 1, statecode: 0 },
        completeMilestones: true
      },
      beforeState: { statecode: 'Active' },
      description: 'Close MSX opp test',
      etag: 'W/"opp-etag"'
    });
    queue.approve(op.id);

    crm.request
      // Step 1: Primary opp PATCH (etag-protected)
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
      // Step 2: opportunitycloses POST
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
      // Step 3: List open milestones
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [{ msp_engagementmilestoneid: MS_ID_1, '@odata.etag': MS_ETAG }] }
      })
      // Step 4: Milestone complete PATCH (should carry the milestone etag)
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
      // Step 5: Verify opp
      .mockResolvedValueOnce({ ok: true, status: 200, data: { opportunityid: OPP_ID, statecode: 1 } });

    await callTool(server, 'execute_operation', { id: op.id });

    // Assert the milestone PATCH was called with If-Match etag from the list result
    expect(crm.request).toHaveBeenCalledWith(
      `msp_engagementmilestones(${MS_ID_1})`,
      expect.objectContaining({
        method: 'PATCH',
        body: { msp_milestonestatus: 861980003 },
        etag: MS_ETAG
      })
    );
  });

  it('close_task third-fallback PATCH carries op.etag in execute_operation', async () => {
    const TASK_GUID = '12345678-1234-1234-1234-123456789abc';
    const TASK_ETAG = 'W/"close-task-etag-999"';

    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'close_task',
      entitySet: 'CloseTask',
      method: 'POST',
      payload: { TaskClose: { subject: 'Task Closed', 'activityid@odata.bind': `/tasks(${TASK_GUID})` }, Status: 5 },
      beforeState: { subject: 'Test Task', statuscode: 1 },
      etag: TASK_ETAG,
      description: `Close task ${TASK_GUID} with status 5`
    });
    op.fallbackEntitySet = `tasks(${TASK_GUID})/Microsoft.Dynamics.CRM.Close`;
    op.fallbackPayload = { Status: 5 };
    queue.approve(op.id);

    crm.request
      // Primary CloseTask POST fails
      .mockResolvedValueOnce({ ok: false, status: 400, data: { message: 'Action not available' } })
      // Bound Close POST fails
      .mockResolvedValueOnce({ ok: false, status: 400, data: { message: 'Bound close not available' } })
      // Third fallback: direct PATCH — should carry op.etag
      .mockResolvedValueOnce({ ok: true, status: 204, data: null });

    await callTool(server, 'execute_operation', { id: op.id });

    // Assert third fallback PATCH was called with op.etag
    expect(crm.request).toHaveBeenCalledWith(
      `tasks(${TASK_GUID})`,
      expect.objectContaining({
        method: 'PATCH',
        etag: TASK_ETAG
      })
    );
  });

  it('close_task third-fallback PATCH carries op.etag in execute_all', async () => {
    const TASK_GUID = '22345678-1234-1234-1234-123456789def';
    const TASK_ETAG = 'W/"batch-close-task-etag-888"';

    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'close_task',
      entitySet: 'CloseTask',
      method: 'POST',
      payload: { TaskClose: { subject: 'Batch Close', 'activityid@odata.bind': `/tasks(${TASK_GUID})` }, Status: 5 },
      beforeState: { subject: 'Batch Task', statuscode: 1 },
      etag: TASK_ETAG,
      description: `Close task ${TASK_GUID} with status 5`
    });
    op.fallbackEntitySet = `tasks(${TASK_GUID})/Microsoft.Dynamics.CRM.Close`;
    op.fallbackPayload = { Status: 5 };

    crm.request
      // Primary fails
      .mockResolvedValueOnce({ ok: false, status: 400, data: { message: 'Not available' } })
      // Bound close fails
      .mockResolvedValueOnce({ ok: false, status: 400, data: { message: 'Not available' } })
      // Third fallback PATCH — should carry op.etag
      .mockResolvedValueOnce({ ok: true, status: 204, data: null });

    await callTool(server, 'execute_all');

    expect(crm.request).toHaveBeenCalledWith(
      `tasks(${TASK_GUID})`,
      expect.objectContaining({
        method: 'PATCH',
        etag: TASK_ETAG
      })
    );
  });
});

// ─── Phase 2.4 Second Ring — B3: override reread-failed aborts instead of forcing ───
describe('Phase 2.4 B3: override reread-failed aborts with override-abort-reread-failed', () => {
  let server, crm, testDir;
  let savedUserData;

  beforeEach(() => {
    savedUserData = process.env.MSX_USER_DATA;
    testDir = mkdtempSync(join(tmpdir(), 'msx-iq-b3-'));
    process.env.MSX_USER_DATA = testDir;
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({});
    registerTools(server, crm);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (savedUserData !== undefined) process.env.MSX_USER_DATA = savedUserData;
    else delete process.env.MSX_USER_DATA;
  });

  it('aborts override and audits override-abort-reread-failed when reread returns 500', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(stale-task-001)',
      method: 'PATCH',
      payload: { subject: 'Override attempt' },
      etag: 'W/"stale-etag"',
      beforeState: { subject: 'Original' },
      description: 'Update stale task'
    });
    op.status = 'stale-conflict';

    // Reread returns 500 (server error)
    crm.request.mockResolvedValueOnce({
      ok: false,
      status: 500,
      data: { message: 'Internal Server Error' }
    });

    const result = await callTool(server, 'execute_operation', { id: op.id, override: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted');

    // No CRM write should have been issued (only the reread GET)
    expect(crm.request).toHaveBeenCalledTimes(1);

    // Audit record must capture override-abort-reread-failed phase
    const auditEntries = JSON.parse(
      (await callTool(server, 'query_audit_log', { limit: 10 })).content[0].text
    ).entries;
    const abortEntry = auditEntries.find(
      e => e.operationId === op.id && e.phase === 'override-abort-reread-failed'
    );
    expect(abortEntry).toBeDefined();
  });

  it('aborts override and audits when reread succeeds but returns no etag', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(stale-task-002)',
      method: 'PATCH',
      payload: { subject: 'Override no-etag' },
      etag: 'W/"stale-etag-2"',
      beforeState: { subject: 'Original 2' },
      description: 'Update stale task 2'
    });
    op.status = 'stale-conflict';

    // Reread returns 200 but no @odata.etag in response body
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { subject: 'Original 2' } // missing @odata.etag
    });

    const result = await callTool(server, 'execute_operation', { id: op.id, override: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted');

    // No write should have been issued
    expect(crm.request).toHaveBeenCalledTimes(1);

    const auditEntries = JSON.parse(
      (await callTool(server, 'query_audit_log', { limit: 10 })).content[0].text
    ).entries;
    const abortEntry = auditEntries.find(
      e => e.operationId === op.id && e.phase === 'override-abort-reread-failed'
    );
    expect(abortEntry).toBeDefined();
  });

  it('applies override with fresh etag when reread succeeds (not a blind force)', async () => {
    const queue = getApprovalQueue();
    const op = queue.stage({
      type: 'update_task',
      entitySet: 'tasks(stale-task-003)',
      method: 'PATCH',
      payload: { subject: 'Override fresh' },
      etag: 'W/"old-etag"',
      beforeState: { subject: 'Original 3' },
      description: 'Update stale task 3'
    });
    op.status = 'stale-conflict';

    const FRESH_ETAG = 'W/"fresh-etag-from-reread"';

    crm.request
      // Reread returns fresh etag
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { subject: 'Original 3', '@odata.etag': FRESH_ETAG }
      })
      // PATCH with fresh etag
      .mockResolvedValueOnce({ ok: true, status: 204, data: null });

    const result = await callTool(server, 'execute_operation', { id: op.id, override: true });
    expect(result.isError).toBeUndefined();

    // Assert PATCH was called with the FRESH etag (not '*')
    expect(crm.request).toHaveBeenCalledWith(
      'tasks(stale-task-003)',
      expect.objectContaining({
        method: 'PATCH',
        etag: FRESH_ETAG
      })
    );

    // Confirm '*' was never used
    const allCalls = crm.request.mock.calls;
    const hadBlindForce = allCalls.some(([, opts]) => opts?.etag === '*');
    expect(hadBlindForce).toBe(false);
  });
});

// ── Geography filtering tests (Round 3 Wave 3) ──
describe('geography filtering', () => {
  let server, crm;
  
  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-123' } }
    });
    registerTools(server, crm);
  });

  it('resolves accounts by territoryCode', async () => {
    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { accountid: 'acc-1', name: 'Account A', territoryid: { name: 'SE.ES.EC.OCI.01.MG.02' } },
              { accountid: 'acc-2', name: 'Account B', territoryid: { name: 'SE.ES.EC.OCI.01.MG.02' } }
            ]
          }
        };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_territory_accounts', {
      territoryCode: 'SE.ES.EC.OCI.01.MG.02'
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2);
    expect(data.accounts[0].name).toBe('Account A');
  });

  it('resolves accounts by country with alias (España → Spain)', async () => {
    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { accountid: 'acc-1', name: 'Spain Account', address1_country: 'Spain' }
            ]
          }
        };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_territory_accounts', {
      country: 'España'
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
  });

  it('resolves accounts by segment (FormattedValue match)', async () => {
    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { 
                accountid: 'acc-1', 
                name: 'Enterprise A',
                msp_endcustomersegmentcode: 123,
                'msp_endcustomersegmentcode@OData.Community.Display.V1.FormattedValue': 'Upper Majors Commercial'
              },
              {
                accountid: 'acc-2',
                name: 'Enterprise B',
                msp_endcustomersegmentcode: 456,
                'msp_endcustomersegmentcode@OData.Community.Display.V1.FormattedValue': 'Corporate'
              }
            ]
          }
        };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_territory_accounts', {
      segment: 'Upper Majors Commercial'
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.accounts[0].name).toBe('Enterprise A');
  });

  it('signals truncation when account count exceeds limit', async () => {
    // Return 51 accounts when limit is 50
    const accounts = Array.from({ length: 51 }, (_, i) => ({
      accountid: `acc-${i}`,
      name: `Account ${i}`
    }));

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: accounts } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_territory_accounts', {
      territoryCode: 'LARGE.TERRITORY',
      limit: 50
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.truncated).toBe(true);
    expect(data.totalMatched).toBeGreaterThan(50);
    expect(data.count).toBe(50); // Limited to cap
  });

  it('uses real $count for server-side paths (territoryCode/country/segment by code)', async () => {
    let countRequestMade = false;
    crm.request.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts' && opts?.query?.$count === true) {
        countRequestMade = true;
        return { ok: true, status: 200, data: { '@odata.count': 523 } }; // Exact total
      }
      return { ok: true, status: 200, data: {} };
    });

    const accounts = Array.from({ length: 51 }, (_, i) => ({
      accountid: `acc-${i}`,
      name: `Account ${i}`,
      _territoryid_value: 'terr-1'
    }));

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: accounts } }; // Capped at 51
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_territory_accounts', {
      territoryCode: 'SE.ES.EC.OCI.01.MG.02',
      limit: 50
    });

    const data = JSON.parse(result.content[0].text);
    expect(countRequestMade).toBe(true); // Assert $count query was made
    expect(data.totalMatched).toBe(523); // Exact count from $count, NOT "51" or "201"
    expect(data.truncated).toBe(true); // 50 shown < 523 total
    expect(data.count).toBe(50);
  });
});

describe('list_territory_opportunities', () => {
  let server, crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-123' } }
    });
    registerTools(server, crm);
  });

  it('$count query uses EXACT SAME filter as list query', async () => {
    let countFilter = null;
    let listFilter = null;

    crm.request.mockImplementation(async (entity, opts) => {
      if (entity === 'opportunities' && opts?.query?.$count === true) {
        countFilter = opts.query.$filter;
        return { ok: true, status: 200, data: { '@odata.count': 66 } };
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        listFilter = opts.query?.$filter;
        return { ok: true, status: 200, data: { value: [] } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    await callTool(server, 'list_territory_opportunities', { country: 'Spain', status: 'won' });

    // Assert $count filter EXACTLY matches list filter (same statecode)
    expect(countFilter).toBeTruthy();
    expect(listFilter).toBeTruthy();
    expect(countFilter).toBe(listFilter); // EXACT SAME filter string
    expect(countFilter).toContain('statecode eq 1'); // Won
  });

  it('guards against $count=0 when rows exist (uses rows as floor)', async () => {
    crm.request.mockImplementation(async (entity, opts) => {
      if (entity === 'opportunities' && opts?.query?.$count === true) {
        return { ok: true, status: 200, data: { '@odata.count': 0 } }; // $count returns 0 (wrong)
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { opportunityid: 'opp-1', name: 'Opp 1', estimatedvalue: 100 },
              { opportunityid: 'opp-2', name: 'Opp 2', estimatedvalue: 200 }
            ]
          }
        };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_territory_opportunities', { country: 'Spain' });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2); // 2 rows returned
    expect(data.totalOpportunities).toBe(2); // Guard: use rows.length as floor, NOT 0
    expect(data._countNote).toBeTruthy(); // Flag the discrepancy
  });
});

describe('list_my_territory_opportunities', () => {
  let server, crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-123' } }
    });
    registerTools(server, crm);
  });

  it('returns territory opportunities regardless of owner', async () => {
    let savedQueryCalled = false;
    crm.request.mockImplementation(async (entity, opts) => {
      if (entity === 'savedqueries') {
        savedQueryCalled = true;
        return {
          ok: true,
          status: 200,
          data: { value: [{ savedqueryid: 'sq-123' }] }
        };
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { accountid: 'acc-1', name: 'Team Account A' },
              { accountid: 'acc-2', name: 'Team Account B' }
            ]
          }
        };
      }
      if (entity === 'opportunities') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              {
                opportunityid: 'opp-1',
                name: 'Opp A',
                _ownerid_value: 'other-user',
                '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Team Account A',
                estimatedvalue: 100000,
                msp_opportunitytype: 606820000
              },
              {
                opportunityid: 'opp-2',
                name: 'Opp B',
                _ownerid_value: 'user-123',
                '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Team Account B',
                estimatedvalue: 200000,
                msp_opportunitytype: 606820001
              }
            ]
          }
        };
      }
      if (entity === 'systemusers') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { systemuserid: 'other-user', fullname: 'Other User' },
              { systemuserid: 'user-123', fullname: 'Current User' }
            ]
          }
        };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_my_territory_opportunities', {});

    expect(savedQueryCalled).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2);
    expect(data.opportunities[0].owner).toBe('Other User');
    expect(data.opportunities[1].owner).toBe('Current User');
  });

  it('filters by oppType = billed', async () => {
    crm.request.mockImplementation(async (entity) => {
      if (entity === 'savedqueries') {
        return { ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-123' }] } };
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        // Filter applied in OData query
        const filter = opts.query?.$filter || '';
        if (filter.includes('606820000')) {
          return {
            ok: true,
            status: 200,
            data: {
              value: [
                { opportunityid: 'opp-b', name: 'Billed Opp', msp_opportunitytype: 606820000, _ownerid_value: 'u1' }
              ]
            }
          };
        }
        return { ok: true, status: 200, data: { value: [] } };
      }
      if (entity === 'systemusers') {
        return { ok: true, status: 200, data: { value: [{ systemuserid: 'u1', fullname: 'User 1' }] } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_my_territory_opportunities', {
      oppType: 'billed'
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.opportunities[0].name).toBe('Billed Opp');
  });

  it('applies billed FY window upper-bound filter client-side', async () => {
    crm.request.mockImplementation(async (entity) => {
      if (entity === 'savedqueries') {
        return { ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-123' }] } };
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              {
                opportunityid: 'opp-in',
                name: 'In FY27 Window',
                msp_opportunitytype: 606820000,
                msp_estcompletiondate: '2026-12-01', // Within FY27 (Jul 2026 - Jun 2027)
                _ownerid_value: 'u1'
              },
              {
                opportunityid: 'opp-out',
                name: 'Outside FY27 Window',
                msp_opportunitytype: 606820000,
                msp_estcompletiondate: '2027-08-01', // Outside FY27 (after Jun 30 2027)
                _ownerid_value: 'u1'
              }
            ]
          }
        };
      }
      if (entity === 'systemusers') {
        return { ok: true, status: 200, data: { value: [{ systemuserid: 'u1', fullname: 'User 1' }] } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_my_territory_opportunities', {
      oppType: 'billed',
      dateRange: 'FY27-FY'
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.opportunities[0].name).toBe('In FY27 Window');
  });

  it('builds billed filter with QUOTED string (msp_opportunitytype eq "606820000")', async () => {
    crm.request.mockImplementation(async (entity) => {
      if (entity === 'savedqueries') {
        return { ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-123' }] } };
      }
      return { ok: true, status: 200, data: {} };
    });

    let capturedFilter = null;
    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        capturedFilter = opts.query?.$filter || '';
        return { ok: true, status: 200, data: { value: [] } };
      }
      if (entity === 'systemusers') {
        return { ok: true, status: 200, data: { value: [] } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    await callTool(server, 'list_my_territory_opportunities', { oppType: 'billed' });

    // Assert the filter contains the QUOTED string (Edm.String field, not Edm.Int32)
    expect(capturedFilter).toContain("msp_opportunitytype eq '606820000'");
    expect(capturedFilter).not.toContain("msp_opportunitytype eq 606820000"); // unquoted is wrong
  });

  it('builds consumption filter with QUOTED string (msp_opportunitytype eq "606820001")', async () => {
    crm.request.mockImplementation(async (entity) => {
      if (entity === 'savedqueries') {
        return { ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-123' }] } };
      }
      return { ok: true, status: 200, data: {} };
    });

    let capturedFilter = null;
    crm.requestAllPages.mockImplementation(async (entity, opts) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        capturedFilter = opts.query?.$filter || '';
        return { ok: true, status: 200, data: { value: [] } };
      }
      if (entity === 'systemusers') {
        return { ok: true, status: 200, data: { value: [] } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    await callTool(server, 'list_my_territory_opportunities', { oppType: 'consumption' });

    // Assert the filter contains the QUOTED string (Edm.String field, not Edm.Int32)
    expect(capturedFilter).toContain("msp_opportunitytype eq '606820001'");
    expect(capturedFilter).not.toContain("msp_opportunitytype eq 606820001"); // unquoted is wrong
  });

  it('surfaces error when account query fails (not silent false zero)', async () => {
    crm.request.mockImplementation(async (entity) => {
      if (entity === 'savedqueries') {
        return { ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-123' }] } };
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity) => {
      if (entity === 'accounts') {
        return { ok: false, status: 500, data: { message: 'Internal Server Error' } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_my_territory_opportunities', {});

    expect(result.isError).toBe(true);
    const errorText = result.content[0].text;
    expect(errorText).toContain('Territory accounts query failed');
    expect(errorText).toContain('500');
    expect(errorText).toContain('Internal Server Error');
  });

  it('surfaces error when opportunity query fails (not silent false zero)', async () => {
    crm.request.mockImplementation(async (entity) => {
      if (entity === 'savedqueries') {
        return { ok: true, status: 200, data: { value: [{ savedqueryid: 'sq-123' }] } };
      }
      return { ok: true, status: 200, data: {} };
    });

    crm.requestAllPages.mockImplementation(async (entity) => {
      if (entity === 'accounts') {
        return { ok: true, status: 200, data: { value: [{ accountid: 'acc-1', name: 'Account' }] } };
      }
      if (entity === 'opportunities') {
        return { ok: false, status: 400, data: { message: 'Bad Request: incompatible types Edm.String and Edm.Int32' } };
      }
      return { ok: true, status: 200, data: { value: [] } };
    });

    const result = await callTool(server, 'list_my_territory_opportunities', { oppType: 'billed' });

    expect(result.isError).toBe(true);
    const errorText = result.content[0].text;
    expect(errorText).toContain('Territory opportunity query failed');
    expect(errorText).toContain('400');
    expect(errorText).toContain('incompatible types');
  });
});
