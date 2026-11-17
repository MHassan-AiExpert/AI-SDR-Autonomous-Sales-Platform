import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource-variable/plus-jakarta-sans/index.css';
import './globals.css';
import { brandStyle, hostBrand } from '@/lib/brand';
import { THEME_COOKIE, readTheme } from '@/lib/theme';

// On an agency's own domain every title carries the agency's app name
export async function generateMetadata(): Promise<Metadata> {
  const brand = await hostBrand();
  return {
    title: { default: brand.app_name, template: `%s · ${brand.app_name}` },
    description: 'Autonomous AI sales development: find leads, run outreach on every channel, book meetings and close deals.',
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const brand = await hostBrand();
  // The theme someone picked is applied on the server, so pages never flash the wrong one
  const theme = readTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme ?? undefined}>
      <body style={brandStyle(brand)}>{children}</body>
    </html>
  );
}
