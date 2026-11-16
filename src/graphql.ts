// A compact GraphQL executor for the forge: it parses the query documents
// the GitHub CLI and github-mcp-server send (operations, variables, input
// objects, inline and named fragments, connections with cursor pagination)
// and resolves them against the same store the REST API uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { diffTrees, getObject, parseCommit } from './gitcore.ts';
import { readBody } from './githttp.ts';
import { performMerge, planMerge } from './merge.ts';
import { decodeGlobalId, globalId, type Ctx } from './rest.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

// ------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else throw new Error(`invalid escape \\${esc}`);
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let dot = false;
      let exp = false;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') {
        dot = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        exp = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(dot || exp ? { kind: 'float', value: Number(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  directives: Array<{ name: string; args: Map<string, ValueNode> }>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected '${value}'`);
  }
  private skipPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name');
    return t.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const defaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) defaults.set(varName, this.parseValue());
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, variableDefaults: defaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition '${keyword}'`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): Array<{ name: string; args: Map<string, ValueNode> }> {
    const directives: Array<{ name: string; args: Map<string, ValueNode> }> = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      const args = new Map<string, ValueNode>();
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        void directives;
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
    }
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.skipPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

function evalValue(node: ValueNode, variables: Map<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables.get(node.name);
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of node.fields) out[k] = evalValue(v, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------- types

type Source =
  | { type: 'Query' }
  | { type: 'Mutation' }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: Pull }
  | { type: 'User'; user: { id: number; login: string; name: string; email: string } }
  | { type: 'Ref'; name: string }
  | { type: 'Connection'; itemType: 'Issue' | 'PullRequest'; repo: Repo; items: Array<Issue | Pull>; totalCount: number }
  | { type: 'FileConnection'; items: Array<{ path: string; additions: number; deletions: number }> }
  | { type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { type: 'TypeInfo'; name: string }
  | { type: 'FieldInfo'; name: string }
  | { type: 'EnumValue'; name: string }
  | { type: 'Payload'; fields: Record<string, unknown> }
  | { type: 'CommentEdge'; node: Source }
  | { type: 'IssueComment'; id: string; body: string };

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit', 'meta', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'isPrivate', 'isFork', 'isArchived', 'createdAt', 'updatedAt',
    'pushedAt', 'url', 'sshUrl', 'homepageUrl', 'stargazerCount', 'forkCount', 'primaryLanguage',
    'labels', 'refs', 'ref', 'object', 'collaborators', 'mentionableUsers', 'assignableUsers',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'bodyText', 'bodyHTML', 'url', 'author', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'labels', 'comments', 'assignees',
    'milestone', 'viewerCanUpdate', 'viewerCanReact', 'reactionGroups', 'participants',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'files',
    'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'isDraft',
    'additions', 'deletions', 'changedFiles', 'commits', 'comments', 'labels', 'mergeCommit',
    'potentialMergeCommit', 'viewerCanUpdate', 'url',
  ],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'createdAt', 'updatedAt', 'isViewer', 'viewerCanFollow'],
  Organization: ['login', 'id', 'name', 'email', 'url', 'avatarUrl', 'description', 'createdAt', 'updatedAt'],
  Ref: ['name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'bodyText', 'url', 'author', 'createdAt', 'updatedAt'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergePullRequestMethod: ['MERGE', 'REBASE', 'SQUASH'],
};

// ---------------------------------------------------------------- executor

interface ExecCtx {
  forge: Forge;
  ctx: Ctx;
  variables: Map<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: Array<{ message: string }>;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function connectionPage<T>(items: T[], args: Map<string, unknown>): { page: T[]; pageInfo: Source } {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const after = indexFromCursor(args.get('after'));
  const start = after + 1;
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const info: Source = {
    type: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorFor(start) : null,
    endCursor: page.length > 0 ? cursorFor(start + page.length - 1) : null,
  };
  return { page, pageInfo: info };
}

function repoByGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const numeric = Number(decoded.parts[0]);
  for (const repo of forge.repos.values()) if (repo.id === numeric) return repo;
  return null;
}

function issueByGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repo = repoByGlobalId(forge, globalId('Repository', decoded.parts[0]));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function pullByGlobalId(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repo = repoByGlobalId(forge, globalId('Repository', decoded.parts[0]));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

function pullGraphqlState(pull: Pull): string {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}

function resolveField(ec: ExecCtx, source: Source, field: string, args: Map<string, unknown>): unknown {
  const forge = ec.forge;
  if (field === '__typename') return source.type;
  switch (source.type) {
    case 'Query': {
      if (field === 'viewer') return { type: 'User', user: forge.viewer } satisfies Source;
      if (field === 'repository') {
        const repo = forge.repoFor(String(args.get('owner') ?? ''), String(args.get('name') ?? ''));
        return repo === undefined ? null : ({ type: 'Repository', repo } satisfies Source);
      }
      if (field === 'node') {
        const id = args.get('id');
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(forge, id);
          return repo === null ? null : ({ type: 'Repository', repo } satisfies Source);
        }
        if (decoded.kind === 'Issue') {
          const found = issueByGlobalId(forge, id);
          return found === null ? null : ({ type: 'Issue', repo: found.repo, issue: found.issue } satisfies Source);
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullByGlobalId(forge, id);
          return found === null ? null : ({ type: 'PullRequest', repo: found.repo, pull: found.pull } satisfies Source);
        }
        if (decoded.kind === 'User') {
          const user = forge.users.find((u) => u.id === Number(decoded.parts[0]));
          return user === undefined ? null : ({ type: 'User', user } satisfies Source);
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.get('name') ?? '');
        if (TYPE_FIELDS[name] !== undefined || ENUM_TYPES[name] !== undefined) return { type: 'TypeInfo', name } satisfies Source;
        return null;
      }
      if (field === '__schema') return { type: 'Payload', fields: {} } satisfies Source;
      break;
    }
    case 'Mutation': {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      if (field === 'createIssue') {
        const repo = repoByGlobalId(forge, input.repositoryId);
        if (repo === null) throw new Error('repository not found');
        const issue = forge.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined });
        return { type: 'Payload', fields: { clientMutationId: input.clientMutationId ?? null, issue: { type: 'Issue', repo, issue } satisfies Source } } satisfies Source;
      }
      if (field === 'closeIssue') {
        const found = issueByGlobalId(forge, input.issueId);
        if (found === null) throw new Error('issue not found');
        found.issue.state = 'closed';
        found.issue.closedTick = forge.currentTick();
        found.issue.updatedTick = forge.currentTick();
        return { type: 'Payload', fields: { clientMutationId: input.clientMutationId ?? null, issue: { type: 'Issue', repo: found.repo, issue: found.issue } satisfies Source } } satisfies Source;
      }
      if (field === 'createPullRequest') {
        const repo = repoByGlobalId(forge, input.repositoryId);
        if (repo === null) throw new Error('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`head branch '${head}' does not exist`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`base branch '${base}' does not exist`);
        if (forge.openPullFor(repo, head, base) !== undefined) throw new Error('a pull request already exists for this head and base');
        const pull = forge.createPull(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined, headRef: head, baseRef: base });
        return { type: 'Payload', fields: { clientMutationId: input.clientMutationId ?? null, pullRequest: { type: 'PullRequest', repo, pull } satisfies Source } } satisfies Source;
      }
      if (field === 'mergePullRequest') {
        const found = pullByGlobalId(forge, input.pullRequestId);
        if (found === null) throw new Error('pull request not found');
        const methodRaw = String(input.mergeMethod ?? 'MERGE').toUpperCase();
        const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
        const outcome = performMerge(forge, found.repo, found.pull, method);
        if (outcome === null) throw new Error('pull request is not mergeable');
        return { type: 'Payload', fields: { clientMutationId: input.clientMutationId ?? null, pullRequest: { type: 'PullRequest', repo: found.repo, pull: found.pull } satisfies Source } } satisfies Source;
      }
      if (field === 'addComment') {
        const subjectId = input.subjectId;
        const body = String(input.body ?? '');
        const asIssue = issueByGlobalId(forge, subjectId);
        const asPull = asIssue === null ? pullByGlobalId(forge, subjectId) : null;
        const target = asIssue ?? asPull;
        if (target === null) throw new Error('subject not found');
        const entity = asIssue !== null ? asIssue.issue : (asPull as { pull: Pull }).pull;
        const comment = forge.addComment(entity, body);
        const node: Source = { type: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body };
        return { type: 'Payload', fields: { clientMutationId: input.clientMutationId ?? null, commentEdge: { type: 'CommentEdge', node } satisfies Source } } satisfies Source;
      }
      break;
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return { type: 'User', user: forge.userByLogin(repo.owner) ?? forge.viewer } satisfies Source;
        case 'defaultBranchRef': {
          const tip = repo.headTip();
          return tip === undefined ? null : ({ type: 'Ref', name: repo.defaultBranch } satisfies Source);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasProjectsEnabled': return true;
        case 'hasWikiEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'createdAt': return forge.isoOf(repo.createdTick);
        case 'updatedAt': return forge.isoOf(repo.updatedTick);
        case 'pushedAt': return forge.isoOf(repo.updatedTick);
        case 'url': return `${ec.ctx.base}/${repo.fullName}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue === undefined ? null : ({ type: 'Issue', repo, issue } satisfies Source);
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s).toLowerCase());
            items = items.filter((i) => wanted.includes(i.state));
          }
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
          const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
          const fieldName = String(orderBy?.field ?? 'CREATED_AT').toUpperCase();
          const key = (i: Issue): number => (fieldName === 'UPDATED_AT' ? i.updatedTick : fieldName === 'COMMENTS' ? i.comments.length : i.createdTick);
          items.sort((a, b) => (direction === 'ASC' ? key(a) - key(b) || a.number - b.number : key(b) - key(a) || b.number - a.number));
          const { page, pageInfo } = connectionPage(items, args);
          void page;
          const conn: Source = { type: 'Connection', itemType: 'Issue', repo, items, totalCount: items.length };
          (conn as { __pageInfo?: Source }).__pageInfo = pageInfo;
          (conn as { __args?: Map<string, unknown> }).__args = args;
          return conn;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull === undefined ? null : ({ type: 'PullRequest', repo, pull } satisfies Source);
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s).toUpperCase());
            items = items.filter((p) => wanted.includes(pullGraphqlState(p)));
          }
          items.sort((a, b) => b.createdTick - a.createdTick || b.number - a.number);
          const { pageInfo } = connectionPage(items, args);
          const conn: Source = { type: 'Connection', itemType: 'PullRequest', repo, items, totalCount: items.length };
          (conn as { __pageInfo?: Source }).__pageInfo = pageInfo;
          (conn as { __args?: Map<string, unknown> }).__args = args;
          return conn;
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = source;
      switch (field) {
        case 'id': return globalId('Issue', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'url': return `${ec.ctx.base}/${repo.fullName}/issues/${issue.number}`;
        case 'author': return { type: 'User', user: forge.userByLogin(issue.user) ?? forge.viewer } satisfies Source;
        case 'repository': return { type: 'Repository', repo } satisfies Source;
        case 'createdAt': return forge.isoOf(issue.createdTick);
        case 'updatedAt': return forge.isoOf(issue.updatedTick);
        case 'closedAt': return issue.closedTick === null ? null : forge.isoOf(issue.closedTick);
        case 'locked': return false;
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source;
      switch (field) {
        case 'id': return globalId('PullRequest', repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'bodyText': return pull.body;
        case 'state': return pullGraphqlState(pull);
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedTick === null ? null : forge.isoOf(pull.mergedTick);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
        case 'baseRefOid': return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const plan = planMerge(repo, pull);
          if (plan === null) return 'UNKNOWN';
          return plan.mergedTree === null ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'author': return { type: 'User', user: forge.userByLogin(pull.user) ?? forge.viewer } satisfies Source;
        case 'repository': return { type: 'Repository', repo } satisfies Source;
        case 'createdAt': return forge.isoOf(pull.createdTick);
        case 'updatedAt': return forge.isoOf(pull.updatedTick);
        case 'closedAt': return pull.state === 'open' ? null : forge.isoOf(pull.updatedTick);
        case 'closed': return pull.state === 'closed';
        case 'locked': return false;
        case 'isDraft': return false;
        case 'url': return `${ec.ctx.base}/${repo.fullName}/pull/${pull.number}`;
        case 'files': {
          const plan = planMerge(repo, pull);
          let files: Array<{ path: string; additions: number; deletions: number }> = [];
          if (plan !== null) {
            const baseTree = plan.baseCommit === null ? null : parseCommit((getObject(repo.objects, plan.baseCommit) as { data: Buffer }).data).tree;
            const headTree = parseCommit((getObject(repo.objects, plan.headTip) as { data: Buffer }).data).tree;
            files = diffTrees(repo.objects, baseTree, headTree).map((c) => ({ path: c.path, additions: c.additions, deletions: c.deletions }));
          }
          return { type: 'FileConnection', items: files } satisfies Source;
        }
        case 'additions': {
          const plan = planMerge(repo, pull);
          if (plan === null || plan.baseCommit === null) return 0;
          const baseTree = parseCommit((getObject(repo.objects, plan.baseCommit) as { data: Buffer }).data).tree;
          const headTree = parseCommit((getObject(repo.objects, plan.headTip) as { data: Buffer }).data).tree;
          return diffTrees(repo.objects, baseTree, headTree).reduce((sum, c) => sum + c.additions, 0);
        }
        case 'deletions': {
          const plan = planMerge(repo, pull);
          if (plan === null || plan.baseCommit === null) return 0;
          const baseTree = parseCommit((getObject(repo.objects, plan.baseCommit) as { data: Buffer }).data).tree;
          const headTree = parseCommit((getObject(repo.objects, plan.headTip) as { data: Buffer }).data).tree;
          return diffTrees(repo.objects, baseTree, headTree).reduce((sum, c) => sum + c.deletions, 0);
        }
        case 'changedFiles': {
          const plan = planMerge(repo, pull);
          if (plan === null || plan.baseCommit === null) return 0;
          const baseTree = parseCommit((getObject(repo.objects, plan.baseCommit) as { data: Buffer }).data).tree;
          const headTree = parseCommit((getObject(repo.objects, plan.headTip) as { data: Buffer }).data).tree;
          return diffTrees(repo.objects, baseTree, headTree).length;
        }
        default: break;
      }
      break;
    }
    case 'User': {
      const user = source.user;
      switch (field) {
        case 'login': return user.login;
        case 'id': return globalId('User', user.id);
        case 'databaseId': return user.id;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'url': return `${ec.ctx.base}/${user.login}`;
        case 'avatarUrl': return `${ec.ctx.base}/avatars/${user.id}`;
        case 'isViewer': return user.login === forge.viewer.login;
        default: break;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Connection': {
      if (field === 'totalCount') return source.totalCount;
      if (field === 'pageInfo') return (source as { __pageInfo?: Source }).__pageInfo as Source;
      if (field === 'nodes' || field === 'edges') {
        const args = (source as { __args?: Map<string, unknown> }).__args ?? new Map<string, unknown>();
        const { page } = connectionPage(source.items, args);
        const nodes = page.map((item) =>
          source.itemType === 'Issue'
            ? ({ type: 'Issue', repo: source.repo, issue: item as Issue } satisfies Source)
            : ({ type: 'PullRequest', repo: source.repo, pull: item as Pull } satisfies Source),
        );
        if (field === 'nodes') return nodes;
        return nodes.map((node, i) => ({ type: 'Payload', fields: { node, cursor: cursorFor(i) } }) satisfies Source);
      }
      break;
    }
    case 'FileConnection': {
      if (field === 'totalCount') return source.items.length;
      if (field === 'nodes' || field === 'edges') {
        const nodes = source.items.map((f) => ({ type: 'Payload', fields: { path: f.path, additions: f.additions, deletions: f.deletions, changeType: 'MODIFIED' } }) satisfies Source);
        if (field === 'nodes') return nodes;
        return nodes.map((node, i) => ({ type: 'Payload', fields: { node, cursor: cursorFor(i) } }) satisfies Source);
      }
      if (field === 'pageInfo') {
        return { type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } satisfies Source;
      }
      break;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return source.hasNextPage;
      if (field === 'hasPreviousPage') return source.hasPreviousPage;
      if (field === 'startCursor') return source.startCursor;
      if (field === 'endCursor') return source.endCursor;
      break;
    }
    case 'TypeInfo': {
      if (field === 'name') return source.name;
      if (field === 'kind') return ENUM_TYPES[source.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        return (TYPE_FIELDS[source.name] ?? []).map((name) => ({ type: 'FieldInfo', name }) satisfies Source);
      }
      if (field === 'enumValues') {
        return (ENUM_TYPES[source.name] ?? []).map((name) => ({ type: 'EnumValue', name }) satisfies Source);
      }
      if (field === 'description') return null;
      if (field === 'interfaces') return [];
      if (field === 'possibleTypes') return null;
      if (field === 'inputFields') return [];
      if (field === 'ofType') return null;
      break;
    }
    case 'FieldInfo': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      if (field === 'args') return [];
      if (field === 'type') return { type: 'TypeInfo', name: 'String' } satisfies Source;
      break;
    }
    case 'EnumValue': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case 'Payload': {
      if (field in source.fields) return source.fields[field];
      break;
    }
    case 'CommentEdge': {
      if (field === 'node') return source.node;
      if (field === 'cursor') return cursorFor(0);
      break;
    }
    case 'IssueComment': {
      if (field === 'id') return source.id;
      if (field === 'body' || field === 'bodyText') return source.body;
      break;
    }
  }
  ec.errors.push({ message: `Field '${field}' doesn't exist on type '${source.type}'` });
  return null;
}

function directivesAllow(ec: ExecCtx, node: FieldNode): boolean {
  for (const directive of node.directives) {
    if (directive.name === 'skip' || directive.name === 'include') {
      const ifValue = evalValue(directive.args.get('if') as ValueNode, ec.variables);
      if (directive.name === 'skip' && ifValue === true) return false;
      if (directive.name === 'include' && ifValue === false) return false;
    }
  }
  return true;
}

function executeSelections(ec: ExecCtx, source: Source, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.type) {
        Object.assign(out, executeSelections(ec, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ec.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === source.type) {
        Object.assign(out, executeSelections(ec, source, fragment.selectionSet));
      }
      continue;
    }
    if (!directivesAllow(ec, selection)) continue;
    const key = selection.alias ?? selection.name;
    const args = new Map<string, unknown>();
    for (const [name, value] of selection.args) args.set(name, evalValue(value, ec.variables));
    let value: unknown;
    try {
      value = resolveField(ec, source, selection.name, args as Map<string, unknown>);
    } catch (err) {
      ec.errors.push({ message: err instanceof Error ? err.message : 'internal error' });
      value = null;
    }
    if (selection.selectionSet !== null && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map((item) =>
          typeof item === 'object' && item !== null && 'type' in (item as Record<string, unknown>)
            ? executeSelections(ec, item as Source, selection.selectionSet as SelectionNode[])
            : item,
        );
      } else if (typeof value === 'object' && 'type' in (value as Record<string, unknown>)) {
        value = executeSelections(ec, value as Source, selection.selectionSet);
      }
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

// ---------------------------------------------------------------- handler

export async function handleGraphQL(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const forge = ctx.forge;
  const sendJson = (status: number, value: unknown): void => {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': forge.nextRequestId(),
      'content-length': body.length,
    });
    res.end(body);
  };
  if (req.headers.authorization !== `Bearer ${forge.token}`) {
    sendJson(401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    const errors: Array<{ message: string }> = [];
    try {
      if (doc === null || typeof doc !== 'object') throw new Error('invalid GraphQL document');
      const record = doc as { query?: unknown; variables?: unknown; operationName?: unknown };
      if (typeof record.query !== 'string') throw new Error('query is required');
      const { operations, fragments } = new Parser(lex(record.query)).parseDocument();
      if (operations.length === 0) throw new Error('no operation found');
      const operationName = typeof record.operationName === 'string' ? record.operationName : null;
      const operation = operationName === null ? operations[0] : operations.find((o) => o.name === operationName) ?? operations[0];
      const variables = new Map<string, unknown>();
      for (const [name, def] of operation.variableDefaults) variables.set(name, evalValue(def, variables));
      if (record.variables !== null && typeof record.variables === 'object') {
        for (const [k, v] of Object.entries(record.variables as Record<string, unknown>)) variables.set(k, v);
      }
      const ec: ExecCtx = { forge, ctx, variables, fragments, errors };
      const root: Source = operation.type === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
      const data = executeSelections(ec, root, operation.selectionSet);
      const out: Record<string, unknown> = { data };
      if (errors.length > 0) out.errors = errors;
      return out;
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'internal error' }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(200, parsed.map(runOne));
    return;
  }
  sendJson(200, runOne(parsed));
}
