// MCP endpoint: JSON-RPC over POST /mcp. Speaks the modern protocol
// revision (server/discover, stateless) and the legacy initialize
// handshake. Tools mirror the github-mcp-server surface the suite maps,
// and every tool works on the same store as REST and GraphQL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getObject, parseCommit, flattenTree, putObject } from './gitcore.ts';
import { readBody } from './githttp.ts';
import { performMerge } from './merge.ts';
import { issueObject, pullObject, repoObject, type Ctx } from './rest.ts';
import type { Forge, Repo } from './store.ts';

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'otterforge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (ctx: Ctx, repo: Repo | null, args: Record<string, unknown>) => unknown;
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: false };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function needRepo(ctx: Ctx, args: Record<string, unknown>): Repo {
  const owner = argStr(args, 'owner') ?? '';
  const name = argStr(args, 'repo') ?? '';
  const repo = ctx.forge.repoFor(owner, name);
  if (repo === undefined) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (ctx, _repo, args) => {
      const name = argStr(args, 'name') as string;
      if (ctx.forge.viewerRepos().some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('name already exists on this account');
      }
      const repo = ctx.forge.createRepo({ name, description: argStr(args, 'description'), isPrivate: args.private === true });
      return repoObject(ctx, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
    run: (ctx, repo) => repoObject(ctx, repo as Repo),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
    },
    required: ['owner', 'repo', 'title'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) if (!target.labels.has(name)) throw new Error(`label '${name}' was not found`);
      const issue = ctx.forge.createIssue(target, { title: argStr(args, 'title') as string, body: argStr(args, 'body'), labels });
      return issueObject(ctx, target, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' },
    },
    required: ['owner', 'repo'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const state = argStr(args, 'state') ?? 'open';
      let items = [...target.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      return items.map((i) => issueObject(ctx, target, i));
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      issue_number: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const issue = target.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new Error('issue not found');
      return issueObject(ctx, target, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch' },
      base: { type: 'string', description: 'Base branch' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const headRaw = argStr(args, 'head') as string;
      const baseRaw = argStr(args, 'base') as string;
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
      if (target.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`head branch '${head}' does not exist`);
      if (target.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`base branch '${base}' does not exist`);
      if (ctx.forge.openPullFor(target, head, base) !== undefined) throw new Error('a pull request already exists for this head and base');
      const pull = ctx.forge.createPull(target, { title: argStr(args, 'title') as string, body: argStr(args, 'body'), headRef: head, baseRef: base });
      return pullObject(ctx, target, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
    },
    required: ['owner', 'repo'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const state = argStr(args, 'state') ?? 'open';
      let items = [...target.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      return items.map((p) => pullObject(ctx, target, p));
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a single pull request by number.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const pull = target.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error('pull request not found');
      return pullObject(ctx, target, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      pull_number: { type: 'number', description: 'Pull request number' },
      merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const pull = target.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error('pull request not found');
      const raw = argStr(args, 'merge_method') ?? 'squash';
      const outcome = performMerge(ctx.forge, target, pull, raw === 'merge' ? 'merge' : raw === 'rebase' ? 'rebase' : 'squash');
      if (outcome === null) throw new Error('pull request is not mergeable');
      return { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
  {
    name: 'create_branch',
    description: 'Create a new branch from another branch.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      branch: { type: 'string', description: 'New branch name' },
      from_branch: { type: 'string', description: 'Source branch name' },
    },
    required: ['owner', 'repo', 'branch'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const branch = argStr(args, 'branch') as string;
      const from = argStr(args, 'from_branch') ?? target.defaultBranch;
      const sha = target.refs.get(`refs/heads/${from}`);
      if (sha === undefined) throw new Error(`branch '${from}' not found`);
      if (target.refs.has(`refs/heads/${branch}`)) throw new Error('reference already exists');
      target.refs.set(`refs/heads/${branch}`, sha);
      return { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } };
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get the contents of a file or directory from a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string', description: 'File path' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['owner', 'repo', 'path'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const path = argStr(args, 'path') as string;
      const branch = argStr(args, 'branch') ?? target.defaultBranch;
      const tip = target.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) throw new Error('branch not found');
      const tree = parseCommit((getObject(target.objects, tip) as { data: Buffer }).data).tree;
      const flat = flattenTree(target.objects, tree);
      const entry = flat.get(path);
      if (entry === undefined) throw new Error('path not found');
      const data = getObject(target.objects, entry.oid)?.data ?? Buffer.alloc(0);
      return { type: 'file', name: path.split('/').pop(), path, sha: entry.oid, size: data.length, encoding: 'base64', content: data.toString('base64') };
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update a file in a repository.',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string' },
      content: { type: 'string', description: 'File content (plain text)' },
      message: { type: 'string', description: 'Commit message' },
      branch: { type: 'string', description: 'Branch name' },
      sha: { type: 'string', description: 'Blob SHA when updating' },
    },
    required: ['owner', 'repo', 'path', 'content', 'message', 'branch'],
    run: (ctx, repo, args) => {
      const target = repo as Repo;
      const path = argStr(args, 'path') as string;
      const branch = argStr(args, 'branch') as string;
      const blobOid = putObject(target.objects, 'blob', Buffer.from(argStr(args, 'content') as string, 'utf8'));
      const result = ctx.forge.commitFileChange(target, branch, path, blobOid, argStr(args, 'message') as string);
      if (result === null) throw new Error(`branch '${branch}' not found`);
      return { content: { path, sha: blobOid }, commit: { sha: result.commitOid } };
    },
  },
];

/** The static tools/list payload: built once so two calls are byte-identical. */
const TOOLS_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

// ---------------------------------------------------------------- handler

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const forge: Forge = ctx.forge;
  const sendJson = (status: number, value: unknown): void => {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
  };
  if (req.method !== 'POST') {
    sendJson(405, rpcError(null, -32601, 'Method not allowed'));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const request = parsed as JsonRpcRequest;
  if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
    sendJson(400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const method = request.method;
  const params = request.params ?? {};
  const isNotification = request.id === undefined;

  // Notifications never get a response body.
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(200, rpcResult(request.id, {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      supportedVersions: PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'Otterforge: a GitHub-compatible forge. Tools mirror the GitHub MCP server surface.',
    }));
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    sendJson(200, rpcResult(request.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(200, rpcResult(request.id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(200, rpcResult(request.id, TOOLS_LIST));
    return;
  }
  if (method === 'tools/call') {
    // Tool calls act as the token's user: no credential, no call.
    if (req.headers.authorization !== `Bearer ${forge.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      sendJson(200, rpcError(request.id, -32602, `unknown tool: ${name}`));
      return;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    for (const requiredArg of tool.required) {
      if (args[requiredArg] === undefined || args[requiredArg] === null || args[requiredArg] === '') {
        sendJson(200, rpcResult(request.id, toolError(`missing required argument: ${requiredArg}`)));
        return;
      }
    }
    try {
      const repo = tool.required.includes('owner') ? needRepo(ctx, args) : null;
      const value = tool.run(ctx, repo, args);
      sendJson(200, rpcResult(request.id, text(value)));
    } catch (err) {
      sendJson(200, rpcResult(request.id, toolError(err instanceof Error ? err.message : 'tool failed')));
    }
    return;
  }
  if (isNotification) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendJson(200, rpcError(request.id, -32601, `method not found: ${method}`));
}
