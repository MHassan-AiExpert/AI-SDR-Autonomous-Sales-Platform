import { describe, expect, test } from 'vitest';
import { apiError, bearerKey, endpointSchema, keySchema, readBody, route, EVENTS, SCOPES, VERIFY_EXAMPLE } from '../src/lib/api';

const K = 'sdr_' + 'a'.repeat(64);
const ID = '0b0e5a51-6c34-4f0a-9d3e-6a2b3c4d5e6f';
const q = (s = '') => new URLSearchParams(s);

describe('WAPI public API', () => {
  test('WAPI-01 only a well-formed Bearer key is read', () => {
    expect(bearerKey(`Bearer ${K}`)).toBe(K);
    expect(bearerKey(`bearer   ${K}`)).toBe(K);
    expect(bearerKey(K)).toBeNull();
    expect(bearerKey('Bearer sdr_short')).toBeNull();
    expect(bearerKey(`Basic ${K}`)).toBeNull();
    expect(bearerKey(null)).toBeNull();
  });

  test('WAPI-02 methods and paths map to actions, passing only known query parameters', () => {
    expect(route('GET', ['leads'], q('stage=won&limit=10&evil=1'), null)).toEqual({ action: 'leads.list', args: { stage: 'won', limit: '10' } });
    expect(route('GET', ['leads', ID], q(), null)).toEqual({ action: 'leads.get', args: { id: ID } });
    expect(route('POST', ['leads'], q(), { email: 'a@b.test' })).toEqual({ action: 'leads.create', args: { email: 'a@b.test' } });
    expect(route('PATCH', ['leads', ID], q(), { stage: 'won', id: 'someone-else' })).toEqual({ action: 'leads.update', args: { stage: 'won', id: ID } });
    expect(route('GET', ['deals'], q('cursor=x&campaign_id=y'), null)).toEqual({ action: 'deals.list', args: { cursor: 'x' } });
    expect(route('GET', ['campaigns'], q('limit=5'), null)).toEqual({ action: 'campaigns.list', args: {} });
    expect(route('GET', ['meetings'], q('starts_after=2026-11-01'), null)).toEqual({ action: 'meetings.list', args: { starts_after: '2026-11-01' } });
  });

  test('WAPI-03 unknown paths and methods are refused before the database', () => {
    expect(route('GET', ['users'], q(), null)).toEqual({ status: 404, error: 'Unknown endpoint' });
    expect(route('GET', ['leads', 'not-an-id'], q(), null)).toMatchObject({ status: 404 });
    expect(route('GET', ['deals', ID], q(), null)).toMatchObject({ status: 404 });
    expect(route('GET', ['leads', ID, 'notes'], q(), null)).toMatchObject({ status: 404 });
    expect(route('POST', ['deals'], q(), {})).toEqual({ status: 405, error: 'Method not allowed' });
    expect(route('POST', ['leads', ID], q(), {})).toMatchObject({ status: 405 });
    expect(route('PATCH', ['leads'], q(), {})).toMatchObject({ status: 405 });
    expect(route('GET', [], q(), null)).toMatchObject({ status: 404 });
  });

  test('WAPI-04 bodies are JSON objects of at most 16 KB', () => {
    expect(readBody('')).toEqual({ body: {} });
    expect(readBody('{"email":"a@b.test"}')).toEqual({ body: { email: 'a@b.test' } });
    expect(readBody('[1]')).toEqual({ error: 'The request body must be a JSON object' });
    expect(readBody('nope')).toEqual({ error: 'The request body is not valid JSON' });
    expect(readBody(JSON.stringify({ x: 'a'.repeat(16_001) }))).toEqual({ error: 'The request body must be at most 16 KB' });
  });

  test('WAPI-05 database errors become HTTP statuses; internal details never leak', () => {
    expect(apiError({ code: '28000', message: 'Invalid API key' })).toEqual({ status: 401, error: 'Invalid API key' });
    expect(apiError({ code: '42501', message: 'This key does not have the leads:write scope' })).toEqual({ status: 403, error: 'This key does not have the leads:write scope' });
    expect(apiError({ code: '42501', message: 'permission denied for table leads' })).toEqual({ status: 403, error: 'This key cannot do that' });
    expect(apiError({ code: '53400', message: 'x' }).status).toBe(429);
    expect(apiError({ code: 'P0002', message: 'Not found' })).toEqual({ status: 404, error: 'Not found' });
    expect(apiError({ code: '22023', message: 'email is not a valid address' })).toEqual({ status: 422, error: 'email is not a valid address' });
    expect(apiError({ code: '22023', message: '<script>' }).error).toBe('The request is not valid');
    expect(apiError({ code: 'XX000', message: 'relation "x" does not exist at character 12' })).toEqual({ status: 500, error: 'Something went wrong. Try again shortly.' });
    expect(apiError(null).status).toBe(500);
  });

  test('WAPI-06 key and endpoint forms', () => {
    expect(keySchema.safeParse({ name: ' Zapier ', scopes: ['leads:read'] })).toMatchObject({ success: true, data: { name: 'Zapier' } });
    expect(keySchema.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
    expect(keySchema.safeParse({ name: 'x', scopes: ['admin'] }).success).toBe(false);
    expect(endpointSchema.safeParse({ url: 'https://hooks.example.com/sdr', description: '', events: ['deal.won'] }))
      .toMatchObject({ success: true, data: { description: null } });
    for (const url of ['http://hooks.example.com', 'https://hooks.example.com:8443/x', 'https://a b.com', 'javascript:alert(1)']) {
      expect(endpointSchema.safeParse({ url, description: '', events: ['deal.won'] }).success).toBe(false);
    }
    expect(endpointSchema.safeParse({ url: 'https://h.example.com', description: '', events: ['lead.deleted'] }).success).toBe(false);
    expect(SCOPES).toHaveLength(5);
    expect(EVENTS).toHaveLength(6);
  });

  test('WAPI-07 the verification example uses a constant-time comparison and a five-minute window', () => {
    expect(VERIFY_EXAMPLE).toContain('timingSafeEqual');
    expect(VERIFY_EXAMPLE).toContain('> 300');
    expect(VERIFY_EXAMPLE).toContain('`${t}.${rawBody}`');
  });
});
