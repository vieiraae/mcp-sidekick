// MSX role taxonomy — maps Dataverse systemuser fields to short codes.
// Reference doc: mcp/msx/references/ROLE_TAXONOMY.md

export const DEPARTMENT_NAMES = {
  ATU: 'Account Technology Unit',
  STU: 'Solution Technology Unit',
  CSU: 'Customer Success Unit'
};

export const ROLE_NAMES = {
  CSAM: 'Customer Success Account Manager',
  CSA: 'Cloud Solution Architect',
  SE: 'Solution Engineer',
  TS: 'Technology Specialist',
  AE: 'Account Executive',
  ATS: 'Account Technology Strategist'
};

// Order matters — first match wins. Case-insensitive.
const ROLE_PATTERNS = [
  { re: /Customer Success Account Mgmt/i, code: 'CSAM' },
  { re: /Cloud Solution Architect/i,       code: 'CSA'  },
  { re: /Solution Engineering/i,           code: 'SE'   },
  { re: /Solution Area Specialist/i,       code: 'SE'   },
  { re: /Technology Specialist/i,          code: 'TS'   },
  { re: /Strategic Account Tech|National Tech/i, code: 'ATS' },
  { re: /Account Management|Strategic Account Management/i, code: 'AE' }
];

/**
 * Map a Dataverse `msp_rolesummary` string to a short role code.
 * @param {string|null|undefined} mspRoleSummary
 * @returns {{ roleCode: string, roleName: string|null }}
 */
export function mapRoleToCode(mspRoleSummary) {
  if (!mspRoleSummary || typeof mspRoleSummary !== 'string') {
    return { roleCode: 'UNKNOWN', roleName: null };
  }
  for (const { re, code } of ROLE_PATTERNS) {
    if (re.test(mspRoleSummary)) {
      return { roleCode: code, roleName: ROLE_NAMES[code] || null };
    }
  }
  console.warn(`crm_whoami: unrecognized msp_rolesummary: "${mspRoleSummary}"`);
  return { roleCode: 'UNKNOWN', roleName: null };
}
