import { describe, test, expect } from 'vitest';
import { buildRows, describeImport, detectColumns, isUsable, parseCsv, previewCounts } from '@/lib/csv';

describe('CSV parsing', () => {
  test('WCSV-01 quoted fields, embedded commas, escaped quotes, CRLF and a BOM', () => {
    const text = '﻿name,email,notes\r\n"Lee, Kim",kim@b.test,"He said ""yes"" twice"\r\nSam,sam@a.test,plain\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'email', 'notes'],
      ['Lee, Kim', 'kim@b.test', 'He said "yes" twice'],
      ['Sam', 'sam@a.test', 'plain'],
    ]);
  });

  test('WCSV-02 blank lines are dropped and a file without a trailing newline still parses', () => {
    expect(parseCsv('a,b\n\n1,2\n\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseCsv('')).toEqual([]);
  });

  test('WCSV-03 columns are detected from the spellings real exports use, each used once', () => {
    expect(detectColumns(['Full Name', 'Work Email', 'Mobile', 'Job Title', 'Company Name', 'LinkedIn URL']))
      .toEqual({ full_name: 0, email: 1, phone: 2, title: 3, company: 4, linkedin_url: 5 });
    // "Email Address" is preferred over a column merely containing "email"
    expect(detectColumns(['Email Status', 'Email Address']).email).toBe(1);
    expect(detectColumns(['something', 'unrelated'])).toEqual({});
  });

  test('WCSV-04 rows are built from the mapping, trimmed, and unmapped fields left out', () => {
    const rows = buildRows([['  Kim Lee ', 'KIM@B.test', ''], ['Sam', 'sam@a.test', '+1 512 555 0100']], { full_name: 0, email: 1, phone: 2 });
    expect(rows).toEqual([{ full_name: 'Kim Lee', email: 'KIM@B.test' }, { full_name: 'Sam', email: 'sam@a.test', phone: '+1 512 555 0100' }]);
  });

  test('WCSV-05 a row is usable with an email, a phone or a LinkedIn URL, and not otherwise', () => {
    expect(isUsable({ email: 'kim@bright.test' })).toBe(true);
    expect(isUsable({ phone: '(512) 555-0100' })).toBe(true);
    expect(isUsable({ linkedin_url: 'https://www.linkedin.com/in/kim' })).toBe(true);
    expect(isUsable({ email: 'not-an-email', phone: '123', linkedin_url: 'https://example.com/in/x' })).toBe(false);
    expect(isUsable({ full_name: 'Nobody' })).toBe(false);
    expect(previewCounts([{ email: 'a@b.test' }, { full_name: 'x' }])).toEqual({ total: 2, usable: 1, unusable: 1 });
  });

  test('WCSV-06 the result is described in plain words, mentioning only what happened', () => {
    expect(describeImport({ added: 98, duplicates: 15, suppressed: 7, invalid: 3 }))
      .toBe('98 leads added, 15 already here, 7 on the suppression list, 3 without a usable contact.');
    expect(describeImport({ added: 1, duplicates: 0, suppressed: 0, invalid: 0 })).toBe('1 lead added.');
    expect(describeImport({ added: 0, duplicates: 4, suppressed: 0, invalid: 0 })).toBe('0 leads added, 4 already here.');
  });
});
