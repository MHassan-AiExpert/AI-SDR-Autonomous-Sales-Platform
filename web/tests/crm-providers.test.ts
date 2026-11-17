import { describe, test, expect } from 'vitest';
import {
  CONNECT_HELP, CRM_PROVIDERS, DEFAULT_STAGES, PIPELINE_HELP, asProvider, crmSwitched, describeCrmSync, mappedStages, parseCrmForm, savedStage,
} from '@/lib/crm';
import { PROBES, testConnection } from '@/lib/connection-tests';
import { SALESFORCE_DOMAIN, TOOLS, buildOnboardingPlan, parseCredentials, salesforceHost } from '@/lib/integrations';

const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, x] of Object.entries({ crm_sync_enabled: 'on', crm_sync_scope: 'engaged', crm_pipeline_id: 'default', ...v })) f.set(k, x);
  return f;
};

describe('WCRP CRM choice', () => {
  test('WCRP-01 Pipedrive settings: pipeline and stage numbers, no won or lost stage', () => {
    const r = parseCrmForm(form({ crm_provider: 'pipedrive', crm_provider_was: 'pipedrive', crm_pipeline_id: '4', stage_proposal_sent: '12', stage_won: 'ignored' }));
    expect(r.success && r.data).toEqual({ crm_sync_enabled: true, crm_provider: 'pipedrive', crm_sync_scope: 'engaged', crm_pipeline_id: '4', crm_stage_map: { proposal_sent: '12' } });
    const bad = parseCrmForm(form({ crm_provider: 'pipedrive', crm_provider_was: 'pipedrive', stage_negotiation: 'Negotiation' }));
    expect(!bad.success && bad.error.issues[0].message).toBe('The Pipedrive stage for Negotiation must be a Pipedrive stage number.');
    const pipe = parseCrmForm(form({ crm_provider: 'pipedrive', crm_provider_was: 'pipedrive', crm_pipeline_id: 'sales' }));
    expect(!pipe.success && pipe.error.issues[0].message).toBe('The Pipedrive pipeline must be its number, or blank for the default pipeline.');
    const dup = parseCrmForm(form({ crm_provider: 'pipedrive', crm_provider_was: 'pipedrive', stage_meeting_booked: '3', stage_meeting_held: '3' }));
    expect(!dup.success && dup.error.issues[0].message).toBe('Each of your stages needs its own Pipedrive stage.');
    expect(mappedStages('pipedrive')).toEqual(['meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation']);
  });

  test('WCRP-02 Salesforce settings: stage names with spaces and slashes, defaults not stored', () => {
    const r = parseCrmForm(form({ crm_provider: 'salesforce', crm_provider_was: 'salesforce', stage_proposal_sent: 'Proposal/Price Quote', stage_negotiation: 'Contract Review' }));
    expect(r.success && r.data.crm_stage_map).toEqual({ negotiation: 'Contract Review' });
    const bad = parseCrmForm(form({ crm_provider: 'salesforce', crm_provider_was: 'salesforce', stage_won: 'Won"><script>' }));
    expect(!bad.success && bad.error.issues[0].message).toContain('without quotes or angle brackets');
    expect(savedStage({ won: 'Signed' }, 'won', 'salesforce')).toBe('Signed');
    expect(savedStage({}, 'meeting_booked', 'salesforce')).toBe(DEFAULT_STAGES.salesforce.meeting_booked);
  });

  test('WCRP-03 choosing another CRM resets the pipeline and stages instead of rejecting the old ones', () => {
    const f = form({ crm_provider: 'pipedrive', crm_provider_was: 'hubspot', crm_pipeline_id: 'default', stage_won: 'closedwon', stage_meeting_booked: 'appointmentscheduled' });
    expect(crmSwitched(f)).toBe(true);
    const r = parseCrmForm(f);
    expect(r.success && r.data).toMatchObject({ crm_provider: 'pipedrive', crm_pipeline_id: 'default', crm_stage_map: {} });
    expect(parseCrmForm(form({ crm_provider: 'zoho' })).success).toBe(false);
    expect(asProvider('salesforce')).toBe('salesforce');
    expect(asProvider('zoho')).toBe('hubspot');
  });

  test('WCRP-04 every CRM has its help text, and results name the CRM', () => {
    for (const p of CRM_PROVIDERS) { expect(CONNECT_HELP[p]).toBeTruthy(); expect(PIPELINE_HELP[p]).toBeTruthy(); }
    expect(describeCrmSync({ crm: 'Pipedrive', contacts_sent: 0 })).toBe('Pipedrive is up to date.');
    expect(describeCrmSync({ crm: 'Salesforce', closed_from_crm: 1, rate_limited: true })).toBe('1 deal closed from Salesforce. Salesforce asked to slow down; the rest syncs next hour.');
    expect(describeCrmSync({ crm: '<b>x</b>', contacts_sent: 0 })).toBe('HubSpot is up to date.');
  });

  test('WCRP-05 Salesforce credentials: only a My Domain host, and the consumer secret stays secret', () => {
    for (const ok of ['acme.my.salesforce.com', 'https://acme.my.salesforce.com/', 'acme--uat.sandbox.my.salesforce.com']) expect(SALESFORCE_DOMAIN.test(ok)).toBe(true);
    for (const bad of ['acme.lightning.force.com', 'evil.com', 'acme.my.salesforce.com.evil.com', 'https://evil.com/?acme.my.salesforce.com']) expect(SALESFORCE_DOMAIN.test(bad)).toBe(false);
    expect(salesforceHost('https://Acme.my.salesforce.com/')).toBe('acme.my.salesforce.com');
    const f = new FormData();
    f.set('domain', 'acme.my.salesforce.com'); f.set('client_id', '3MVG9-consumer-key'); f.set('client_secret', 'SECRETconsumer99');
    const r = parseCredentials(TOOLS.salesforce, f);
    expect(r.ok && r.value.meta).toEqual({ domain: 'acme.my.salesforce.com', client_id: '3MVG9-consumer-key', hint: '•••• er99' });
  });

  test('WCRP-06 the Salesforce check signs in with client credentials; a 400 means rejected', async () => {
    const calls: [string, RequestInit][] = [];
    const ok = (async (u: string, i: RequestInit) => { calls.push([u, i]); return new Response('{"access_token":"t"}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await testConnection('salesforce', { domain: 'https://acme.my.salesforce.com', client_id: 'cid12345', client_secret: 'sec12345' }, ok)).toEqual({ ok: true });
    expect(calls[0][0]).toBe('https://acme.my.salesforce.com/services/oauth2/token');
    expect(calls[0][1].method).toBe('POST');
    expect(String(calls[0][1].body)).toBe('grant_type=client_credentials&client_id=cid12345&client_secret=sec12345');
    const no = (async () => new Response('{"error":"invalid_client"}', { status: 400 })) as unknown as typeof fetch;
    expect(await testConnection('salesforce', { domain: 'acme.my.salesforce.com', client_id: 'cid12345', client_secret: 'bad' }, no)).toEqual({ ok: false, error: 'Salesforce rejected these credentials.' });
    const empty = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect((await testConnection('salesforce', { domain: 'acme.my.salesforce.com', client_id: 'c', client_secret: 's' }, empty)).ok).toBe(false);
  });

  test('WCRP-07 the Pipedrive check sends the token in a header to Pipedrive only', async () => {
    const calls: [string, RequestInit][] = [];
    const ok = (async (u: string, i: RequestInit) => { calls.push([u, i]); return new Response('{"success":true,"data":{"id":1}}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await testConnection('pipedrive', { api_token: 'pdtoken0123456789abcdef' }, ok)).toEqual({ ok: true });
    expect(calls[0][0]).toBe('https://api.pipedrive.com/v1/users/me');
    expect((calls[0][1].headers as Record<string, string>)['x-api-token']).toBe('pdtoken0123456789abcdef');
    expect(PROBES.pipedrive.url({ api_token: 'x' })).not.toContain('x-api');
  });

  test('WCRP-08 Setup offers all three CRMs, still optional', () => {
    const plan = buildOnboardingPlan({ enabledChannels: { email: true }, aiCloserEnabled: false, statuses: { pipedrive: 'connected' }, checklist: {} } as never);
    const step = plan.steps.find((s) => s.id === 'crm')!;
    expect(step.tools).toEqual(['hubspot', 'pipedrive', 'salesforce']);
    expect(step).toMatchObject({ required: false, done: true });
  });
});
