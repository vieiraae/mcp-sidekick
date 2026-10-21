import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue } from '../approval-queue.js';

// Mock CRM client
function mockCrmClient(responses = {}) {
  return {
    request: vi.fn(async (path, opts) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 200, data: {} };
    }),
    requestAllPages: vi.fn(async (path, opts) => {
      if (responses[path]) return responses[path];
      return { ok: true, status: 200, data: { value: [] } };
    }),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com')
  };
}

// Helper: generate a valid mock GUID
function mockGuid() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const segment = (len) => Array.from({ length: len }, hex).join('');
  return `${segment(8)}-${segment(4)}-${segment(4)}-${segment(4)}-${segment(12)}`;
}

// Helper: call a registered tool
async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

// Helper: build a mock opportunity
function makeOpp(
  name,
  opportunity_type = 606820000,
  acr = 1000,
  estimated_close = '2026-06-30',
  account_id = 'acct-1',
  account_name = 'Contoso'
) {
  return {
    opportunityid: 'opp-' + Math.random().toString(36).slice(2),
    name,
    estimatedclosedate: estimated_close,
    msp_estcompletiondate: estimated_close,
    msp_opportunitytype: opportunity_type,
    msp_consumptionconsumedrecurring: acr,
    _ownerid_value: 'user-1',
    _parentaccountid_value: account_id,
    'msp_opportunitytype@OData.Community.Display.V1.FormattedValue':
      opportunity_type === 606820000 ? 'Billed' : 'Consumption',
    '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': account_name,
    msp_opportunitynumber: 'OPP-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    msp_activesalesstage: 'Manage & Optimize',
    msp_salesplay: 'Azure Migration'
  };
}

// Helper: build a mock milestone
function makeMilestone(
  name,
  monthly_use = 500,
  milestone_date = '2026-06-01',
  opp_id = 'opp-1'
) {
  return {
    msp_engagementmilestoneid: 'ms-' + Math.random().toString(36).slice(2),
    msp_milestonenumber: 'MS-' + Math.random().toString(36).slice(2, 5).toUpperCase(),
    msp_name: name,
    msp_monthlyuse: monthly_use,
    msp_milestonedate: milestone_date,
    _msp_opportunityid_value: opp_id,
    _msp_workloadlkid_value: 'workload-1',
    'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
    '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Test Opp',
    '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure',
    msp_milestonecategory: 861980002
  };
}

describe('MCEM Business Logic — Billed vs Consumption Opportunities', () => {
  let server;
  let crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-1', BusinessUnitId: 'bu-1' } }
    });
    registerTools(server, crm);
  });

  describe('Opportunity Classification', () => {
    it('classifies opportunity type 606820000 as "billed"', async () => {
      const billedOpp = makeOpp('Billed Opp', 606820000, 5000);
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [billedOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities).toHaveLength(1);
      expect(parsed.opportunities[0].msp_opportunitytype).toBe(606820000);
    });

    it('classifies opportunity type 606820001 as "consumption"', async () => {
      const consumptionOpp = makeOpp('Consumption Opp', 606820001, 3000);
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [consumptionOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities).toHaveLength(1);
      expect(parsed.opportunities[0].msp_opportunitytype).toBe(606820001);
    });
  });

  describe('get_my_active_opportunities — Consumption Opps with Milestones', () => {
    it('returns consumption opps with msp_opportunitytype field', async () => {
      const consumptionOpp = makeOpp('Consume ACR', 606820001, 0); // no direct ACR
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [consumptionOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities[0]).toHaveProperty('msp_opportunitytype');
      expect(parsed.opportunities[0].msp_opportunitytype).toBe(606820001);
    });

    it('returns billed opps with msp_consumptionconsumedrecurring field intact', async () => {
      const billedOpp = makeOpp('Billed ACR', 606820000, 5500);
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [billedOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities[0].msp_consumptionconsumedrecurring).toBe(5500);
    });

    it('handles mixed billed and consumption opps together', async () => {
      const billedOpp = makeOpp('Billed', 606820000, 5000, '2026-06-30', 'acct-1', 'Contoso');
      const consumptionOpp = makeOpp('Consumption', 606820001, 3000, '2026-07-15', 'acct-1', 'Contoso');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [billedOpp, consumptionOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities).toHaveLength(2);

      const opp1 = parsed.opportunities.find(o => o.msp_opportunitytype === 606820000);
      const opp2 = parsed.opportunities.find(o => o.msp_opportunitytype === 606820001);

      expect(opp1).toBeDefined();
      expect(opp1.msp_consumptionconsumedrecurring).toBe(5000);
      expect(opp2).toBeDefined();
      expect(opp2.msp_consumptionconsumedrecurring).toBe(3000);
    });
  });

  describe('Milestone Data Shape for Consumption Opps', () => {
    it('returns milestones with msp_monthlyuse for ACR computation', async () => {
      const ms1 = makeMilestone('Phase 1', 1000, '2026-06-01', '11111111-1111-1111-1111-111111111111');
      const ms2 = makeMilestone('Phase 2', 1500, '2026-07-01', '11111111-1111-1111-1111-111111111111');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms1, ms2] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones).toHaveLength(2);
      expect(parsed.milestones[0].msp_monthlyuse).toBe(1000);
      expect(parsed.milestones[1].msp_monthlyuse).toBe(1500);
    });

    it('returns milestones with msp_milestonedate for date-range filtering', async () => {
      const ms1 = makeMilestone('Early MS', 500, '2026-05-01', '11111111-1111-1111-1111-111111111111');
      const ms2 = makeMilestone('Late MS', 500, '2026-08-01', '11111111-1111-1111-1111-111111111111');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms1, ms2] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.milestones[0].msp_milestonedate).toBe('2026-05-01');
      expect(parsed.milestones[1].msp_milestonedate).toBe('2026-08-01');
    });

    it('returns milestones with complete required fields', async () => {
      const ms = makeMilestone('Complete MS', 2000, '2026-06-15', '11111111-1111-1111-1111-111111111111');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const milestone = parsed.milestones[0];

      expect(milestone).toHaveProperty('msp_engagementmilestoneid');
      expect(milestone).toHaveProperty('msp_name');
      expect(milestone).toHaveProperty('msp_monthlyuse');
      expect(milestone).toHaveProperty('msp_milestonedate');
      expect(milestone).toHaveProperty('_msp_opportunityid_value');
    });

    it('returns empty milestones array for opp with no milestones', async () => {
      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
      expect(parsed.milestones).toEqual([]);
    });
  });

  describe('Fiscal Period Filtering for Consumption Opps', () => {
    it('filters milestones by msp_milestonedate when dateRange is provided', async () => {
      const ms1 = makeMilestone('Q3 MS', 1000, '2026-01-15', '11111111-1111-1111-1111-111111111111');
      const ms2 = makeMilestone('Q4 MS', 1000, '2026-04-15', '11111111-1111-1111-1111-111111111111');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms1, ms2] }
      });

      // When calling with dateRange, CRM client is called with the filtered date range
      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111'],
        dateRange: 'Q3'
      });

      expect(result.isError).toBeUndefined();
      // Verify that requestAllPages was called with dateRange in the filter
      expect(crm.requestAllPages).toHaveBeenCalledWith(
        'msp_engagementmilestones',
        expect.objectContaining({
          query: expect.objectContaining({
            $filter: expect.stringContaining('msp_milestonedate')
          })
        })
      );
    });
  });

  describe('Milestone ACR Computation (Sum of msp_monthlyuse)', () => {
    it('computes total ACR by summing all milestone msp_monthlyuse values', async () => {
      const ms1 = makeMilestone('MS-A', 500, '2026-01-01', '11111111-1111-1111-1111-111111111111');
      const ms2 = makeMilestone('MS-B', 750, '2026-02-01', '11111111-1111-1111-1111-111111111111');
      const ms3 = makeMilestone('MS-C', 250, '2026-03-01', '11111111-1111-1111-1111-111111111111');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms1, ms2, ms3] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const totalAcr = parsed.milestones.reduce((sum, m) => sum + (m.msp_monthlyuse || 0), 0);
      expect(totalAcr).toBe(1500); // 500 + 750 + 250
    });

    it('handles zero msp_monthlyuse in milestones', async () => {
      const ms1 = makeMilestone('MS-Zero', 0, '2026-01-01', '11111111-1111-1111-1111-111111111111');
      const ms2 = makeMilestone('MS-Valid', 1000, '2026-02-01', '11111111-1111-1111-1111-111111111111');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms1, ms2] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const totalAcr = parsed.milestones.reduce((sum, m) => sum + (m.msp_monthlyuse || 0), 0);
      expect(totalAcr).toBe(1000);
    });

    it('handles milestones with undefined msp_monthlyuse', async () => {
      const ms = makeMilestone('MS-Undefined', undefined, '2026-01-01', '11111111-1111-1111-1111-111111111111');
      // Manually remove msp_monthlyuse to ensure it's undefined
      delete ms.msp_monthlyuse;

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [ms] }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const totalAcr = parsed.milestones.reduce((sum, m) => sum + (m.msp_monthlyuse || 0), 0);
      expect(totalAcr).toBe(0);
    });
  });

  describe('Multiple Opportunities by Account', () => {
    it('correctly combines ACR from multiple consumption opps on same account', async () => {
      const opp1 = makeOpp('Consumption 1', 606820001, 0, '2026-06-30', 'acct-1', 'Contoso');
      const opp2 = makeOpp('Consumption 2', 606820001, 0, '2026-07-15', 'acct-1', 'Contoso');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [opp1, opp2] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities).toHaveLength(2);
      expect(parsed.opportunities.every(o => o._parentaccountid_value === 'acct-1')).toBe(true);
    });

    it('correctly combines billed and consumption opps on same account', async () => {
      const billed = makeOpp('Billed', 606820000, 5000, '2026-06-30', 'acct-1', 'Contoso');
      const consumption = makeOpp('Consumption', 606820001, 3000, '2026-07-15', 'acct-1', 'Contoso');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [billed, consumption] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities).toHaveLength(2);

      const billedOpp = parsed.opportunities.find(o => o.msp_opportunitytype === 606820000);
      const consumptionOpp = parsed.opportunities.find(o => o.msp_opportunitytype === 606820001);

      expect(billedOpp.msp_consumptionconsumedrecurring).toBe(5000);
      expect(consumptionOpp.msp_consumptionconsumedrecurring).toBe(3000);
    });
  });

  describe('ACR Summarization by Type', () => {
    it('distinguishes billed revenue from consumption ACR in summary', async () => {
      const billedOpp1 = makeOpp('B1', 606820000, 2000, '2026-06-30', 'acct-1', 'Contoso');
      const billedOpp2 = makeOpp('B2', 606820000, 3000, '2026-06-30', 'acct-1', 'Contoso');
      const consumptionOpp = makeOpp('C1', 606820001, 4000, '2026-06-30', 'acct-1', 'Contoso');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [billedOpp1, billedOpp2, consumptionOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);

      // Verify the response contains billed and consumption opps
      const billed = parsed.opportunities.filter(o => o.msp_opportunitytype === 606820000);
      const consumption = parsed.opportunities.filter(o => o.msp_opportunitytype === 606820001);

      expect(billed).toHaveLength(2);
      expect(consumption).toHaveLength(1);

      const billedTotal = billed.reduce((sum, o) => sum + (o.msp_consumptionconsumedrecurring || 0), 0);
      const consumptionTotal = consumption.reduce((sum, o) => sum + (o.msp_consumptionconsumedrecurring || 0), 0);

      expect(billedTotal).toBe(5000);
      expect(consumptionTotal).toBe(4000);
    });
  });

  describe('Backward Compatibility', () => {
    it('still works with opportunities missing msp_opportunitytype field', async () => {
      const opp = makeOpp('Legacy Opp', 606820000, 5000);
      delete opp.msp_opportunitytype; // Simulate old record without type

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [opp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities).toHaveLength(1);
      // Should still return the opportunity even without type
      expect(parsed.opportunities[0].msp_consumptionconsumedrecurring).toBe(5000);
    });

    it('preserves msp_consumptionconsumedrecurring field for all opportunity types', async () => {
      const billedOpp = makeOpp('Billed', 606820000, 5500);
      const consumptionOpp = makeOpp('Consumption', 606820001, 3300);

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [billedOpp, consumptionOpp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);

      for (const opp of parsed.opportunities) {
        expect(opp).toHaveProperty('msp_consumptionconsumedrecurring');
      }
    });
  });

  describe('Edge Cases', () => {
    it('handles opportunity with null ACR value', async () => {
      const opp = makeOpp('Null ACR', 606820000, null);

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [opp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities[0]).toHaveProperty('msp_consumptionconsumedrecurring');
    });

    it('handles opportunity with undefined ACR value', async () => {
      const opp = makeOpp('Undefined ACR', 606820001, undefined);

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [opp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.opportunities[0]).toHaveProperty('msp_consumptionconsumedrecurring');
    });

    it('handles consumption opportunity with string ACR value (should be numeric)', async () => {
      const opp = makeOpp('String ACR', 606820001, '1000');

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [opp] }
      });

      const result = await callTool(server, 'get_my_active_opportunities', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Should return regardless of type (CRM may return as string in some cases)
      expect(parsed.opportunities).toHaveLength(1);
    });

    it('handles large number of milestones (100+)', async () => {
      const milestones = [];
      for (let i = 0; i < 120; i++) {
        const month = (i % 12) + 1;
        const monthStr = month.toString().padStart(2, '0');
        milestones.push(makeMilestone(`MS-${i}`, 100, `2026-${monthStr}-01`, '11111111-1111-1111-1111-111111111111'));
      }

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: milestones }
      });

      const result = await callTool(server, 'get_milestones', {
        opportunityIds: ['11111111-1111-1111-1111-111111111111']
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(120);
    });
  });

  describe('Field Selection for get_my_active_opportunities', () => {
    it('requests required fields including msp_opportunitytype', async () => {
      const opp = makeOpp('Test Opp', 606820001, 2000);

      crm.requestAllPages.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { value: [opp] }
      });

      await callTool(server, 'get_my_active_opportunities', {});

      // Verify requestAllPages was called with proper $select including msp_opportunitytype
      expect(crm.requestAllPages).toHaveBeenCalledWith(
        'opportunities',
        expect.objectContaining({
          query: expect.objectContaining({
            $select: expect.stringContaining('msp_opportunitytype')
          })
        })
      );
    });
  });

  describe('MCEM Update Stage backend support', () => {
    const OPP_ID = '11111111-1111-1111-1111-111111111111';
    const BPF_ID = '22222222-2222-2222-2222-222222222222';
    const STAGE_1 = '60b911e7-32fb-4490-98c7-a9d3e06a6492';
    const STAGE_2 = 'f5a927f6-03c6-45fc-a8af-70adc140d470';
    const STAGE_3 = '937a8569-d7e5-41b4-a4a3-2f74cec5a6d9';
    const STAGE_4 = '5031ed91-b1ec-400b-a4a3-05b6e85c5c83';
    const MCEM_PROCESS_ID = '5cbd275e-a16c-4e49-9910-7aa1aab15997';
    const ACCOUNT_ID = '99999999-9999-9999-9999-999999999999';
    const CONTACT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const OTHER_CONTACT_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const COMPETITOR_ID = 'cccccccc-dddd-eeee-ffff-000000000000';

    function mockStageCrm({ stageId = STAGE_1, traversedPath = null, milestones = [], opportunityOverrides = {} } = {}) {
      let activeStageId = stageId;
      let bpfTraversedPath = traversedPath || {
        [STAGE_1]: STAGE_1,
        [STAGE_2]: `${STAGE_1},${STAGE_2}`,
        [STAGE_3]: `${STAGE_1},${STAGE_2},${STAGE_3}`,
        [STAGE_4]: `${STAGE_1},${STAGE_2},${STAGE_3},${STAGE_4}`
      }[stageId] || STAGE_1;
      let opportunity = {
        opportunityid: OPP_ID,
        name: 'MCEM Opp',
        msp_activesalesstage: 'Listen & Consult',
        _parentaccountid_value: ACCOUNT_ID,
        msp_solutionarea: 861980005,
        msp_salesplay: 861980095,
        description: 'Customer need',
        _parentcontactid_value: 'contact-1',
        _msp_primarycompetitor_value: 'competitor-1',
        msp_competethreatlevel: 861980002,
        ...opportunityOverrides
      };
      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'user-1', BusinessUnitId: 'bu-1' } };
        if (path === `opportunities(${OPP_ID})` && opts.method === 'PATCH') {
          const hasParentContactBind = Object.prototype.hasOwnProperty.call(opts.body || {}, 'parentcontactid@odata.bind');
          const hasPrimaryCompetitorBind = Object.prototype.hasOwnProperty.call(opts.body || {}, 'msp_PrimaryCompetitor@odata.bind');
          opportunity = {
            ...opportunity,
            ...opts.body,
            _parentcontactid_value: hasParentContactBind
              ? (opts.body['parentcontactid@odata.bind'] ? opts.body['parentcontactid@odata.bind'].match(/\(([^)]+)\)/)?.[1] : null)
              : opportunity._parentcontactid_value,
            _msp_primarycompetitor_value: hasPrimaryCompetitorBind
              ? (opts.body['msp_PrimaryCompetitor@odata.bind'] ? opts.body['msp_PrimaryCompetitor@odata.bind'].match(/\(([^)]+)\)/)?.[1] : null)
              : opportunity._msp_primarycompetitor_value
          };
          return { ok: true, status: 204, data: {} };
        }
        if (path === `opportunities(${OPP_ID})`) {
          return {
            ok: true,
            status: 200,
            data: opportunity
          };
        }
        const contactMatch = path.match(/^contacts\(([^)]+)\)$/);
        if (contactMatch) {
          const id = contactMatch[1].toLowerCase();
          if (id === CONTACT_ID) {
            return { ok: true, status: 200, data: { contactid: CONTACT_ID, fullname: 'Adele Vance', _parentcustomerid_value: ACCOUNT_ID } };
          }
          if (id === OTHER_CONTACT_ID) {
            return { ok: true, status: 200, data: { contactid: OTHER_CONTACT_ID, fullname: 'Outside Contact', _parentcustomerid_value: '88888888-8888-8888-8888-888888888888' } };
          }
          return { ok: false, status: 404, data: { message: 'contact not found' } };
        }
        const competitorMatch = path.match(/^competitors\(([^)]+)\)$/);
        if (competitorMatch) {
          const id = competitorMatch[1].toLowerCase();
          if (id === COMPETITOR_ID) {
            return { ok: true, status: 200, data: { competitorid: COMPETITOR_ID, name: 'Fabrikam Cloud' } };
          }
          return { ok: false, status: 404, data: { message: 'competitor not found' } };
        }
        if (path.includes("Attributes(LogicalName='msp_competethreatlevel')")) {
          return {
            ok: true,
            status: 200,
            data: {
              OptionSet: {
                Options: [
                  { Value: 861980001, Label: { UserLocalizedLabel: { Label: 'Low' } } },
                  { Value: 861980002, Label: { UserLocalizedLabel: { Label: 'Medium' } } },
                  { Value: 861980003, Label: { UserLocalizedLabel: { Label: 'High' } } }
                ]
              }
            }
          };
        }
        if (path === `msp_mcemprocesses(${BPF_ID})` && opts.method === 'PATCH') {
          activeStageId = opts.body?.['activestageid@odata.bind']?.match(/\(([^)]+)\)/)?.[1] || activeStageId;
          bpfTraversedPath = opts.body?.traversedpath || bpfTraversedPath;
          return { ok: true, status: 204, data: {} };
        }
        if (path === `msp_mcemprocesses(${BPF_ID})`) {
          // Direct GET of the BPF instance record — real CRM serves this; used by the
          // stage transition's fresh-etag re-read and post-move verify.
          return {
            ok: true,
            status: 200,
            data: {
              businessprocessflowinstanceid: BPF_ID,
              _activestageid_value: activeStageId,
              traversedpath: bpfTraversedPath,
              '@odata.etag': 'W/"bpf-etag"'
            }
          };
        }
        return { ok: true, status: 200, data: {} };
      });
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet === 'msp_mcemprocesses') {
          return {
            ok: true,
            status: 200,
            data: { value: [{ businessprocessflowinstanceid: BPF_ID, _activestageid_value: activeStageId, traversedpath: bpfTraversedPath }] }
          };
        }
        if (entitySet === 'msp_engagementmilestones') {
          return { ok: true, status: 200, data: { value: milestones } };
        }
        if (entitySet === 'contacts') {
          return {
            ok: true,
            status: 200,
            data: {
              value: [
                { contactid: CONTACT_ID, fullname: 'Adele Vance', emailaddress1: 'adele@example.com', jobtitle: 'CIO', _parentcustomerid_value: ACCOUNT_ID }
              ]
            }
          };
        }
        if (entitySet === 'competitors') {
          return {
            ok: true,
            status: 200,
            data: { value: [{ competitorid: COMPETITOR_ID, name: 'Fabrikam Cloud' }] }
          };
        }
        return { ok: true, status: 200, data: { value: [] } };
      });
    }

    it('preflights sequential moves without surfacing BPF checklist fields', async () => {
      mockStageCrm({ stageId: STAGE_1 });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Empower & Achieve'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('ready');
      expect(parsed.moves.map(m => `${m.from.number}->${m.to.number}`)).toEqual(['1->2', '2->3']);
      expect(parsed.blockers).toEqual([]);
      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain('msp_qualifiedopportunity');
      expect(serialized).not.toContain('msp_customerprioritiesidentified');
    });

    it('returns actionable field metadata for Inspire to Empower blockers', async () => {
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Empower & Achieve'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.canMove).toBe(false);
      expect(parsed.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          blockerType: 'missing_required_field',
          field: 'description',
          label: 'Customer Need',
          type: 'text',
          required: true
        }),
        expect.objectContaining({
          blockerType: 'missing_required_field',
          field: 'parentcontactid',
          label: 'Customer Decision Maker',
          type: 'lookup',
          required: true,
          bindKey: 'parentcontactid@odata.bind',
          lookup: expect.objectContaining({
            kind: 'searchable-select',
            entitySet: 'contacts',
            bindKey: 'parentcontactid@odata.bind',
            allowManualGuidEntry: false,
            options: expect.arrayContaining([
              expect.objectContaining({
                label: 'Adele Vance',
                id: CONTACT_ID,
                entitySet: 'contacts',
                bindPath: `/contacts(${CONTACT_ID})`
              })
            ])
          })
        })
      ]));
    });

    it('preserves lookup pagination metadata on preflight blockers', async () => {
      const extraContacts = Array.from({ length: 26 }, (_, index) => ({
        contactid: `${String(index + 1).padStart(8, '0')}-bbbb-cccc-dddd-eeeeeeeeeeee`,
        fullname: `Contact ${String(index + 1).padStart(2, '0')}`,
        emailaddress1: `contact${index + 1}@example.com`,
        _parentcustomerid_value: ACCOUNT_ID
      }));
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet === 'msp_mcemprocesses') {
          return {
            ok: true,
            status: 200,
            data: { value: [{ businessprocessflowinstanceid: BPF_ID, _activestageid_value: STAGE_2, traversedpath: `${STAGE_1},${STAGE_2}` }] }
          };
        }
        if (entitySet === 'msp_engagementmilestones') return { ok: true, status: 200, data: { value: [] } };
        if (entitySet === 'contacts') return { ok: true, status: 200, data: { value: extraContacts } };
        return { ok: true, status: 200, data: { value: [] } };
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Empower & Achieve'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const cdm = parsed.blockers.find(b => b.field === 'parentcontactid');
      expect(cdm.lookup.options).toHaveLength(25);
      expect(cdm.lookup.hasMore).toBe(true);
      expect(cdm.lookup.nextPage).toEqual({ skip: 25, limit: 25 });
      expect(cdm.hasMore).toBe(true);
      expect(cdm.nextPage).toEqual({ skip: 25, limit: 25 });
    });

    it('does not expose GUID-only UX for lookup blockers', async () => {
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Empower & Achieve'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const cdm = parsed.blockers.find(b => b.field === 'parentcontactid');
      expect(cdm.lookup.allowManualGuidEntry).toBe(false);
      expect(cdm.lookup.searchTool).toBe('mcem_stage_lookup_search');
      expect(cdm.lookup.searchEndpoint).toBe('/api/opportunity-stage-lookup-search');
      expect(cdm.lookup.options[0]).toEqual(expect.objectContaining({
        label: 'Adele Vance',
        id: CONTACT_ID,
        bindKey: 'parentcontactid@odata.bind'
      }));
      expect(cdm.lookup).not.toHaveProperty('guidFallback');
      expect(cdm.message).not.toMatch(/enter.*guid/i);
    });

    it('returns picklist options for Compete Threat Level blockers', async () => {
      mockStageCrm({
        stageId: STAGE_3,
        milestones: [{ msp_engagementmilestoneid: 'milestone-1' }],
        opportunityOverrides: {
          _msp_primarycompetitor_value: null,
          msp_competethreatlevel: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Realize Value'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'msp_primarycompetitor',
          label: 'Primary Competitor',
          type: 'lookup',
          lookup: expect.objectContaining({
            kind: 'searchable-select',
            entitySet: 'competitors',
            allowManualGuidEntry: false,
            quickOptions: expect.arrayContaining([
              expect.objectContaining({ key: 'google-gcp', label: 'Google | GCP', type: 'record-search' }),
              expect.objectContaining({ key: 'aws-other', label: 'AWS | Other', type: 'record-search' }),
              expect.objectContaining({ key: 'none', label: 'None', type: 'null-selection' })
            ]),
            nullSelection: expect.objectContaining({
              allowed: true,
              quickOptionKey: 'none',
              bindKey: 'msp_PrimaryCompetitor@odata.bind'
            }),
            options: expect.arrayContaining([
              expect.objectContaining({
                label: 'Fabrikam Cloud',
                id: COMPETITOR_ID,
                bindPath: `/competitors(${COMPETITOR_ID})`
              })
            ])
          })
        }),
        expect.objectContaining({
          field: 'msp_competethreatlevel',
          label: 'Compete Threat Level',
          type: 'picklist',
          options: expect.arrayContaining([{ value: 861980002, label: 'Medium' }])
        })
      ]));
    });

    it('searches whitelisted lookup blocker options by human-readable term', async () => {
      mockStageCrm({ stageId: STAGE_2 });

      const result = await callTool(server, 'mcem_stage_lookup_search', {
        opportunityId: OPP_ID,
        field: 'parentcontactid',
        term: 'Adele',
        entitySet: 'contacts'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.lookup).toEqual(expect.objectContaining({
        field: 'parentcontactid',
        entitySet: 'contacts',
        allowManualGuidEntry: false
      }));
      expect(parsed.options).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'Adele Vance', id: CONTACT_ID })
      ]));
      expect(crm.requestAllPages).toHaveBeenCalledWith(
        'contacts',
        expect.objectContaining({
          query: expect.objectContaining({
            $filter: `_parentcustomerid_value eq '${ACCOUNT_ID}' and (contains(fullname,'Adele') or contains(emailaddress1,'Adele'))`
          })
        })
      );
    });

    it('searches Customer Decision Maker only within the opportunity account by typed name or email', async () => {
      mockStageCrm({ stageId: STAGE_2 });
      crm.requestAllPages.mockImplementation(async (entitySet, opts = {}) => {
        if (entitySet !== 'contacts') return { ok: true, status: 200, data: { value: [] } };
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { contactid: CONTACT_ID, fullname: 'Adele Vance', emailaddress1: 'adele@example.com', jobtitle: 'CIO', _parentcustomerid_value: ACCOUNT_ID },
              { contactid: OTHER_CONTACT_ID, fullname: 'Ada Outside', emailaddress1: 'ada@outside.example.com', jobtitle: 'CTO', _parentcustomerid_value: '88888888-8888-8888-8888-888888888888' }
            ]
          }
        };
      });

      const result = await callTool(server, 'mcem_stage_lookup_search', {
        opportunityId: OPP_ID,
        field: 'parentcontactid',
        term: 'ada',
        entitySet: 'contacts',
        limit: 10
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.options.map(o => o.id)).toEqual([CONTACT_ID]);
      expect(parsed.options[0]).toEqual(expect.objectContaining({
        label: 'Adele Vance',
        rank: expect.objectContaining({ scope: 'account-related' })
      }));
      const contactCalls = crm.requestAllPages.mock.calls.filter(([entitySet]) => entitySet === 'contacts');
      expect(contactCalls).toHaveLength(1);
      expect(contactCalls[0][1].query.$filter).toBe(`_parentcustomerid_value eq '${ACCOUNT_ID}' and (contains(fullname,'ada') or contains(emailaddress1,'ada'))`);
    });

    it('paginates Customer Decision Maker search within the opportunity account without using unsupported $skip', async () => {
      mockStageCrm();
      const contact3 = 'dddddddd-eeee-ffff-0000-111111111111';
      const contact4 = 'eeeeeeee-ffff-0000-1111-222222222222';
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet !== 'contacts') return { ok: true, status: 200, data: { value: [] } };
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { contactid: CONTACT_ID, fullname: 'Adele Vance', emailaddress1: 'adele@example.com', _parentcustomerid_value: ACCOUNT_ID },
              { contactid: OTHER_CONTACT_ID, fullname: 'Ada Outside', emailaddress1: 'ada@outside.example.com', _parentcustomerid_value: '88888888-8888-8888-8888-888888888888' },
              { contactid: contact3, fullname: 'Brian Johnson', emailaddress1: 'brian@example.com', _parentcustomerid_value: ACCOUNT_ID },
              { contactid: contact4, fullname: 'Zoe Lee', emailaddress1: 'zoe@example.com', _parentcustomerid_value: ACCOUNT_ID }
            ]
          }
        };
      });

      const result = await callTool(server, 'mcem_stage_lookup_search', {
        opportunityId: OPP_ID,
        field: 'parentcontactid',
        entitySet: 'contacts',
        limit: 2,
        skip: 1
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.options).toHaveLength(2);
      expect(parsed.options.map(o => o.id)).toEqual([contact3, contact4]);
      expect(parsed.hasMore).toBe(false);
      expect(parsed.nextPage).toBeNull();
      expect(parsed.pagination).toEqual(expect.objectContaining({ limit: 2, returned: 2, hasMore: false }));
      expect(crm.requestAllPages).toHaveBeenCalledWith('contacts', expect.objectContaining({
        maxRecords: 4,
        query: expect.objectContaining({
          $top: '4',
          $filter: `_parentcustomerid_value eq '${ACCOUNT_ID}'`
        })
      }));
      expect(crm.requestAllPages.mock.calls[0][1].query).not.toHaveProperty('$skip');
    });

    it('returns Primary Competitor limit and hasMore metadata from the competitors entity set', async () => {
      const competitor2 = 'dddddddd-eeee-ffff-0000-111111111111';
      const competitor3 = 'eeeeeeee-ffff-0000-1111-222222222222';
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet !== 'competitors') return { ok: true, status: 200, data: { value: [] } };
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { competitorid: COMPETITOR_ID, name: 'Fabrikam Cloud' },
              { competitorid: competitor2, name: 'Northwind Cloud' },
              { competitorid: competitor3, name: 'Tailspin Cloud' }
            ]
          }
        };
      });

      const result = await callTool(server, 'mcem_stage_lookup_search', {
        field: 'msp_primarycompetitor',
        term: 'Cloud',
        entitySet: 'competitors',
        limit: 2
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.lookup.entitySet).toBe('competitors');
      expect(parsed.lookup.quickOptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'google-gcp', label: 'Google | GCP' }),
        expect.objectContaining({ key: 'aws-other', label: 'AWS | Other' }),
        expect.objectContaining({ key: 'none', label: 'None', type: 'null-selection' })
      ]));
      expect(parsed.options).toHaveLength(2);
      expect(parsed.limit).toBe(2);
      expect(parsed.hasMore).toBe(true);
      expect(parsed.nextPage).toEqual({ skip: 2, limit: 2 });
      expect(parsed.pagination).toEqual(expect.objectContaining({ limit: 2, returned: 2, hasMore: true }));
      expect(crm.requestAllPages).toHaveBeenCalledWith('competitors', expect.objectContaining({
        maxRecords: 3,
        query: expect.objectContaining({
          $top: '3',
          $filter: expect.stringContaining("contains(name,'Cloud')")
        })
      }));
    });

    it('paginates Primary Competitor search without unsupported $skip so next page does not 400', async () => {
      const competitor2 = 'dddddddd-eeee-ffff-0000-111111111111';
      const competitor3 = 'eeeeeeee-ffff-0000-1111-222222222222';
      const competitor4 = 'ffffffff-0000-1111-2222-333333333333';
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet !== 'competitors') return { ok: true, status: 200, data: { value: [] } };
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { competitorid: COMPETITOR_ID, name: 'Fabrikam Cloud' },
              { competitorid: competitor2, name: 'Northwind Cloud' },
              { competitorid: competitor3, name: 'Tailspin Cloud' },
              { competitorid: competitor4, name: 'Wide World Cloud' }
            ]
          }
        };
      });

      const result = await callTool(server, 'mcem_stage_lookup_search', {
        field: 'msp_primarycompetitor',
        term: 'Cloud',
        entitySet: 'competitors',
        limit: 2,
        skip: 2
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.options.map(o => o.id)).toEqual([competitor3, competitor4]);
      expect(parsed.hasMore).toBe(false);
      expect(crm.requestAllPages).toHaveBeenCalledWith('competitors', expect.objectContaining({
        maxRecords: 5,
        query: expect.objectContaining({
          $top: '5',
          $filter: expect.stringContaining("contains(name,'Cloud')")
        })
      }));
      expect(crm.requestAllPages.mock.calls[0][1].query).not.toHaveProperty('$skip');
    });

    it('expands Primary Competitor quick option terms to matching competitor record searches', async () => {
      const googleCompetitorId = 'dddddddd-eeee-ffff-0000-111111111111';
      const gcpCompetitorId = 'eeeeeeee-ffff-0000-1111-222222222222';
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet !== 'competitors') return { ok: true, status: 200, data: { value: [] } };
        return {
          ok: true,
          status: 200,
          data: {
            value: [
              { competitorid: googleCompetitorId, name: 'Google' },
              { competitorid: gcpCompetitorId, name: 'GCP' }
            ]
          }
        };
      });

      const result = await callTool(server, 'mcem_stage_lookup_search', {
        field: 'msp_primarycompetitor',
        term: 'Google | GCP',
        entitySet: 'competitors',
        limit: 10
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.options.map(o => o.label)).toEqual(['GCP', 'Google']);
      expect(crm.requestAllPages).toHaveBeenCalledWith('competitors', expect.objectContaining({
        query: expect.objectContaining({
          $filter: "(contains(name,'Google') or contains(name,'GCP'))"
        })
      }));
    });

    it('blocks Empower to Realize when no milestone exists and does not auto-create one', async () => {
      mockStageCrm({ stageId: STAGE_3, milestones: [] });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Realize Value'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.canMove).toBe(false);
      expect(parsed.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'milestone_required' })
      ]));
      expect(crm.request).not.toHaveBeenCalledWith('msp_engagementmilestones', expect.objectContaining({ method: 'POST' }));
    });

    it('allows backward preflight without forward-stage blockers', async () => {
      mockStageCrm({
        stageId: STAGE_3,
        milestones: [],
        opportunityOverrides: {
          _msp_primarycompetitor_value: null,
          msp_competethreatlevel: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Inspire & Design'
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('ready');
      expect(parsed.canMove).toBe(true);
      expect(parsed.direction).toBe('backward');
      expect(parsed.blockers).toEqual([]);
      expect(parsed.moves).toEqual([
        expect.objectContaining({
          from: { number: 3, name: 'Empower & Achieve' },
          to: { number: 2, name: 'Inspire & Design' },
          direction: 'backward',
          ready: true,
          autoFillChecklistSilently: false
        })
      ]);
    });

    it('executes backward stage movement through BPF instance and truncates traversedpath to the target stage', async () => {
      mockStageCrm({
        stageId: STAGE_4,
        traversedPath: `${STAGE_1},${STAGE_2},${STAGE_3},${STAGE_4}`,
        milestones: [],
        opportunityOverrides: {
          _msp_primarycompetitor_value: null,
          msp_competethreatlevel: null
        }
      });

      const staged = await callTool(server, 'update_opportunity_stage', {
        opportunityId: OPP_ID,
        targetStage: 1
      });
      expect(staged.isError).toBeUndefined();
      const stagedParsed = JSON.parse(staged.content[0].text);
      expect(stagedParsed.staged).toBe(true);
      expect(stagedParsed.direction).toBe('backward');
      expect(stagedParsed.autoFillChecklistSilently).toBe(false);

      const executed = await callTool(server, 'execute_operation', { id: stagedParsed.operationId });
      expect(executed.isError).toBeUndefined();

      expect(crm.request).not.toHaveBeenCalledWith(
        `opportunities(${OPP_ID})`,
        expect.objectContaining({ method: 'PATCH' })
      );
      expect(crm.request).toHaveBeenCalledWith(
        `msp_mcemprocesses(${BPF_ID})`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            'activestageid@odata.bind': `/processstages(${STAGE_1})`,
            traversedpath: STAGE_1
          })
        })
      );
    });

    it('executes stage movement through BPF instance and never patches msp_activesalesstage', async () => {
      mockStageCrm({ stageId: STAGE_1 });

      const staged = await callTool(server, 'update_opportunity_stage', {
        opportunityId: OPP_ID,
        targetStage: 2
      });
      const stagedParsed = JSON.parse(staged.content[0].text);

      const executed = await callTool(server, 'execute_operation', { id: stagedParsed.operationId });
      expect(executed.isError).toBeUndefined();

      const oppPatchCall = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` && opts?.method === 'PATCH'
      );
      expect(oppPatchCall[1].body).toMatchObject({
        msp_customerprioritiesidentified: 606820000,
        msp_qualifiedopportunity: 861980000
      });
      expect(oppPatchCall[1].body).not.toHaveProperty('msp_activesalesstage');

      expect(crm.request).toHaveBeenCalledWith(
        `msp_mcemprocesses(${BPF_ID})`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            'activestageid@odata.bind': `/processstages(${STAGE_2})`
          })
        })
      );
    });

    it('falls back when the hardcoded MCEM BPF entity set is missing', async () => {
      const actualEntitySet = 'new_mcemprocessinstances';
      let activeStageId = STAGE_1;

      crm.request.mockImplementation(async (path, opts = {}) => {
        if (path === 'WhoAmI') return { ok: true, status: 200, data: { UserId: 'user-1', BusinessUnitId: 'bu-1' } };
        if (path.startsWith('RetrieveProcessInstances(')) {
          return {
            ok: true,
            status: 200,
            data: {
              value: [{
                ProcessInstanceId: BPF_ID,
                ProcessDefinitionId: MCEM_PROCESS_ID,
                ActiveStageId: activeStageId
              }]
            }
          };
        }
        if (path === "EntityDefinitions(LogicalName='msp_mcemprocess')") {
          return { ok: true, status: 200, data: { LogicalName: 'new_mcemprocess', EntitySetName: actualEntitySet } };
        }
        if (path === `msp_mcemprocesses(${BPF_ID})`) {
          return { ok: false, status: 404, data: { message: "Resource not found for the segment 'msp_mcemprocesses'." } };
        }
        if (path === `${actualEntitySet}(${BPF_ID})` && opts.method === 'PATCH') {
          activeStageId = opts.body?.['activestageid@odata.bind']?.match(/\(([^)]+)\)/)?.[1] || activeStageId;
          return { ok: true, status: 204, data: {} };
        }
        if (path === `${actualEntitySet}(${BPF_ID})`) {
          return {
            ok: true,
            status: 200,
            data: {
              businessprocessflowinstanceid: BPF_ID,
              _activestageid_value: activeStageId,
              traversedpath: STAGE_1
            }
          };
        }
        if (path === `opportunities(${OPP_ID})` && opts.method === 'PATCH') return { ok: true, status: 204, data: {} };
        if (path === `opportunities(${OPP_ID})`) {
          return {
            ok: true,
            status: 200,
            data: {
              opportunityid: OPP_ID,
              name: 'MCEM Opp',
              msp_activesalesstage: 'Listen & Consult',
              msp_solutionarea: 861980005,
              msp_salesplay: 861980095
            }
          };
        }
        return { ok: true, status: 200, data: {} };
      });
      crm.requestAllPages.mockImplementation(async (entitySet) => {
        if (entitySet === 'EntityDefinitions') {
          return {
            ok: true,
            status: 200,
            data: { value: [{ LogicalName: 'new_mcemprocess', EntitySetName: actualEntitySet }] }
          };
        }
        if (entitySet === 'msp_mcemprocesses') {
          return { ok: false, status: 404, data: { message: "Resource not found for the segment 'msp_mcemprocesses'." } };
        }
        return { ok: true, status: 200, data: { value: [] } };
      });

      const preflight = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 'Inspire & Design'
      });
      expect(preflight.isError).toBeUndefined();
      expect(JSON.parse(preflight.content[0].text).status).toBe('ready');

      const staged = await callTool(server, 'update_opportunity_stage', {
        opportunityId: OPP_ID,
        targetStage: 2
      });
      const stagedParsed = JSON.parse(staged.content[0].text);
      const executed = await callTool(server, 'execute_operation', { id: stagedParsed.operationId });
      expect(executed.isError).toBeUndefined();

      expect(crm.request).toHaveBeenCalledWith(
        `${actualEntitySet}(${BPF_ID})`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            'activestageid@odata.bind': `/processstages(${STAGE_2})`
          })
        })
      );
    });

    it('saves submitted blocker fieldValues, reruns preflight, then stages movement', async () => {
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });

      const staged = await callTool(server, 'update_opportunity_stage', {
        opportunityId: OPP_ID,
        targetStage: 3,
        fieldValues: {
          description: 'Customer needs Copilot rollout plan',
          parentcontactid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        }
      });

      expect(staged.isError).toBeUndefined();
      const stagedParsed = JSON.parse(staged.content[0].text);
      expect(stagedParsed.staged).toBe(true);
      expect(stagedParsed.savedFieldNames).toEqual(expect.arrayContaining(['description', 'parentcontactid@odata.bind']));

      const prereqPatch = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` &&
        opts?.method === 'PATCH' &&
        opts.body?.description === 'Customer needs Copilot rollout plan'
      );
      expect(prereqPatch[1].body).toMatchObject({
        description: 'Customer needs Copilot rollout plan',
        'parentcontactid@odata.bind': '/contacts(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)'
      });

      const executed = await callTool(server, 'execute_operation', { id: stagedParsed.operationId });
      expect(executed.isError).toBeUndefined();
      expect(crm.request).toHaveBeenCalledWith(
        `msp_mcemprocesses(${BPF_ID})`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            'activestageid@odata.bind': `/processstages(${STAGE_3})`
          })
        })
      );
    });

    it('rejects invalid picklist labels in submitted blocker fieldValues', async () => {
      mockStageCrm({
        stageId: STAGE_3,
        milestones: [{ msp_engagementmilestoneid: 'milestone-1' }],
        opportunityOverrides: {
          msp_competethreatlevel: null
        }
      });

      const staged = await callTool(server, 'update_opportunity_stage', {
        opportunityId: OPP_ID,
        targetStage: 4,
        fieldValues: {
          msp_competethreatlevel: 'Not a level'
        }
      });

      expect(staged.isError).toBe(true);
      expect(staged.content[0].text).toContain('Compete Threat Level option label');
    });

    it('validates selected lookup option ids before saving bind paths', async () => {
      const missingContactId = 'dddddddd-eeee-ffff-0000-111111111111';
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 3,
        fieldValues: {
          parentcontactid: missingContactId
        }
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Select a valid Customer Decision Maker option');
      expect(crm.request).not.toHaveBeenCalledWith(
        `opportunities(${OPP_ID})`,
        expect.objectContaining({
          method: 'PATCH',
          body: expect.objectContaining({
            'parentcontactid@odata.bind': `/contacts(${missingContactId})`
          })
        })
      );
    });

    it('accepts selected Customer Decision Maker contacts outside the opportunity account after id validation', async () => {
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 3,
        fieldValues: {
          parentcontactid: OTHER_CONTACT_ID
        }
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.savedFieldNames).toContain('parentcontactid@odata.bind');
      const prereqPatch = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` &&
        opts?.method === 'PATCH' &&
        opts.body?.['parentcontactid@odata.bind']
      );
      expect(prereqPatch[1].body).toMatchObject({
        'parentcontactid@odata.bind': `/contacts(${OTHER_CONTACT_ID})`
      });
    });

    it('accepts selected competitor option ids and saves the correct Dataverse bind path', async () => {
      mockStageCrm({
        stageId: STAGE_3,
        milestones: [{ msp_engagementmilestoneid: 'milestone-1' }],
        opportunityOverrides: {
          _msp_primarycompetitor_value: null
        }
      });

      const readEntitySet = 'competitors';
      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 4,
        fieldValues: {
          msp_primarycompetitor: { id: COMPETITOR_ID, label: 'Fabrikam Cloud', entitySet: readEntitySet }
        }
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.savedFieldNames).toContain('msp_PrimaryCompetitor@odata.bind');
      const prereqPatch = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` &&
        opts?.method === 'PATCH' &&
        opts.body?.['msp_PrimaryCompetitor@odata.bind']
      );
      expect(prereqPatch[1].body).toMatchObject({
        'msp_PrimaryCompetitor@odata.bind': `/${readEntitySet}(${COMPETITOR_ID})`
      });
      expect(prereqPatch[1].body).not.toHaveProperty('msp_primarycompetitor');
      expect(prereqPatch[1].body).not.toHaveProperty('msp_primarycompetitor@odata.bind');
    });

    it('normalizes Primary Competitor bind input to the declared navigation bind payload', async () => {
      mockStageCrm({
        stageId: STAGE_3,
        milestones: [{ msp_engagementmilestoneid: 'milestone-1' }],
        opportunityOverrides: {
          _msp_primarycompetitor_value: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 4,
        fieldValues: {
          'msp_PrimaryCompetitor@odata.bind': `/competitors(${COMPETITOR_ID})`
        }
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.savedFieldNames).toContain('msp_PrimaryCompetitor@odata.bind');
      const prereqPatch = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` &&
        opts?.method === 'PATCH' &&
        opts.body?.['msp_PrimaryCompetitor@odata.bind']
      );
      expect(prereqPatch[1].body).toMatchObject({
        'msp_PrimaryCompetitor@odata.bind': `/competitors(${COMPETITOR_ID})`
      });
      expect(prereqPatch[1].body).not.toHaveProperty('msp_primarycompetitor');
      expect(prereqPatch[1].body).not.toHaveProperty('msp_primarycompetitor@odata.bind');
    });

    it('accepts Primary Competitor None quick option as a safe lookup clear payload', async () => {
      mockStageCrm({
        stageId: STAGE_3,
        milestones: [{ msp_engagementmilestoneid: 'milestone-1' }],
        opportunityOverrides: {
          _msp_primarycompetitor_value: COMPETITOR_ID
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 4,
        fieldValues: {
          msp_primarycompetitor: { quickOptionKey: 'none', value: null }
        }
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.savedFieldNames).toContain('msp_PrimaryCompetitor@odata.bind');
      expect(parsed.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'msp_primarycompetitor' })
      ]));
      const prereqPatch = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` &&
        opts?.method === 'PATCH' &&
        Object.prototype.hasOwnProperty.call(opts.body || {}, 'msp_PrimaryCompetitor@odata.bind')
      );
      expect(prereqPatch[1].body).toMatchObject({
        'msp_PrimaryCompetitor@odata.bind': null
      });
      expect(prereqPatch[1].body).not.toHaveProperty('msp_primarycompetitor');
      expect(prereqPatch[1].body).not.toHaveProperty('msp_primarycompetitor@odata.bind');
    });

    it('preflight Save & re-check saves fieldValues and reruns without staging movement', async () => {
      mockStageCrm({
        stageId: STAGE_2,
        opportunityOverrides: {
          description: null,
          _parentcontactid_value: null
        }
      });

      const result = await callTool(server, 'mcem_stage_preflight', {
        opportunityId: OPP_ID,
        targetStage: 3,
        fieldValues: {
          description: 'Customer need captured during modal',
          parentcontactid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        }
      });

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('ready');
      expect(parsed.canMove).toBe(true);
      expect(parsed.savedFieldNames).toEqual(expect.arrayContaining(['description', 'parentcontactid@odata.bind']));
      expect(parsed).not.toHaveProperty('operationId');

      const prereqPatch = crm.request.mock.calls.find(([path, opts]) =>
        path === `opportunities(${OPP_ID})` &&
        opts?.method === 'PATCH' &&
        opts.body?.description === 'Customer need captured during modal'
      );
      expect(prereqPatch[1].body).toMatchObject({
        description: 'Customer need captured during modal',
        'parentcontactid@odata.bind': '/contacts(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)'
      });
      expect(crm.request).not.toHaveBeenCalledWith(
        `msp_mcemprocesses(${BPF_ID})`,
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });
});

// ── UC9a: Committed Production Milestone Owner Role Check ─────────────────────
// Fixed logic: only flag when milestone owner's msp_rolegroup !== 'CSU'.
// CSU-owned milestones (valid CSAM↔CSA collaboration) must be excluded.
describe('UC9a — Committed Production Milestone: CSU collaboration vs. missed handoff (pipeline_health)', () => {
  let server;
  let crm;

  const MY_OPP_ID = '22222222-2222-2222-2222-222222222222';
  const CSU_OWNER = '33333333-3333-3333-3333-333333333333';
  const STU_OWNER = '44444444-4444-4444-4444-444444444444';
  const ATU_OWNER = '55555555-5555-5555-5555-555555555555';

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    // WhoAmI default: userId = 'user-1'
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-1', BusinessUnitId: 'bu-1' } }
    });
    registerTools(server, crm);
  });

  function makeMyOpp() {
    return {
      opportunityid: MY_OPP_ID,
      name: 'Production Opp',
      _ownerid_value: 'user-1',
      msp_estcompletiondate: '2027-06-30',
      msp_opportunitynumber: 'OPP-UC9A',
      '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso',
      msp_activesalesstage: null // null → parseSalesStageNumber returns null → no UC8 noise
    };
  }

  function makeCommittedProductionMs(ownerId, id = null) {
    return {
      msp_engagementmilestoneid: id || ('ms-uc9a-' + ownerId.slice(-3)),
      msp_milestonenumber: 'MS-UC9A',
      msp_name: 'Production Rollout',
      msp_milestonedate: '2027-01-01', // far future: not UC1 overdue, not UC7 expiring-soon
      msp_milestonecategory: 861980002, // CAT_PRODUCTION
      'msp_milestonecategory@OData.Community.Display.V1.FormattedValue': 'Production',
      'msp_commitmentrecommendation@OData.Community.Display.V1.FormattedValue': 'Committed',
      'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
      msp_milestonestatus: 'On Track', // string, not a terminal numeric code
      _msp_opportunityid_value: MY_OPP_ID,
      '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Production Opp',
      _ownerid_value: ownerId,
      '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Other Person',
      _msp_workloadlkid_value: 'workload-1',
      '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure'
    };
  }

  // Sets up the three requestAllPages calls that precede the systemusers lookup:
  //   call 1 — my owned opportunities
  //   call 2 — milestones from my opps (fetchMsFromOpps, first element of Promise.all)
  //   call 3 — milestones I own       (second element of Promise.all → empty to avoid extraOppIds)
  function setupPipelineBaseMocks(milestones) {
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200, data: { value: [makeMyOpp()] }
    });
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200, data: { value: milestones }
    });
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200, data: { value: [] }
    });
  }

  it('CSU owner on my opp → NOT included in committedProductionNotTransferred', async () => {
    setupPipelineBaseMocks([makeCommittedProductionMs(CSU_OWNER)]);
    // call 4: systemusers — owner is CSU
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: CSU_OWNER, msp_rolegroup: 'CSU' }] }
    });

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.committedProductionNotTransferred.count).toBe(0);
    expect(parsed.findings.committedProductionNotTransferred.items).toHaveLength(0);
  });

  it('STU owner on my opp → flagged in committedProductionNotTransferred', async () => {
    setupPipelineBaseMocks([makeCommittedProductionMs(STU_OWNER)]);
    // call 4: systemusers — owner is STU (missed handoff)
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: STU_OWNER, msp_rolegroup: 'STU' }] }
    });

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.committedProductionNotTransferred.count).toBe(1);
    expect(parsed.findings.committedProductionNotTransferred.items[0].currentOwner).toBeTruthy();
  });

  it('ATU owner on my opp → flagged in committedProductionNotTransferred', async () => {
    setupPipelineBaseMocks([makeCommittedProductionMs(ATU_OWNER)]);
    // call 4: systemusers — owner is ATU
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: ATU_OWNER, msp_rolegroup: 'ATU' }] }
    });

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.committedProductionNotTransferred.count).toBe(1);
  });

  it('systemuser lookup failure → fails open: milestone included with lookupWarning', async () => {
    setupPipelineBaseMocks([makeCommittedProductionMs(STU_OWNER)]);
    // call 4: systemusers — server error (non-ok response) → ownerDeptMap stays empty
    crm.requestAllPages.mockResolvedValueOnce({
      ok: false, status: 500, data: {}
    });

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // key not in ownerDeptMap → milestone included with lookupWarning, not silently flagged
    expect(parsed.findings.committedProductionNotTransferred.count).toBe(1);
    expect(parsed.findings.committedProductionNotTransferred.items[0].lookupWarning).toBe(true);
    expect(parsed.findings.committedProductionNotTransferred.items[0].warningReason).toBeTruthy();
  });

  it('owner found but msp_rolegroup is null → included with lookupWarning: true', async () => {
    setupPipelineBaseMocks([makeCommittedProductionMs(STU_OWNER)]);
    // call 4: user returned but msp_rolegroup field is null (not populated)
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [{ systemuserid: STU_OWNER, msp_rolegroup: null }] }
    });

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    // role resolved to null (found but field missing) → include with warning, not silent flag
    expect(parsed.findings.committedProductionNotTransferred.count).toBe(1);
    expect(parsed.findings.committedProductionNotTransferred.items[0].lookupWarning).toBe(true);
    expect(parsed.findings.committedProductionNotTransferred.items[0].warningReason).toMatch(/role could not be resolved/i);
  });

  it('mixed CSU + STU owners on same opp → only STU milestone is flagged', async () => {
    const csuMs = makeCommittedProductionMs(CSU_OWNER, 'ms-uc9a-csu');
    const stuMs = makeCommittedProductionMs(STU_OWNER, 'ms-uc9a-stu');

    setupPipelineBaseMocks([csuMs, stuMs]);
    // call 4: systemusers — both owners returned in one batch
    crm.requestAllPages.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { value: [
        { systemuserid: CSU_OWNER, msp_rolegroup: 'CSU' },
        { systemuserid: STU_OWNER, msp_rolegroup: 'STU' }
      ]}
    });

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.committedProductionNotTransferred.count).toBe(1);
    expect(parsed.findings.committedProductionNotTransferred.items[0].id).toBe('ms-uc9a-stu');
  });
});


// ── UC8: parseSalesStageNumber — MCEM phase string mapping ────────────────────
// Tests that parseSalesStageNumber correctly maps live MCEM phase name strings
// to stage numbers 1-5, enabling the UC8 stage check to work in production.
describe('UC8 — parseSalesStageNumber: MCEM phase string mapping (pipeline_health)', () => {
  let server;
  let crm;

  const MY_OPP_ID = '66666666-6666-6666-6666-666666666666';

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-1', BusinessUnitId: 'bu-1' } }
    });
    registerTools(server, crm);
  });

  function makeOppWithStage(stageString) {
    return {
      opportunityid: MY_OPP_ID,
      name: 'Stage Test Opp',
      _ownerid_value: 'user-1',
      msp_estcompletiondate: '2027-06-30',
      msp_opportunitynumber: 'OPP-UC8',
      '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Contoso',
      msp_activesalesstage: stageString,
      'msp_activesalesstage@OData.Community.Display.V1.FormattedValue': stageString
    };
  }

  function setupUC8Mocks(opp) {
    // call 1: my owned opportunities
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [opp] } });
    // call 2: milestones from my opps (empty — UC8 checks opp stage, not milestones)
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
    // call 3: milestones I own (empty)
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
  }

  it('Inspire & Design (stage 2) → flagged by UC8 (stage <= 3)', async () => {
    setupUC8Mocks(makeOppWithStage('Inspire & Design'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(1);
    expect(parsed.findings.wrongStageOpps.items[0].opportunityId).toBe(MY_OPP_ID);
  });

  it('Listen & Consult (stage 1) → flagged by UC8', async () => {
    setupUC8Mocks(makeOppWithStage('Listen & Consult'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(1);
  });

  it('Empower & Achieve (phase 3) → flagged by UC8', async () => {
    setupUC8Mocks(makeOppWithStage('Empower & Achieve'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(1);
  });

  it('Manage & Optimize (stage 5) → NOT flagged by UC8 (CSU-appropriate)', async () => {
    setupUC8Mocks(makeOppWithStage('Manage & Optimize'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(0);
  });

  it('Realize Value (stage 4) → NOT flagged by UC8 (CSU-appropriate)', async () => {
    setupUC8Mocks(makeOppWithStage('Realize Value'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(0);
  });

  it('null stage → NOT flagged (safe/ambiguous case)', async () => {
    setupUC8Mocks(makeOppWithStage(null));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(0);
  });

  it('empty string stage → NOT flagged', async () => {
    setupUC8Mocks(makeOppWithStage(''));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(0);
  });

  it('unknown string stage → NOT flagged', async () => {
    setupUC8Mocks(makeOppWithStage('unknown string'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(0);
  });

  it('legacy "Stage 3" format → flagged (backward compat)', async () => {
    setupUC8Mocks(makeOppWithStage('Stage 3'));
    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.wrongStageOpps.count).toBe(1);
  });
});

// ── UC9b: POC/Pilot Milestone Commitment Filter ────────────────────────────────
// Per MCEM §6: committed POC/Pilot milestones in Stage 3 are legitimately owned
// by CSAM/CSA. Only uncommitted POC/Pilot milestones should be flagged.
describe('UC9b — POC/Pilot milestone: committed excluded, uncommitted flagged (pipeline_health)', () => {
  let server;
  let crm;

  const MY_OPP_ID = '77777777-7777-7777-7777-777777777777';

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'user-1', BusinessUnitId: 'bu-1' } }
    });
    registerTools(server, crm);
  });

  function makeMyOpp9b() {
    return {
      opportunityid: MY_OPP_ID,
      name: 'POC Opp',
      _ownerid_value: 'user-1',
      msp_estcompletiondate: '2027-06-30',
      msp_opportunitynumber: 'OPP-UC9B',
      '_parentaccountid_value@OData.Community.Display.V1.FormattedValue': 'Fabrikam',
      msp_activesalesstage: null
    };
  }

  function makePocPilotMs(commitmentLabel) {
    return {
      msp_engagementmilestoneid: 'ms-uc9b-' + commitmentLabel.toLowerCase().replace(/\s+/g, '-'),
      msp_milestonenumber: 'MS-UC9B',
      msp_name: 'POC Delivery',
      msp_milestonedate: '2027-03-01',
      msp_milestonecategory: 861980000, // CAT_POC_PILOT
      'msp_milestonecategory@OData.Community.Display.V1.FormattedValue': 'POC/Pilot',
      'msp_commitmentrecommendation@OData.Community.Display.V1.FormattedValue': commitmentLabel,
      'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
      msp_milestonestatus: 'On Track',
      _msp_opportunityid_value: MY_OPP_ID,
      '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'POC Opp',
      _ownerid_value: 'user-1', // owned by me (CSU)
      '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Me',
      _msp_workloadlkid_value: 'workload-1',
      '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure'
    };
  }

  // UC9b only checks ownership + category + commitment — no systemusers call needed.
  function setupUC9bMocks(milestones) {
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [makeMyOpp9b()] } });
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: milestones } });
    crm.requestAllPages.mockResolvedValueOnce({ ok: true, status: 200, data: { value: [] } });
  }

  it('committed POC/Pilot milestone owned by CSU → NOT flagged (valid Stage 3 pattern)', async () => {
    setupUC9bMocks([makePocPilotMs('Committed')]);

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.pocPilotWrongOwner.count).toBe(0);
    expect(parsed.findings.pocPilotWrongOwner.items).toHaveLength(0);
  });

  it('uncommitted POC/Pilot milestone owned by CSU → flagged', async () => {
    setupUC9bMocks([makePocPilotMs('Uncommitted')]);

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.pocPilotWrongOwner.count).toBe(1);
    expect(parsed.findings.pocPilotWrongOwner.items[0].id).toBe('ms-uc9b-uncommitted');
  });

  it('unknown/missing commitment POC/Pilot owned by CSU → flagged (safe default)', async () => {
    // No commitmentrecommendation annotation → commitmentLabel returns 'Unknown' →
    // commitmentBucket returns 'Uncommitted' → should still be flagged as wrong owner
    const ms = makePocPilotMs('Unknown');
    delete ms['msp_commitmentrecommendation@OData.Community.Display.V1.FormattedValue'];
    setupUC9bMocks([ms]);

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.pocPilotWrongOwner.count).toBe(1);
  });

  it('mixed committed + uncommitted POC/Pilot → only uncommitted flagged', async () => {
    const committedMs = makePocPilotMs('Committed');
    committedMs.msp_engagementmilestoneid = 'ms-uc9b-committed-mix';
    const uncommittedMs = makePocPilotMs('Uncommitted');
    uncommittedMs.msp_engagementmilestoneid = 'ms-uc9b-uncommitted-mix';

    setupUC9bMocks([committedMs, uncommittedMs]);

    const result = await callTool(server, 'pipeline_health', {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings.pocPilotWrongOwner.count).toBe(1);
    expect(parsed.findings.pocPilotWrongOwner.items[0].id).toBe('ms-uc9b-uncommitted-mix');
  });
});