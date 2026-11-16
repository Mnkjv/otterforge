// Otterforge: a GitHub-compatible git forge in a single Node process.
// One in-memory store serves four surfaces: git smart HTTP (clone, fetch,
// push), the REST v3 API, the GraphQL v4 API, and an MCP endpoint.
// Standard library only; no state ever leaves the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitRequest } from './src/githttp.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type Ctx } from './src/rest.ts';
import { Forge } from './src/store.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function notFound(res: ServerResponse, requestId: string): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'content-length': body.length,
  });
  res.end(body);
}

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'otterforge-test-token';
  const forge = new Forge(token);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const host = req.headers.host ?? 'localhost';
      const ctx: Ctx = { forge, req, base: `http://${host}` };
      try {
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = url.pathname;

        if (path === '/healthz' && req.method === 'GET') {
          const body = Buffer.from('{"ok":true}', 'utf8');
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
          res.end(body);
          return;
        }

        const gitMatch = GIT_PATH.exec(path);
        if (gitMatch !== null) {
          await handleGitRequest(forge, req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3], url.searchParams);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(ctx, req, res, url);
          return;
        }

        if (path === '/api/graphql' && req.method === 'POST') {
          await handleGraphQL(ctx, req, res);
          return;
        }

        if (path === '/mcp') {
          await handleMcp(ctx, req, res);
          return;
        }

        notFound(res, forge.nextRequestId());
      } catch (err) {
        // A single bad request must never take the forge down.
        process.stderr.write(`[otterforge] ${req.method} ${req.url}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) {
          const body = Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8');
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
          res.end(body);
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
