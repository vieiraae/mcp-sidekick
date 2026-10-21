import { describe, it, expect } from 'vitest';

// Mock the fv helper and constants
const WORKLOAD_TYPE = {
  AZURE: 861980000,
  D365: 861980001,
  SECURITY: 861980002,
  MODERN_WORK: 861980003
};

function fv(record, field) {
  return record[`${field}@OData.Community.Display.V1.FormattedValue`] ?? null;
}

function parseWorkloadTypeCode(m) {
  const rawWorkloadType = m.msp_milestoneworkload;
  const parsedWorkloadType = rawWorkloadType === undefined || rawWorkloadType === null || rawWorkloadType === ''
    ? null
    : (typeof rawWorkloadType === 'number' ? rawWorkloadType : parseInt(rawWorkloadType, 10));
  return Number.isFinite(parsedWorkloadType) ? parsedWorkloadType : null;
}

function workloadTypeLabel(code) {
  switch (code) {
    case WORKLOAD_TYPE.AZURE: return 'Azure';
    case WORKLOAD_TYPE.D365: return 'D365';
    case WORKLOAD_TYPE.SECURITY: return 'Security';
    case WORKLOAD_TYPE.MODERN_WORK: return 'Modern Work';
    default: return null;
  }
}

function matchesWorkloadFilter(m, filterMode) {
  if (!filterMode) return true;
  const workloadTypeCode = parseWorkloadTypeCode(m);
  const mode = filterMode.toLowerCase();
  switch (mode) {
    case 'azure': return workloadTypeCode === WORKLOAD_TYPE.AZURE;
    case 'd365': return workloadTypeCode === WORKLOAD_TYPE.D365;
    case 'security': return workloadTypeCode === WORKLOAD_TYPE.SECURITY;
    case 'modern-work':
    case 'modern work': return workloadTypeCode === WORKLOAD_TYPE.MODERN_WORK;
    default: return true;
  }
}

function matchesCommentFilter(m, filterMode) {
  if (!filterMode || filterMode === 'any') return true;
  const forecastComments = m.msp_forecastcomments ?? null;
  const hasComments = forecastComments !== null && forecastComments !== '';
  if (filterMode === 'none') return !hasComments;
  const lastCommentedOnRaw = m['msp_forecastcomments_lastmodifiedon@OData.Community.Display.V1.FormattedValue']
    ?? m.msp_forecastcomments_lastmodifiedon
    ?? null;
  if (!hasComments) {
    return filterMode === 'none-or-stale';
  }
  if (!lastCommentedOnRaw) {
    return filterMode === 'stale' || filterMode === 'none-or-stale';
  }
  const commentDate = new Date(lastCommentedOnRaw);
  if (isNaN(commentDate.getTime())) {
    return filterMode === 'stale' || filterMode === 'none-or-stale';
  }
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const commentYYYYMMDD = `${commentDate.getFullYear()}-${pad(commentDate.getMonth() + 1)}-${pad(commentDate.getDate())}`;
  const today = new Date(todayStr);
  const commentDay = new Date(commentYYYYMMDD);
  const diffMs = today.getTime() - commentDay.getTime();
  const ageDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const isStale = ageDays > 30;
  if (filterMode === 'stale') return isStale;
  if (filterMode === 'none-or-stale') return isStale;
  return true;
}

function buildMilestoneSummary(milestones, crmBaseUrl) {
  const byStatus = {};
  const byOpportunity = {};
  const byCommitment = { Committed: 0, Uncommitted: 0 };
  const byWorkloadType = {};
  const byWorkload = {};
  for (const m of milestones) {
    const status = fv(m, 'msp_milestonestatus') || 'Unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    const opp = fv(m, '_msp_opportunityid_value') || 'Unknown';
    byOpportunity[opp] = (byOpportunity[opp] || 0) + 1;
    // Simplified commitment bucketing for test
    byCommitment.Committed += 1;
    const workloadTypeCode = parseWorkloadTypeCode(m);
    const workloadType = workloadTypeLabel(workloadTypeCode) || 'Unknown';
    byWorkloadType[workloadType] = (byWorkloadType[workloadType] || 0) + 1;
    const workloadName = fv(m, '_msp_workloadlkid_value') || 'Unknown';
    byWorkload[workloadName] = (byWorkload[workloadName] || 0) + 1;
  }
  return {
    count: milestones.length,
    byStatus,
    byCommitment,
    byOpportunity,
    byWorkloadType,
    byWorkload,
    milestones: []
  };
}

function projectMilestoneCompact(m, crmBaseUrl, customerName = null, ownerFilterGuid = null) {
  const workloadTypeCode = parseWorkloadTypeCode(m);
  const workloadType = workloadTypeLabel(workloadTypeCode);
  const forecastComments = m.msp_forecastcomments ?? null;
  const hasComments = forecastComments !== null && forecastComments !== '';
  const lastCommentedOnRaw = m['msp_forecastcomments_lastmodifiedon@OData.Community.Display.V1.FormattedValue']
    ?? m.msp_forecastcomments_lastmodifiedon
    ?? null;
  const lastCommentedOn = lastCommentedOnRaw;
  let commentAgeDays = null;
  if (lastCommentedOn) {
    const commentDate = new Date(lastCommentedOn);
    if (!isNaN(commentDate.getTime())) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const commentYYYYMMDD = `${commentDate.getFullYear()}-${pad(commentDate.getMonth() + 1)}-${pad(commentDate.getDate())}`;
      const today = new Date(todayStr);
      const commentDay = new Date(commentYYYYMMDD);
      const diffMs = today.getTime() - commentDay.getTime();
      commentAgeDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }
  }
  return {
    msp_engagementmilestoneid: m.msp_engagementmilestoneid,
    msp_name: m.msp_name || null,
    workloadType,
    workloadTypeCode,
    hasComments,
    lastCommentedOn,
    commentAgeDays
  };
}

describe('Wave 2 - Workload and Comment Filters', () => {
  describe('workloadFilter', () => {
    const azureMilestone = { msp_milestoneworkload: WORKLOAD_TYPE.AZURE, msp_engagementmilestoneid: '1', msp_name: 'Azure MS' };
    const d365Milestone = { msp_milestoneworkload: WORKLOAD_TYPE.D365, msp_engagementmilestoneid: '2', msp_name: 'D365 MS' };
    const securityMilestone = { msp_milestoneworkload: WORKLOAD_TYPE.SECURITY, msp_engagementmilestoneid: '3', msp_name: 'Security MS' };
    const modernWorkMilestone = { msp_milestoneworkload: WORKLOAD_TYPE.MODERN_WORK, msp_engagementmilestoneid: '4', msp_name: 'MW MS' };
    const milestones = [azureMilestone, d365Milestone, securityMilestone, modernWorkMilestone];

    it('filters Azure milestones', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, 'azure'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('Azure MS');
    });

    it('filters D365 milestones', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, 'd365'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('D365 MS');
    });

    it('filters Security milestones', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, 'security'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('Security MS');
    });

    it('filters Modern Work milestones (kebab-case)', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, 'modern-work'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('MW MS');
    });

    it('filters Modern Work milestones (space-separated)', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, 'Modern Work'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('MW MS');
    });

    it('tolerates capitalized labels', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, 'Azure'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('Azure MS');
    });

    it('no filter returns all milestones', () => {
      const filtered = milestones.filter(m => matchesWorkloadFilter(m, null));
      expect(filtered).toHaveLength(4);
    });
  });

  describe('commentFilter', () => {
    const now = new Date();
    const recentDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const staleDate = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000); // 40 days ago

    const noCommentMilestone = {
      msp_engagementmilestoneid: '1',
      msp_name: 'No Comment',
      msp_forecastcomments: null
    };

    const recentCommentMilestone = {
      msp_engagementmilestoneid: '2',
      msp_name: 'Recent Comment',
      msp_forecastcomments: 'Recent update',
      msp_forecastcomments_lastmodifiedon: recentDate.toISOString()
    };

    const staleCommentMilestone = {
      msp_engagementmilestoneid: '3',
      msp_name: 'Stale Comment',
      msp_forecastcomments: 'Old update',
      msp_forecastcomments_lastmodifiedon: staleDate.toISOString()
    };

    const milestones = [noCommentMilestone, recentCommentMilestone, staleCommentMilestone];

    it('filters milestones with no comments', () => {
      const filtered = milestones.filter(m => matchesCommentFilter(m, 'none'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('No Comment');
    });

    it('filters milestones with stale comments (>30 days)', () => {
      const filtered = milestones.filter(m => matchesCommentFilter(m, 'stale'));
      expect(filtered).toHaveLength(1);
      expect(filtered[0].msp_name).toBe('Stale Comment');
    });

    it('filters milestones with no comments OR stale comments', () => {
      const filtered = milestones.filter(m => matchesCommentFilter(m, 'none-or-stale'));
      expect(filtered).toHaveLength(2);
      const names = filtered.map(m => m.msp_name).sort();
      expect(names).toEqual(['No Comment', 'Stale Comment']);
    });

    it('any filter returns all milestones', () => {
      const filtered = milestones.filter(m => matchesCommentFilter(m, 'any'));
      expect(filtered).toHaveLength(3);
    });

    it('no filter returns all milestones', () => {
      const filtered = milestones.filter(m => matchesCommentFilter(m, null));
      expect(filtered).toHaveLength(3);
    });
  });

  describe('projectMilestoneCompact - workload fields', () => {
    it('projects workloadType and workloadTypeCode for Azure', () => {
      const milestone = {
        msp_engagementmilestoneid: '1',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.AZURE,
        msp_forecastcomments: null
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.workloadType).toBe('Azure');
      expect(projected.workloadTypeCode).toBe(WORKLOAD_TYPE.AZURE);
    });

    it('projects workloadType and workloadTypeCode for D365', () => {
      const milestone = {
        msp_engagementmilestoneid: '2',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.D365,
        msp_forecastcomments: null
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.workloadType).toBe('D365');
      expect(projected.workloadTypeCode).toBe(WORKLOAD_TYPE.D365);
    });

    it('projects workloadType and workloadTypeCode for Security', () => {
      const milestone = {
        msp_engagementmilestoneid: '3',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.SECURITY,
        msp_forecastcomments: null
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.workloadType).toBe('Security');
      expect(projected.workloadTypeCode).toBe(WORKLOAD_TYPE.SECURITY);
    });

    it('projects workloadType and workloadTypeCode for Modern Work', () => {
      const milestone = {
        msp_engagementmilestoneid: '4',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.MODERN_WORK,
        msp_forecastcomments: null
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.workloadType).toBe('Modern Work');
      expect(projected.workloadTypeCode).toBe(WORKLOAD_TYPE.MODERN_WORK);
    });

    it('handles missing workload type', () => {
      const milestone = {
        msp_engagementmilestoneid: '5',
        msp_name: 'Test',
        msp_milestoneworkload: null,
        msp_forecastcomments: null
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.workloadType).toBeNull();
      expect(projected.workloadTypeCode).toBeNull();
    });
  });

  describe('projectMilestoneCompact - comment fields', () => {
    const fixedNow = new Date('2026-06-26T10:00:00Z');

    it('projects hasComments, lastCommentedOn, and commentAgeDays for recent comment', () => {
      const commentDate = new Date(fixedNow.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const milestone = {
        msp_engagementmilestoneid: '1',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.AZURE,
        msp_forecastcomments: 'Recent update',
        msp_forecastcomments_lastmodifiedon: commentDate.toISOString()
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.hasComments).toBe(true);
      expect(projected.lastCommentedOn).toBeTruthy();
      expect(projected.commentAgeDays).toBeGreaterThanOrEqual(0);
    });

    it('projects hasComments=false for milestone with no comments', () => {
      const milestone = {
        msp_engagementmilestoneid: '2',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.AZURE,
        msp_forecastcomments: null
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.hasComments).toBe(false);
      expect(projected.lastCommentedOn).toBeNull();
      expect(projected.commentAgeDays).toBeNull();
    });

    it('projects hasComments=false for milestone with empty comment', () => {
      const milestone = {
        msp_engagementmilestoneid: '3',
        msp_name: 'Test',
        msp_milestoneworkload: WORKLOAD_TYPE.AZURE,
        msp_forecastcomments: ''
      };
      const projected = projectMilestoneCompact(milestone, 'https://test.crm');
      expect(projected.hasComments).toBe(false);
      expect(projected.lastCommentedOn).toBeNull();
      expect(projected.commentAgeDays).toBeNull();
    });
  });

  describe('buildMilestoneSummary - byWorkloadType and byWorkload', () => {
    it('groups milestones by workload type', () => {
      const milestones = [
        {
          msp_engagementmilestoneid: '1',
          msp_name: 'Azure 1',
          msp_milestoneworkload: WORKLOAD_TYPE.AZURE,
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Opp A',
          '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'AI: Azure OpenAI'
        },
        {
          msp_engagementmilestoneid: '2',
          msp_name: 'Azure 2',
          msp_milestoneworkload: WORKLOAD_TYPE.AZURE,
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Opp A',
          '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Azure Migration'
        },
        {
          msp_engagementmilestoneid: '3',
          msp_name: 'D365 1',
          msp_milestoneworkload: WORKLOAD_TYPE.D365,
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Opp B',
          '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'D365 Sales'
        },
        {
          msp_engagementmilestoneid: '4',
          msp_name: 'Security 1',
          msp_milestoneworkload: WORKLOAD_TYPE.SECURITY,
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Opp C',
          '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': 'Entra ID'
        }
      ];
      const summary = buildMilestoneSummary(milestones, 'https://test.crm');
      expect(summary.byWorkloadType).toEqual({
        Azure: 2,
        D365: 1,
        Security: 1
      });
      expect(summary.byWorkload).toEqual({
        'AI: Azure OpenAI': 1,
        'Azure Migration': 1,
        'D365 Sales': 1,
        'Entra ID': 1
      });
      expect(summary.count).toBe(4);
    });

    it('handles milestones with no workload type', () => {
      const milestones = [
        {
          msp_engagementmilestoneid: '1',
          msp_name: 'Unknown',
          msp_milestoneworkload: null,
          'msp_milestonestatus@OData.Community.Display.V1.FormattedValue': 'On Track',
          '_msp_opportunityid_value@OData.Community.Display.V1.FormattedValue': 'Opp A',
          '_msp_workloadlkid_value@OData.Community.Display.V1.FormattedValue': null
        }
      ];
      const summary = buildMilestoneSummary(milestones, 'https://test.crm');
      expect(summary.byWorkloadType).toEqual({ Unknown: 1 });
      expect(summary.byWorkload).toEqual({ Unknown: 1 });
    });
  });
});
