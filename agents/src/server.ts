// HTTP entry point. The scheduler (n8n) calls POST /jobs/run every minute,
// signed with the shared HMAC secret. GET /health is for uptime monitors.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Deps } from './jobs.ts';
import { runQueuedJobs } from './jobs.ts';
import { log } from './log.ts';
import { ingestInstantlyEvent } from './webhooks.ts';
import { handleCalendlyEvent } from './booking.ts';
import { handleVapiEvent } from './voice.ts';
import { handleTwilioEvent } from './texting.ts';
import { handleStripeEvent } from './closer.ts';

const MAX_SKEW_SECONDS = 300;

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d{10}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(sign(secret, timestamp, body), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

async function readBody(req: IncomingMessage, max = 16_384): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type ServerOptions = { hmacSecret: string; jobsPerRun: number; healthCheck: () => Promise<void> };

export function createAgentServer(deps: Deps, options: ServerOptions): Server {
  let running = false;
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') {
        try {
          await options.healthCheck();
          return send(200, { status: 'ok' });
        } catch {
          return send(503, { status: 'database unavailable' });
        }
      }
      // Readiness: the database answers and the queue is moving (SRS 10.4)
      if (req.method === 'GET' && req.url === '/ready') {
        try {
          const q = await deps.store.queueHealth();
          const ok = q.stuck === 0;
          return send(ok ? 200 : 503, { status: ok ? 'ready' : 'queue backlog', queued: q.queued, stuck: q.stuck, oldest_minutes: q.oldestMinutes });
        } catch {
          return send(503, { status: 'database unavailable' });
        }
      }
      if (req.method === 'POST' && req.url === '/jobs/run') {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return send(413, { error: 'Request too large' });
        }
        const ok = verifySignature(options.hmacSecret, header(req, 'x-timestamp'), header(req, 'x-signature'), body);
        if (!ok) return send(401, { error: 'Invalid signature' });
        // One run at a time per process; the scheduler simply tries again next minute
        if (running) return send(202, { status: 'busy' });
        running = true;
        try {
          const jobs = await runQueuedJobs(deps, options.jobsPerRun);
          return send(200, { status: 'ok', jobs });
        } finally {
          running = false;
        }
      }
      if (req.method === 'POST' && req.url === '/webhooks/instantly') {
        let body: string;
        try {
          body = await readBody(req, 512_000);
        } catch {
          return send(413, { error: 'Request too large' });
        }
        if (!verifySignature(options.hmacSecret, header(req, 'x-timestamp'), header(req, 'x-signature'), body)) return send(401, { error: 'Invalid signature' });
        let parsed: { token?: unknown; event?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid JSON' });
        }
        const result = await ingestInstantlyEvent(deps.store, parsed.token, parsed.event);
        // Unknown addresses get the same answer as a bad signature, so tokens cannot be probed
        if (result.status === 'unknown_workspace') return send(404, { error: 'Not found' });
        return send(200, { status: result.status });
      }
      if (req.method === 'POST' && req.url === '/webhooks/vapi') {
        let body: string;
        try {
          body = await readBody(req, 2_000_000);
        } catch {
          return send(413, { error: 'Request too large' });
        }
        if (!verifySignature(options.hmacSecret, header(req, 'x-timestamp'), header(req, 'x-signature'), body)) return send(401, { error: 'Invalid signature' });
        let parsed: { token?: unknown; event?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid JSON' });
        }
        const result = await handleVapiEvent({ store: deps.store, fetchImpl: deps.fetchImpl, appUrl: deps.appUrl, webhookBaseUrl: deps.webhookBaseUrl, voiceModel: deps.voiceModel }, parsed.token, parsed.event);
        if (result.status === 'unknown_workspace') return send(404, { error: 'Not found' });
        // Vapi's assistant-request expects the assistant in the response body
        return send(200, result.response ?? { status: result.status });
      }
      if (req.method === 'POST' && req.url === '/webhooks/twilio') {
        let body: string;
        try {
          body = await readBody(req, 128_000);
        } catch {
          return send(413, { error: 'Request too large' });
        }
        if (!verifySignature(options.hmacSecret, header(req, 'x-timestamp'), header(req, 'x-signature'), body)) return send(401, { error: 'Invalid signature' });
        let parsed: { token?: unknown; raw?: unknown; signature?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid JSON' });
        }
        const result = await handleTwilioEvent({ store: deps.store, webhookBaseUrl: deps.webhookBaseUrl }, parsed.token, parsed.raw, parsed.signature);
        if (result.status === 'unknown_workspace') return send(404, { error: 'Not found' });
        if (result.status === 'bad_signature') return send(401, { error: 'Invalid Twilio signature' });
        return send(200, { status: result.status });
      }
      if (req.method === 'POST' && req.url === '/webhooks/stripe') {
        let body: string;
        try {
          body = await readBody(req, 600_000);
        } catch {
          return send(413, { error: 'Request too large' });
        }
        if (!verifySignature(options.hmacSecret, header(req, 'x-timestamp'), header(req, 'x-signature'), body)) return send(401, { error: 'Invalid signature' });
        let parsed: { token?: unknown; raw?: unknown; signature?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid JSON' });
        }
        const result = await handleStripeEvent({ store: deps.store, fetchImpl: deps.fetchImpl, appUrl: deps.appUrl }, parsed.token, parsed.raw, parsed.signature);
        if (result.status === 'unknown_workspace') return send(404, { error: 'Not found' });
        if (result.status === 'bad_signature') return send(401, { error: 'Invalid Stripe signature' });
        return send(200, { status: result.status });
      }
      if (req.method === 'POST' && req.url === '/webhooks/calendly') {
        let body: string;
        try {
          body = await readBody(req, 256_000);
        } catch {
          return send(413, { error: 'Request too large' });
        }
        if (!verifySignature(options.hmacSecret, header(req, 'x-timestamp'), header(req, 'x-signature'), body)) return send(401, { error: 'Invalid signature' });
        let parsed: { token?: unknown; raw?: unknown; signature?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid JSON' });
        }
        const result = await handleCalendlyEvent(
          { store: deps.store, fetchImpl: deps.fetchImpl, appUrl: deps.appUrl, webhookBaseUrl: deps.webhookBaseUrl },
          parsed.token, parsed.raw, parsed.signature);
        if (result.status === 'unknown_workspace') return send(404, { error: 'Not found' });
        if (result.status === 'bad_signature') return send(401, { error: 'Invalid Calendly signature' });
        return send(200, { status: result.status });
      }
      return send(404, { error: 'Not found' });
    } catch (err) {
      log('error', 'request failed', { path: req.url, error: err instanceof Error ? err.message : 'unknown' });
      return send(500, { error: 'Internal error' });
    }
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
