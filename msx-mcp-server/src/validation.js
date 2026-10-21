// Input validation utilities for OData queries and API calls (extracted from frontend)

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidGuid(value) {
  if (!value || typeof value !== 'string') return false;
  return GUID_REGEX.test(value);
}

export function normalizeGuid(value) {
  return String(value || '').replace(/[{}]/g, '').toLowerCase();
}

export function isValidTpid(value) {
  if (!value || typeof value !== 'string') return false;
  return /^\d+$/.test(value) && value.length >= 1;
}

export function sanitizeODataString(value, { maxLength = 200 } = {}) {
  if (!value || typeof value !== 'string') return '';
  // Strip ASCII control characters (0x00–0x1F and DEL 0x7F)
  let s = value.replace(/[\x00-\x1F\x7F]/g, '');
  if (maxLength > 0 && s.length > maxLength) s = s.slice(0, maxLength);
  return s.replace(/'/g, "''");
}
