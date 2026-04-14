// Local HTTP proxy for `hookmyapp sandbox listen`.
//
// Pipeline: cloudflared (token-mode) → CF edge → PUT-configured ingress rule →
//           http://127.0.0.1:<this-port> → forwards to dev's real localhost:<upstreamPort>.
//
// CRITICAL: bind 127.0.0.1 ONLY (not 0.0.0.0). See RESEARCH §Pitfall 9 —
// binding to 0.0.0.0 exposes the proxy to the LAN where scanners can race
// the free-port assignment between `listen()` and the backend's
// `PUT /configurations` call.

import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  ServerResponse,
  OutgoingHttpHeaders,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { summarize } from './summarizer.js';

export interface LogLine {
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  summary: string;
}

export interface StartProxyOptions {
  upstreamPort: number;
  upstreamPath: string;
  onRequest: (line: LogLine) => void;
}

export interface ProxyHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startProxyServer(opts: StartProxyOptions): Promise<ProxyHandle> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const summary = summarize(body);

      // Sanitise headers for upstream: drop hop-by-hop; Node's http.request will
      // supply its own host header.
      const forwardHeaders: OutgoingHttpHeaders = { ...req.headers };
      delete forwardHeaders['host'];
      delete forwardHeaders['content-length'];
      // Let Node compute content-length from the body we write below.

      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: opts.upstreamPort,
          path: opts.upstreamPath,
          method: req.method ?? 'POST',
          headers: forwardHeaders,
        },
        (upRes) => {
          const status = upRes.statusCode ?? 502;
          // Mirror upstream status + headers to our caller verbatim.
          res.writeHead(status, upRes.headers);
          upRes.pipe(res);
          upRes.on('end', () => {
            opts.onRequest({
              ts: new Date().toISOString().slice(11, 19),
              method: req.method ?? 'POST',
              path: opts.upstreamPath,
              status,
              ms: Date.now() - start,
              summary,
            });
          });
        },
      );

      upstream.on('error', () => {
        // Upstream dev server unreachable → synthesize 502.
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end('upstream unreachable');
        opts.onRequest({
          ts: new Date().toISOString().slice(11, 19),
          method: req.method ?? 'POST',
          path: opts.upstreamPath,
          status: 502,
          ms: Date.now() - start,
          summary,
        });
      });

      upstream.write(body);
      upstream.end();
    });

    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });

  // 0 = OS-assigned free port; 127.0.0.1 = loopback only (Pitfall 9).
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
