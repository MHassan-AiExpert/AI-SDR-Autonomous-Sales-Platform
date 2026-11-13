// White-label brand: the agency's app name, logo and colour replace the
// platform's own on every page its clients see.

import { cache } from 'react';
import { headers } from 'next/headers';
import { z } from 'zod';
import { createClient } from './supabase/server';

export type Brand = { app_name: string; logo_url: string | null; primary_color: string | null; support_email: string | null };

export const DEFAULT_BRAND: Brand = { app_name: 'AI SDR Platform', logo_url: null, primary_color: null, support_email: null };

const brandSchema = z.object({
  app_name: z.string().min(1).max(60),
  logo_url: z.string().regex(/^https:\/\/[^\s"<>]+$/).max(500).nullable(),
  primary_color: z.string().regex(/^#[0-9a-f]{6}$/).nullable(),
  support_email: z.string().max(270).nullable(),
});

/** A brand row from the database, or the platform's own brand when it is missing or malformed. */
export function readBrand(raw: unknown): Brand {
  if (!raw || typeof raw !== 'object') return DEFAULT_BRAND;
  const r = raw as Record<string, unknown>;
  const parsed = brandSchema.safeParse({ app_name: r.app_name, logo_url: r.logo_url ?? null, primary_color: r.primary_color ?? null, support_email: r.support_email ?? null });
  return parsed.success ? parsed.data : DEFAULT_BRAND;
}

/** "App.Agency.com:443" to "app.agency.com"; null for anything that is not a host name. */
export function normalizeHost(host: string | null | undefined): string | null {
  const h = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9.-]{1,253}$/.test(h) && h.includes('.') ? h : null;
}

/** The brand for the domain the page was opened on (custom domains of agencies). */
export const hostBrand = cache(async (): Promise<Brand> => {
  const host = normalizeHost((await headers()).get('host'));
  if (!host) return DEFAULT_BRAND;
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc('brand_for_host', { p_host: host });
    return data ? readBrand(data) : DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
});

/** The brand of a workspace's agency, falling back to the domain's brand. */
export const workspaceBrand = cache(async (workspaceId: string): Promise<Brand> => {
  const supabase = await createClient();
  const { data: ws } = await supabase.from('workspaces').select('agency_id').eq('id', workspaceId).maybeSingle();
  if (ws?.agency_id) {
    const { data } = await supabase.from('agency_brands').select('app_name, logo_url, primary_color, support_email').eq('agency_id', ws.agency_id).maybeSingle();
    if (data) return readBrand(data);
  }
  return hostBrand();
});

/** Inline style that applies the brand colour to buttons and links. */
export function brandStyle(b: Brand): Record<string, string> | undefined {
  return b.primary_color ? { ['--accent' as string]: b.primary_color } : undefined;
}
