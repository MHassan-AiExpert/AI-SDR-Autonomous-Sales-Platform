import { describe, test, expect } from 'vitest';
import { THEME_COOKIE, accentText, readTheme, safeBack } from '@/lib/theme';

describe('theme and accent', () => {
  test('THM-01 only "dark" and "light" are accepted from the theme cookie', () => {
    expect(THEME_COOKIE).toBe('theme');
    expect(readTheme('dark')).toBe('dark');
    expect(readTheme('light')).toBe('light');
    for (const bad of [undefined, '', 'Dark', 'system', '<script>', 'dark;']) expect(readTheme(bad)).toBeNull();
  });

  test('THM-02 text on accent buttons uses whichever colour is easier to read', () => {
    expect(accentText('#e0b878')).toBe('#1a1408');
    expect(accentText('#f5f5f5')).toBe('#1a1408');
    expect(accentText('#1f4a3a')).toBe('#ffffff');
    expect(accentText('#0e7c66')).toBe('#ffffff');
    expect(accentText('not a colour')).toBe('#1a1408');
  });

  test('THM-03 the theme switch only returns to paths on this site', () => {
    expect(safeBack('/w/1/leads?q=kim')).toBe('/w/1/leads?q=kim');
    for (const bad of ['//evil.test', 'https://evil.test', '/\\evil.test', '', null, 'w/1']) expect(safeBack(bad)).toBe('/workspaces');
  });
});
