import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { startProxyServer, LogLine } from '../../commands/sandbox-listen/proxy-server.js';

async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  port: number;
  server: Server;
}> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { port, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
}

describe('startProxyServer', () => {
  let proxyClose: (() => Promise<void>) | null = null;
  let upstream: { port: number; server: Server } | null = null;

  beforeEach(() => {
    proxyClose = null;
    upstream = null;
  });

  afterEach(async () => {
    if (proxyClose) await proxyClose();
    if (upstream) await closeServer(upstream.server);
  });

  it('binds an OS-assigned port on 127.0.0.1', async () => {
    upstream = await startUpstream((_req, res) => res.end('ok'));
    const onRequest = vi.fn();
    const server = await startProxyServer({
      upstreamPort: upstream.port,
      upstreamPath: '/webhook',
      onRequest,
    });
    proxyClose = server.close;
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(upstream.port);
  });

  it('forwards request body bytes verbatim to upstream', async () => {
    let receivedBody = '';
    upstream = await startUpstream((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.end('received');
      });
    });
    const onRequest = vi.fn();
    const server = await startProxyServer({
      upstreamPort: upstream.port,
      upstreamPath: '/webhook',
      onRequest,
    });
    proxyClose = server.close;

    const payload = JSON.stringify({ hello: 'world' });
    const res = await fetch(`http://127.0.0.1:${server.port}/anything`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(receivedBody).toBe(payload);
  });

  it('invokes onRequest callback with { ts, method, path, status, ms, summary }', async () => {
    upstream = await startUpstream((_req, res) => {
      res.statusCode = 201;
      res.end('created');
    });
    const onRequest = vi.fn();
    const server = await startProxyServer({
      upstreamPort: upstream.port,
      upstreamPath: '/webhook',
      onRequest,
    });
    proxyClose = server.close;

    await fetch(`http://127.0.0.1:${server.port}/webhook`, {
      method: 'POST',
      body: JSON.stringify({ x: 1 }),
    });

    // onRequest fires AFTER upstream responds; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(onRequest).toHaveBeenCalledOnce();
    const line = onRequest.mock.calls[0][0] as LogLine;
    expect(line.method).toBe('POST');
    expect(line.path).toBe('/webhook');
    expect(line.status).toBe(201);
    expect(typeof line.ts).toBe('string');
    expect(typeof line.ms).toBe('number');
    expect(typeof line.summary).toBe('string');
  });

  it('returns 502 when upstream connect fails', async () => {
    // Point upstream at a port where nothing is listening.
    const onRequest = vi.fn();
    const server = await startProxyServer({
      upstreamPort: 1, // privileged port, no listener — connection refused
      upstreamPath: '/webhook',
      onRequest,
    });
    proxyClose = server.close;

    const res = await fetch(`http://127.0.0.1:${server.port}/webhook`, {
      method: 'POST',
      body: 'ping',
    });
    expect(res.status).toBe(502);
  });
});
