// CSV import: parsing, column detection and row preparation.
// Hygiene (normalizing, suppression, deduplication) is done by the database
// function `leads_import`, so there is one implementation of those rules.

export const IMPORT_FIELDS = ['email', 'full_name', 'phone', 'title', 'company', 'linkedin_url'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  email: 'Email', full_name: 'Full name', phone: 'Phone', title: 'Job title', company: 'Company', linkedin_url: 'LinkedIn URL',
};

export const MAX_ROWS = 5000;
export const MAX_BYTES = 5 * 1024 * 1024;

/** Header spellings seen in exports from the common tools, most specific first. */
const HINTS: Record<ImportField, string[]> = {
  email: ['email address', 'email_address', 'e-mail', 'work email', 'email'],
  full_name: ['full name', 'full_name', 'contact name', 'name'],
  phone: ['phone number', 'mobile', 'telephone', 'phone'],
  title: ['job title', 'jobtitle', 'position', 'title'],
  company: ['company name', 'organization', 'organisation', 'account', 'company'],
  linkedin_url: ['linkedin url', 'linkedin profile', 'linkedin'],
};

/**
 * Splits CSV text into rows. Handles quoted fields, embedded commas, quotes
 * escaped by doubling, CRLF line endings and a leading byte order mark.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop blank lines
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Guesses which column holds which field. A column is used once. */
export function detectColumns(headers: string[]): Partial<Record<ImportField, number>> {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const used = new Set<number>();
  const out: Partial<Record<ImportField, number>> = {};
  for (const field of IMPORT_FIELDS) {
    for (const hint of HINTS[field]) {
      const exact = lower.findIndex((h, i) => !used.has(i) && h === hint);
      const idx = exact >= 0 ? exact : lower.findIndex((h, i) => !used.has(i) && h.includes(hint));
      if (idx >= 0) { out[field] = idx; used.add(idx); break; }
    }
  }
  return out;
}

export type ImportRow = Partial<Record<ImportField, string>>;

/** Builds the rows to send, from the data rows and the chosen column mapping. */
export function buildRows(dataRows: string[][], mapping: Partial<Record<ImportField, number>>): ImportRow[] {
  return dataRows.slice(0, MAX_ROWS).map((cells) => {
    const row: ImportRow = {};
    for (const field of IMPORT_FIELDS) {
      const i = mapping[field];
      const v = i === undefined ? '' : (cells[i] ?? '').trim();
      if (v) row[field] = v.slice(0, 300);
    }
    return row;
  });
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[A-Za-z]{2,}$/;
const PHONE = /^\+?[0-9]{7,15}$/;
const LINKEDIN = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i;

/** True when the row has at least one contact the agents could actually use. */
export function isUsable(row: ImportRow): boolean {
  const phone = (row.phone ?? '').replace(/[^0-9+]/g, '');
  return EMAIL.test((row.email ?? '').trim().toLowerCase()) || PHONE.test(phone) || LINKEDIN.test((row.linkedin_url ?? '').trim());
}

/** What the preview shows before anything is imported. */
export function previewCounts(rows: ImportRow[]): { total: number; usable: number; unusable: number } {
  const usable = rows.filter(isUsable).length;
  return { total: rows.length, usable, unusable: rows.length - usable };
}

export function describeImport(r: { added: number; duplicates: number; suppressed: number; invalid: number }): string {
  const parts = [`${r.added} ${r.added === 1 ? 'lead' : 'leads'} added`];
  if (r.duplicates) parts.push(`${r.duplicates} already here`);
  if (r.suppressed) parts.push(`${r.suppressed} on the suppression list`);
  if (r.invalid) parts.push(`${r.invalid} without a usable contact`);
  return `${parts.join(', ')}.`;
}
