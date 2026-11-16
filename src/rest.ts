// GitHub REST API v3 surface: repositories, branches, refs, commits,
// contents, labels, issues, comments and pull requests, serialized the way
// GitHub serializes them. All state lives in the Forge store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  diffTrees,
  flattenTree,
  getObject,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  type Identity,
} from './gitcore.ts';
import { hasNewCommits, performMerge, planMerge, type MergeMethod } from './merge.ts';
import type { Comment, Forge, Issue, Label, Pull, Repo, UserInfo } from './store.ts';
import { readBody } from './githttp.ts';

// ------------------------------------------------------------ global ids

/** Opaque, stable global ids (GraphQL node ids): base64 of "Kind:part:part". */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- errors

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

// -------------------------------------------------------------- responses

export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  base: string;
}

export function json(ctx: Ctx, res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.forge.nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

export function noContent(ctx: Ctx, res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': ctx.forge.nextRequestId() });
  res.end();
}

// ------------------------------------------------------------- serializers

export function userObject(ctx: Ctx, user: UserInfo): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', user.id),
    avatar_url: `${ctx.base}/avatars/${user.id}`,
    gravatar_id: '',
    url: `${ctx.base}/api/v3/users/${user.login}`,
    html_url: `${ctx.base}/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
    company: null,
    blog: '',
    location: null,
    hireable: null,
    bio: null,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function repoObject(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const forge = ctx.forge;
  const owner = forge.userByLogin(repo.owner) as UserInfo;
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length +
    [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userObject(ctx, owner),
    private: repo.isPrivate,
    html_url: `${ctx.base}/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `${ctx.base}/api/v3/repos/${repo.fullName}`,
    created_at: forge.isoOf(repo.createdTick),
    updated_at: forge.isoOf(repo.updatedTick),
    pushed_at: forge.isoOf(repo.updatedTick),
    git_url: `git://${ctx.req.headers.host ?? 'localhost'}/${repo.fullName}.git`,
    ssh_url: `git@${ctx.req.headers.host ?? 'localhost'}:${repo.fullName}.git`,
    clone_url: `${ctx.base}/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelObject(ctx: Ctx, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', repo.id, label.id),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueObject(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const forge = ctx.forge;
  const user = forge.userByLogin(issue.user) ?? forge.viewer;
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${ctx.base}/api/v3/repos/${repo.fullName}`,
    labels_url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `${ctx.base}/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userObject(ctx, user),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelObject(ctx, repo, label);
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.createdTick),
    updated_at: forge.isoOf(issue.updatedTick),
    closed_at: issue.closedTick === null ? null : forge.isoOf(issue.closedTick),
    author_association: 'OWNER',
  };
}

export function commentObject(ctx: Ctx, repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  const forge = ctx.forge;
  const user = forge.userByLogin(comment.user) ?? forge.viewer;
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `${ctx.base}/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userObject(ctx, user),
    created_at: forge.isoOf(comment.tick),
    updated_at: forge.isoOf(comment.tick),
    issue_url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

function refEndpoint(ctx: Ctx, repo: Repo, refName: string, sha: string | undefined): Record<string, unknown> {
  const tip = sha ?? repo.refs.get(`refs/heads/${refName}`);
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha: tip ?? ZERO_OID,
    user: userObject(ctx, ctx.forge.userByLogin(repo.owner) as UserInfo),
    repo: repoObject(ctx, repo),
  };
}

export function pullObject(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const forge = ctx.forge;
  const user = forge.userByLogin(pull.user) ?? forge.viewer;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `${ctx.base}/${repo.fullName}/pull/${pull.number}`,
    diff_url: `${ctx.base}/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `${ctx.base}/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `${ctx.base}/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    commits_url: `${ctx.base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userObject(ctx, user),
    body: pull.body,
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: forge.isoOf(pull.createdTick),
    updated_at: forge.isoOf(pull.updatedTick),
    closed_at: pull.mergedTick === null && pull.state === 'open' ? null : forge.isoOf(pull.updatedTick),
    merged_at: pull.mergedTick === null ? null : forge.isoOf(pull.mergedTick),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    head: refEndpoint(ctx, repo, pull.headRef, undefined),
    base: refEndpoint(ctx, repo, pull.baseRef, undefined),
    author_association: 'OWNER',
    draft: false,
    merged: pull.merged,
    mergeable: null,
    rebaseable: null,
    mergeable_state: 'unknown',
    comments: pull.comments.length,
  };
}

export function commitObject(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = getObject(repo.objects, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const person = (identity: Identity): Record<string, unknown> => ({
    name: identity.name,
    email: identity.email,
    date: new Date(identity.when * 1000).toISOString(),
  });
  const linked = (identity: Identity): Record<string, unknown> | null => {
    const user = ctx.forge.users.find((u) => u.email === identity.email);
    return user === undefined ? null : userObject(ctx, user);
  };
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
      url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${ctx.base}/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `${ctx.base}/${repo.fullName}/commit/${sha}`,
    comments_url: `${ctx.base}/api/v3/repos/${repo.fullName}/commits/${sha}/comments`,
    author: linked(commit.author),
    committer: linked(commit.committer),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `${ctx.base}/api/v3/repos/${repo.fullName}/commits/${parent}`,
      html_url: `${ctx.base}/${repo.fullName}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------- parsing

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    fail(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Problems parsing JSON');
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function pagination(url: URL): { page: number; perPage: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, url: URL, items: T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pagination(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const linkFor = (p: number): string => {
    const u = new URL(url.toString());
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${linkFor(page + 1)}>; rel="next"`, `<${linkFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${linkFor(page - 1)}>; rel="prev"`, `<${linkFor(1)}>; rel="first"`);
  }
  return { page: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

/** Resolve a branch name, tag name or sha to a commit oid. */
export function resolveCommit(repo: Repo, ref: string | null | undefined): string | null {
  const name = ref ?? repo.defaultBranch;
  const branchTip = repo.refs.get(`refs/heads/${name}`);
  if (branchTip !== undefined) return peelToCommit(repo.objects, branchTip) ?? branchTip;
  const tagTip = repo.refs.get(`refs/tags/${name}`);
  if (tagTip !== undefined) return peelToCommit(repo.objects, tagTip) ?? tagTip;
  if (/^[0-9a-f]{40}$/.test(name) && repo.objects.has(name)) return peelToCommit(repo.objects, name) ?? name;
  return null;
}

/** Resolve a ref to the tree oid of its tip commit. */
export function resolveTree(repo: Repo, ref: string | null | undefined): string | null {
  const commit = resolveCommit(repo, ref);
  if (commit === null) return null;
  const obj = getObject(repo.objects, commit);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ------------------------------------------------------------------ routes

export async function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const forge = ctx.forge;
  try {
    if (req.headers.authorization !== `Bearer ${forge.token}`) {
      json(ctx, res, 401, { message: 'Bad credentials', documentation_url: `${ctx.base}/api/v3` });
      return;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/api/v3';
    const seg = path.split('/').filter((s) => s !== '');
    // seg[0] = 'api', seg[1] = 'v3'
    const rest = seg.slice(2);
    const method = req.method ?? 'GET';

    if (rest.length === 0 && method === 'GET') {
      json(ctx, res, 200, {
        current_user_url: `${ctx.base}/api/v3/user`,
        current_user_repositories_url: `${ctx.base}/api/v3/user/repos`,
        repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${ctx.base}/api/v3/search/repositories?q={query}`,
        issue_search_url: `${ctx.base}/api/v3/search/issues?q={query}`,
        user_url: `${ctx.base}/api/v3/users/{user}`,
        organization_url: `${ctx.base}/api/v3/orgs/{org}`,
        emojis_url: `${ctx.base}/api/v3/emojis`,
      });
      return;
    }
    if (rest[0] === 'meta' && method === 'GET') {
      json(ctx, res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false, ssh_key_fingerprints: {}, hooks: [] });
      return;
    }
    if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
      json(ctx, res, 200, userObject(ctx, forge.viewer));
      return;
    }
    if (rest[0] === 'users' && rest.length === 2 && method === 'GET') {
      const user = forge.userByLogin(decodeURIComponent(rest[1]));
      if (user === undefined) fail(404, 'Not Found');
      json(ctx, res, 200, userObject(ctx, user as UserInfo));
      return;
    }
    if (rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, headers } = paginate(ctx, url, forge.viewerRepos());
        json(ctx, res, 200, page.map((r) => repoObject(ctx, r)), headers);
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const name = str(body, 'name') ?? '';
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
          json(ctx, res, 422, {
            message: 'Repository creation failed.',
            errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is not valid' }],
          });
          return;
        }
        if (forge.viewerRepos().some((r) => r.name.toLowerCase() === name.toLowerCase())) {
          json(ctx, res, 422, {
            message: 'Repository creation failed.',
            errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
          });
          return;
        }
        const repo = forge.createRepo({
          name,
          description: str(body, 'description'),
          isPrivate: body.private === true,
          defaultBranch: str(body, 'default_branch'),
          autoInit: body.auto_init === true,
        });
        json(ctx, res, 201, repoObject(ctx, repo));
        return;
      }
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = decodeURIComponent(rest[1]);
      const name = decodeURIComponent(rest[2]);
      const repo = forge.repoFor(owner, name);
      if (repo === undefined) fail(404, 'Not Found');
      await repoRoutes(ctx, req, res, url, repo as Repo, rest.slice(3), method);
      return;
    }
    fail(404, 'Not Found');
  } catch (err) {
    if (err instanceof HttpError) {
      json(ctx, res, err.status, { message: err.message });
      return;
    }
    throw err;
  }
}

async function repoRoutes(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  rest: string[],
  method: string,
): Promise<void> {
  const forge = ctx.forge;
  if (rest.length === 0) {
    if (method === 'GET') {
      json(ctx, res, 200, repoObject(ctx, repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        forge.repos.delete(repo.fullName.toLowerCase());
        (repo as { name: string }).name = body.name;
        forge.repos.set(repo.fullName.toLowerCase(), repo);
      }
      repo.updatedTick = forge.currentTick();
      json(ctx, res, 200, repoObject(ctx, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      noContent(ctx, res);
      return;
    }
    fail(404, 'Not Found');
  }

  const [head, ...tail] = rest;

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${ctx.base}/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { page, headers } = paginate(ctx, url, branches);
      json(ctx, res, 200, page, headers);
      return;
    }
    if (tail.length >= 1 && method === 'GET') {
      const branchName = tail.map(decodeURIComponent).join('/');
      const sha = repo.refs.get(`refs/heads/${branchName}`);
      if (sha === undefined) fail(404, 'Branch not found');
      json(ctx, res, 200, {
        name: branchName,
        commit: commitObject(ctx, repo, sha as string),
        protected: false,
        protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
      });
      return;
    }
    fail(404, 'Not Found');
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          node_id: globalId('Ref', repo.id, ref),
          url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        }));
        json(ctx, res, 200, all);
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const ref = str(body, 'ref') ?? '';
        const sha = str(body, 'sha') ?? '';
        if (!ref.startsWith('refs/')) fail(422, 'Reference is not valid');
        if (repo.refs.has(ref)) fail(422, 'Reference already exists');
        const obj = repo.objects.get(sha);
        if (obj === undefined) fail(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        repo.updatedTick = forge.currentTick();
        json(ctx, res, 201, {
          ref,
          node_id: globalId('Ref', repo.id, ref),
          url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { sha, type: (obj as { type: string }).type, url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        });
        return;
      }
    }
    if (tail.length >= 2) {
      const ref = `refs/${tail.slice(1).map(decodeURIComponent).join('/')}`;
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (sha === undefined) fail(404, 'Not Found');
        json(ctx, res, 200, {
          ref,
          node_id: globalId('Ref', repo.id, ref),
          url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(ref)) fail(422, 'Reference does not exist');
        repo.refs.delete(ref);
        noContent(ctx, res);
        return;
      }
    }
    fail(404, 'Not Found');
  }

  if (head === 'git' && tail[0] === 'ref' && tail.length >= 2 && method === 'GET') {
    const ref = `refs/${tail.slice(1).map(decodeURIComponent).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) fail(404, 'Not Found');
    json(ctx, res, 200, {
      ref,
      node_id: globalId('Ref', repo.id, ref),
      url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
      object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
    });
    return;
  }

  if (head === 'commits') {
    if (tail.length === 0 && method === 'GET') {
      const tip = resolveCommit(repo, url.searchParams.get('sha'));
      if (tip === null) {
        if (repo.refs.size === 0) fail(409, 'Git Repository is empty.');
        fail(404, 'Not Found');
      }
      // Newest first: breadth walk by generation.
      const gens = new Map<string, number>();
      const queue: Array<{ oid: string; gen: number }> = [{ oid: tip as string, gen: 0 }];
      const order: string[] = [];
      while (queue.length > 0) {
        const { oid, gen } = queue.shift() as { oid: string; gen: number };
        if (gens.has(oid)) continue;
        gens.set(oid, gen);
        order.push(oid);
        const obj = getObject(repo.objects, oid);
        if (obj !== undefined && obj.type === 'commit') {
          for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
        }
      }
      const items = order.map((sha) => commitObject(ctx, repo, sha)).filter((c) => c !== null);
      const { page, headers } = paginate(ctx, url, items);
      json(ctx, res, 200, page, headers);
      return;
    }
    if (tail.length === 1 && method === 'GET') {
      const found = commitObject(ctx, repo, tail[0]);
      if (found === null) fail(404, 'Not Found');
      json(ctx, res, 200, found);
      return;
    }
    fail(404, 'Not Found');
  }

  if (head === 'contents') {
    await contentsRoutes(ctx, req, res, url, repo, tail, method);
    return;
  }

  if (head === 'labels') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const { page, headers } = paginate(ctx, url, [...repo.labels.values()]);
        json(ctx, res, 200, page.map((l) => labelObject(ctx, repo, l)), headers);
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const name = str(body, 'name');
        if (name === undefined || name === '') fail(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) fail(422, 'Validation Failed: name already exists on this repository');
        const color = (str(body, 'color') ?? 'ededed').replace(/^#/, '');
        const label = forge.createLabel(repo, name, color, str(body, 'description'));
        json(ctx, res, 201, labelObject(ctx, repo, label));
        return;
      }
    }
    if (tail.length === 1 && method === 'GET') {
      const label = repo.labels.get(decodeURIComponent(tail[0]));
      if (label === undefined) fail(404, 'Not Found');
      json(ctx, res, 200, labelObject(ctx, repo, label));
      return;
    }
    fail(404, 'Not Found');
  }

  if (head === 'issues') {
    await issuesRoutes(ctx, req, res, url, repo, tail, method);
    return;
  }

  if (head === 'pulls') {
    await pullsRoutes(ctx, req, res, url, repo, tail, method);
    return;
  }

  fail(404, 'Not Found');
}

// --------------------------------------------------------------- contents

async function contentsRoutes(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: string[],
  method: string,
): Promise<void> {
  const forge = ctx.forge;
  const path = tail.map(decodeURIComponent).join('/');
  if (method === 'GET') {
    const treeOid = resolveTree(repo, url.searchParams.get('ref'));
    if (treeOid === null) fail(404, 'Not Found');
    const flat = flattenTree(repo.objects, treeOid as string);
    if (path === '') {
      json(ctx, res, 200, dirListing(ctx, repo, treeOid as string, ''));
      return;
    }
    const entry = flat.get(path);
    if (entry !== undefined) {
      const blob = getObject(repo.objects, entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      json(ctx, res, 200, {
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        size: data.length,
        url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `${ctx.base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
        git_url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
        download_url: `${ctx.base}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        _links: { self: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`, git: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`, html: `${ctx.base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}` },
      });
      return;
    }
    // Maybe a directory.
    const subTree = walkTree(repo, treeOid as string, path);
    if (subTree !== null) {
      json(ctx, res, 200, dirListing(ctx, repo, subTree, path));
      return;
    }
    fail(404, 'Not Found');
  }
  if (method === 'PUT') {
    const body = await jsonBody(req);
    const message = str(body, 'message');
    const content = str(body, 'content');
    if (message === undefined || content === undefined) fail(422, 'Validation Failed: message and content are required');
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const flat = tip === undefined ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, parseCommit((getObject(repo.objects, tip) as { data: Buffer }).data).tree);
    const existing = flat.get(path);
    const givenSha = str(body, 'sha');
    if (existing !== undefined && givenSha !== undefined && givenSha !== existing.oid) {
      fail(409, `${path} does not match ${givenSha}`);
    }
    const blobOid = putObject(repo.objects, 'blob', Buffer.from(content as string, 'base64'));
    const result = forge.commitFileChange(repo, branch, path, blobOid, message as string);
    if (result === null) fail(404, `Branch ${branch} not found`);
    const commit = commitObject(ctx, repo, (result as { commitOid: string }).commitOid);
    json(ctx, res, existing === undefined ? 201 : 200, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: Buffer.from(content as string, 'base64').length,
        url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `${ctx.base}/${repo.fullName}/blob/${branch}/${path}`,
        git_url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
        download_url: `${ctx.base}/${repo.fullName}/raw/${branch}/${path}`,
        type: 'file',
        encoding: 'base64',
        _links: { self: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`, git: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`, html: `${ctx.base}/${repo.fullName}/blob/${branch}/${path}` },
      },
      commit,
    });
    return;
  }
  if (method === 'DELETE') {
    const body = await jsonBody(req);
    const message = str(body, 'message');
    const sha = str(body, 'sha');
    if (message === undefined || sha === undefined) fail(422, 'Validation Failed: message and sha are required');
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) fail(404, 'Not Found');
    const flat = flattenTree(repo.objects, parseCommit((getObject(repo.objects, tip) as { data: Buffer }).data).tree);
    const existing = flat.get(path);
    if (existing === undefined) fail(404, 'Not Found');
    if (existing.oid !== sha) fail(409, `${path} does not match ${sha}`);
    const result = forge.commitFileChange(repo, branch, path, null, message);
    if (result === null) fail(404, 'Not Found');
    json(ctx, res, 200, { content: null, commit: commitObject(ctx, repo, (result as { commitOid: string }).commitOid) });
    return;
  }
  fail(404, 'Not Found');
}

/** Walk a tree by path segments; returns the subtree oid or null. */
function walkTree(repo: Repo, treeOid: string, path: string): string | null {
  let current = treeOid;
  for (const part of path.split('/')) {
    const obj = getObject(repo.objects, current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function dirListing(ctx: Ctx, repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = getObject(repo.objects, treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .map((entry) => {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const isDir = entry.mode === '40000';
      const size = isDir ? 0 : (getObject(repo.objects, entry.oid)?.data.length ?? 0);
      return {
        name: entry.name,
        path,
        sha: entry.oid,
        size,
        url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `${ctx.base}/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
        git_url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        download_url: isDir ? null : `${ctx.base}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
        type: isDir ? 'dir' : 'file',
        _links: { self: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${path}`, git: `${ctx.base}/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`, html: `${ctx.base}/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}` },
      };
    })
    .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
}

// ----------------------------------------------------------------- issues

async function issuesRoutes(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: string[],
  method: string,
): Promise<void> {
  const forge = ctx.forge;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const sort = url.searchParams.get('sort') ?? 'created';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      const key = (i: Issue): number => (sort === 'updated' ? i.updatedTick : sort === 'comments' ? i.comments.length : i.createdTick);
      items.sort((a, b) => (direction === 'asc' ? key(a) - key(b) || a.number - b.number : key(b) - key(a) || b.number - a.number));
      const { page, headers } = paginate(ctx, url, items);
      json(ctx, res, 200, page.map((i) => issueObject(ctx, repo, i)), headers);
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req);
      const title = str(body, 'title');
      if (title === undefined || title === '') fail(422, 'Validation Failed: title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) fail(422, `Validation Failed: label '${name}' was not found`);
      }
      const issue = forge.createIssue(repo, { title, body: str(body, 'body'), labels });
      repo.updatedTick = forge.currentTick();
      json(ctx, res, 201, issueObject(ctx, repo, issue));
      return;
    }
    fail(404, 'Not Found');
  }
  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (issue === undefined) fail(404, 'Not Found');
    if (method === 'GET') {
      json(ctx, res, 200, issueObject(ctx, repo, issue as Issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      const target = issue as Issue;
      if (typeof body.title === 'string') target.title = body.title;
      if (typeof body.body === 'string') target.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        target.state = body.state;
        target.closedTick = body.state === 'closed' ? forge.currentTick() : null;
      }
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const name of labels) if (!repo.labels.has(name)) fail(422, `Validation Failed: label '${name}' was not found`);
        target.labels = labels;
      }
      target.updatedTick = forge.currentTick();
      json(ctx, res, 200, issueObject(ctx, repo, target));
      return;
    }
    fail(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) fail(404, 'Not Found');
    const target = issue as Issue;
    if (method === 'GET') {
      const { page, headers } = paginate(ctx, url, target.comments);
      json(ctx, res, 200, page.map((c) => commentObject(ctx, repo, target.number, c)), headers);
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req);
      const text = str(body, 'body');
      if (text === undefined) fail(422, 'Validation Failed: body is required');
      const comment = forge.addComment(target, text);
      json(ctx, res, 201, commentObject(ctx, repo, target.number, comment));
      return;
    }
    fail(404, 'Not Found');
  }
  fail(404, 'Not Found');
}

// ------------------------------------------------------------------ pulls

async function pullsRoutes(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: Repo,
  tail: string[],
  method: string,
): Promise<void> {
  const forge = ctx.forge;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => b.createdTick - a.createdTick || b.number - a.number);
      const { page, headers } = paginate(ctx, url, items);
      json(ctx, res, 200, page.map((p) => pullObject(ctx, repo, p)), headers);
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req);
      const title = str(body, 'title');
      const headRaw = str(body, 'head') ?? '';
      const baseRaw = str(body, 'base') ?? '';
      const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
      if (title === undefined || title === '') fail(422, 'Validation Failed: title is required');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) fail(422, `Validation Failed: head branch '${head}' does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) fail(422, `Validation Failed: base branch '${base}' does not exist`);
      if (head === base || !hasNewCommits(repo, head, base)) fail(422, `Validation Failed: No commits between ${base} and ${head}`);
      if (forge.openPullFor(repo, head, base) !== undefined) {
        fail(422, `A pull request already exists for ${repo.owner}:${head} → ${repo.owner}:${base}`);
      }
      const pull = forge.createPull(repo, { title, body: str(body, 'body'), headRef: head, baseRef: base });
      repo.updatedTick = forge.currentTick();
      json(ctx, res, 201, pullObject(ctx, repo, pull));
      return;
    }
    fail(404, 'Not Found');
  }
  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1) {
    if (pull === undefined) fail(404, 'Not Found');
    const target = pull as Pull;
    if (method === 'GET') {
      json(ctx, res, 200, pullObject(ctx, repo, target));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      if (typeof body.title === 'string') target.title = body.title;
      if (typeof body.body === 'string') target.body = body.body;
      if (body.state === 'closed' || body.state === 'open') target.state = body.state;
      target.updatedTick = forge.currentTick();
      json(ctx, res, 200, pullObject(ctx, repo, target));
      return;
    }
    fail(404, 'Not Found');
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) fail(404, 'Not Found');
    const target = pull as Pull;
    const plan = planMerge(repo, target);
    let files: Array<Record<string, unknown>> = [];
    if (plan !== null) {
      const baseTree = plan.baseCommit === null ? null : parseCommit((getObject(repo.objects, plan.baseCommit) as { data: Buffer }).data).tree;
      const headTree = parseCommit((getObject(repo.objects, plan.headTip) as { data: Buffer }).data).tree;
      files = diffTrees(repo.objects, baseTree, headTree).map((change) => ({
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        blob_url: `${ctx.base}/api/v3/repos/${repo.fullName}/git/blobs/${change.newOid ?? change.oldOid ?? ''}`,
        raw_url: `${ctx.base}/${repo.fullName}/raw/${target.headRef}/${change.path}`,
        contents_url: `${ctx.base}/api/v3/repos/${repo.fullName}/contents/${change.path}?ref=${target.headRef}`,
      }));
    }
    const { page, headers } = paginate(ctx, url, files);
    json(ctx, res, 200, page, headers);
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) fail(404, 'Not Found');
    const target = pull as Pull;
    const body = await jsonBody(req);
    if (target.state !== 'open' || target.merged) fail(405, 'Pull Request is not mergeable');
    const shaGuard = str(body, 'sha');
    if (shaGuard !== undefined && shaGuard !== repo.refs.get(`refs/heads/${target.baseRef}`)) {
      fail(409, 'The base branch has changed since the pull request was reviewed');
    }
    const methodRaw = str(body, 'merge_method') ?? 'merge';
    const mergeMethod: MergeMethod = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
    const outcome = performMerge(forge, repo, target, mergeMethod);
    if (outcome === null) fail(405, 'Pull Request is not mergeable');
    json(ctx, res, 200, { sha: (outcome as { sha: string }).sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (pull === undefined) fail(404, 'Not Found');
    const target = pull as Pull;
    if (method === 'GET') {
      const { page, headers } = paginate(ctx, url, target.comments);
      json(ctx, res, 200, page.map((c) => commentObject(ctx, repo, target.number, c)), headers);
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req);
      const text = str(body, 'body');
      if (text === undefined) fail(422, 'Validation Failed: body is required');
      const comment = forge.addComment(target, text);
      json(ctx, res, 201, commentObject(ctx, repo, target.number, comment));
      return;
    }
    fail(404, 'Not Found');
  }
  fail(404, 'Not Found');
}
