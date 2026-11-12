import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AI SDR Platform', template: '%s · AI SDR Platform' },
  description: 'Autonomous AI sales development: find leads, run outreach on every channel, book meetings and close deals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
