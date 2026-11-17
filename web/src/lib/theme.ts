// Appearance: the dark/light choice each person makes, and readable text on
// the accent colour (the platform's brass or an agency's own colour).

export const THEME_COOKIE = 'theme';
export type Theme = 'dark' | 'light';

/** The theme someone chose, or null to follow their device's setting. */
export function readTheme(value: string | undefined | null): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

const DARK_TEXT = '#1a1408';
const LIGHT_TEXT = '#ffffff';

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Dark or white text, whichever reads better on the given accent colour. */
export function accentText(hex: string): typeof DARK_TEXT | typeof LIGHT_TEXT {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return DARK_TEXT;
  const bg = luminance(hex);
  return contrast(bg, luminance(DARK_TEXT)) >= contrast(bg, 1) ? DARK_TEXT : LIGHT_TEXT;
}

/** A path on this site to return to after switching theme; never another site. */
export function safeBack(path: string | null | undefined): string {
  return typeof path === 'string' && /^\/(?![/\\])/.test(path) && path.length <= 2000 ? path : '/workspaces';
}
