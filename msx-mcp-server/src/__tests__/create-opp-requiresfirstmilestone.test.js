import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../tools.js';
import { resetApprovalQueue, getApprovalQueue } from '../approval-queue.js';

// Build a mock CRM client
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
    search: vi.fn(async () => ({ ok: true, status: 200, data: { value: [] } })),
    buildUrl: vi.fn(),
    getCrmUrl: vi.fn(() => 'https://test.crm.dynamics.com')
  };
}

// Helper: call a registered tool
async function callTool(server, name, args = {}) {
  const tool = server._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler(args);
}

describe('Bug 6/8: requiresFirstMilestone for create_opportunity in execute_all', () => {
  let server, crm;

  beforeEach(() => {
    resetApprovalQueue();
    server = new McpServer({ name: 'test', version: '0.0.1' });
    crm = mockCrmClient({
      WhoAmI: { ok: true, status: 200, data: { UserId: 'test-user', BusinessUnitId: 'test-bu' } }
    });
    registerTools(server, crm);
  });

  it('msp_opportunitytype as STRING "606820001" (Consumption) → requiresFirstMilestone === true', async () => {
    const queue = getApprovalQueue();
    const OPP_ID = 'aaaaaaaa-1111-2222-3333-000000000001';

    // Stage a create_opportunity with msp_opportunitytype as STRING "606820001"
    queue.stage({
      type: 'create_opportunity',
      entitySet: 'opportunities',
      method: 'POST',
      payload: {
        create: {
          name: 'Test Consumption Opp',
          msp_opportunitytype: '606820001'  // STRING, not number
        }
      },
      recordName: 'Test Consumption Opp',
      description: 'Create consumption opportunity'
    });

    // Mock CRM response
    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { opportunityid: OPP_ID }
    });

    const result = await callTool(server, 'execute_all');
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.executed).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.results).toHaveLength(1);

    const enrichedResult = parsed.results[0];
    expect(enrichedResult.type).toBe('create_opportunity');
    expect(enrichedResult.success).toBe(true);
    expect(enrichedResult.opportunityId).toBe(OPP_ID);
    expect(enrichedResult.recordName).toBe('Test Consumption Opp');
    
    // CRITICAL: with the fix, this should be TRUE (old code would compare "606820001" === 606820001 → false)
    expect(enrichedResult.requiresFirstMilestone).toBe(true);
  });

  it('msp_opportunitytype as STRING "606820000,606820001" (multi, comma-separated) → requiresFirstMilestone === true', async () => {
    const queue = getApprovalQueue();
    const OPP_ID = 'aaaaaaaa-1111-2222-3333-000000000002';

    queue.stage({
      type: 'create_opportunity',
      entitySet: 'opportunities',
      method: 'POST',
      payload: {
        create: {
          name: 'Multi-Type Opp',
          msp_opportunitytype: '606820000,606820001'  // Both Billed and Consumption
        }
      },
      recordName: 'Multi-Type Opp',
      description: 'Create multi-type opportunity'
    });

    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { opportunityid: OPP_ID }
    });

    const result = await callTool(server, 'execute_all');
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.executed).toBe(1);
    expect(parsed.results).toHaveLength(1);

    const enrichedResult = parsed.results[0];
    expect(enrichedResult.opportunityId).toBe(OPP_ID);
    expect(enrichedResult.recordName).toBe('Multi-Type Opp');
    
    // Includes 606820001 → requiresFirstMilestone should be TRUE
    expect(enrichedResult.requiresFirstMilestone).toBe(true);
  });

  it('msp_opportunitytype as STRING "606820000" (Billed only) → requiresFirstMilestone === false', async () => {
    const queue = getApprovalQueue();
    const OPP_ID = 'aaaaaaaa-1111-2222-3333-000000000003';

    queue.stage({
      type: 'create_opportunity',
      entitySet: 'opportunities',
      method: 'POST',
      payload: {
        create: {
          name: 'Billed Only Opp',
          msp_opportunitytype: '606820000'  // Billed only
        }
      },
      recordName: 'Billed Only Opp',
      description: 'Create billed-only opportunity'
    });

    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { opportunityid: OPP_ID }
    });

    const result = await callTool(server, 'execute_all');
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.executed).toBe(1);
    expect(parsed.results).toHaveLength(1);

    const enrichedResult = parsed.results[0];
    expect(enrichedResult.opportunityId).toBe(OPP_ID);
    expect(enrichedResult.recordName).toBe('Billed Only Opp');
    
    // Does NOT include 606820001 → requiresFirstMilestone should be FALSE
    expect(enrichedResult.requiresFirstMilestone).toBe(false);
  });

  it('msp_opportunitytype as NUMBER 606820001 → requiresFirstMilestone === true', async () => {
    const queue = getApprovalQueue();
    const OPP_ID = 'aaaaaaaa-1111-2222-3333-000000000004';

    queue.stage({
      type: 'create_opportunity',
      entitySet: 'opportunities',
      method: 'POST',
      payload: {
        create: {
          name: 'Numeric Consumption Opp',
          msp_opportunitytype: 606820001  // NUMBER, not string
        }
      },
      recordName: 'Numeric Consumption Opp',
      description: 'Create opportunity with numeric type'
    });

    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { opportunityid: OPP_ID }
    });

    const result = await callTool(server, 'execute_all');
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.executed).toBe(1);
    const enrichedResult = parsed.results[0];
    expect(enrichedResult.opportunityId).toBe(OPP_ID);
    expect(enrichedResult.requiresFirstMilestone).toBe(true);
  });

  it('msp_opportunitytype as ARRAY [606820001] → requiresFirstMilestone === true', async () => {
    const queue = getApprovalQueue();
    const OPP_ID = 'aaaaaaaa-1111-2222-3333-000000000005';

    queue.stage({
      type: 'create_opportunity',
      entitySet: 'opportunities',
      method: 'POST',
      payload: {
        create: {
          name: 'Array Consumption Opp',
          msp_opportunitytype: [606820001]  // ARRAY
        }
      },
      recordName: 'Array Consumption Opp',
      description: 'Create opportunity with array type'
    });

    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { opportunityid: OPP_ID }
    });

    const result = await callTool(server, 'execute_all');
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.executed).toBe(1);
    const enrichedResult = parsed.results[0];
    expect(enrichedResult.opportunityId).toBe(OPP_ID);
    expect(enrichedResult.requiresFirstMilestone).toBe(true);
  });

  it('msp_opportunitytype as ARRAY [606820000, 606820001] → requiresFirstMilestone === true', async () => {
    const queue = getApprovalQueue();
    const OPP_ID = 'aaaaaaaa-1111-2222-3333-000000000006';

    queue.stage({
      type: 'create_opportunity',
      entitySet: 'opportunities',
      method: 'POST',
      payload: {
        create: {
          name: 'Multi-Array Opp',
          msp_opportunitytype: [606820000, 606820001]  // ARRAY with both types
        }
      },
      recordName: 'Multi-Array Opp',
      description: 'Create opportunity with array of multiple types'
    });

    crm.request.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: { opportunityid: OPP_ID }
    });

    const result = await callTool(server, 'execute_all');
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.executed).toBe(1);
    const enrichedResult = parsed.results[0];
    expect(enrichedResult.opportunityId).toBe(OPP_ID);
    expect(enrichedResult.requiresFirstMilestone).toBe(true);
  });
});
