import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { brandStyle, hostBrand } from '@/lib/brand';

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
  return (
    <html lang="en">
      <body style={brandStyle(brand)}>{children}</body>
    </html>
  );
}
