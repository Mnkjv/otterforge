// The forge's in-memory state: users, repositories with their git objects,
// refs, issues, pull requests and labels. Time is a deterministic logical
// clock so that two identical runs produce byte-identical state.

import {
  buildCommit,
  buildTreeFromFlat,
  flattenTree,
  getObject,
  parseCommit,
  putObject,
  type GitObject,
  type Identity,
  type ObjectStore,
} from './gitcore.ts';

export interface UserInfo {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  tick: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdTick: number;
  updatedTick: number;
  closedTick: number | null;
  comments: Comment[];
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedTick: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  user: string;
  createdTick: number;
  updatedTick: number;
  comments: Comment[];
}

export class Repo {
  objects: ObjectStore = new Map<string, GitObject>();
  /** Full ref names ("refs/heads/main") -> object id. */
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;

  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdTick: number;
  updatedTick: number;

  constructor(
    id: number,
    owner: string,
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
    createdTick: number,
    updatedTick: number,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdTick = createdTick;
    this.updatedTick = updatedTick;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  headTip(): string | undefined {
    return this.refs.get(this.headRef());
  }
}

/** 2025-01-01T00:00:00Z: the logical clock starts here and ticks per mutation. */
export const EPOCH_SEC = 1_735_689_600;

export class Forge {
  private tickCount = 0;
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private requestCount = 0;

  readonly viewer: UserInfo = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
  readonly users: UserInfo[] = [
    this.viewer,
    { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
    { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
    { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
    { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
    { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
    { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
    { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
    { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
    { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
    { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
    { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
  ];

  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** Current logical time in seconds; advances the clock by one tick. */
  nowSec(): number {
    this.tickCount += 1;
    return EPOCH_SEC + this.tickCount;
  }

  /** Current logical time without advancing (for serializers). */
  tickToSec(tick: number): number {
    return EPOCH_SEC + tick;
  }

  currentTick(): number {
    return this.tickCount;
  }

  isoOf(tick: number): string {
    return new Date(this.tickToSec(tick) * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestCount += 1;
    return `OF-${this.requestCount.toString(16).padStart(8, '0')}`;
  }

  userByLogin(login: string): UserInfo | undefined {
    return this.users.find((u) => u.login === login);
  }

  viewerIdentity(): Identity {
    return { name: this.viewer.name, email: this.viewer.email, when: this.nowSec(), tz: '+0000' };
  }

  // ------------------------------------------------------------------ repos

  createRepo(input: { name: string; description?: string; isPrivate?: boolean; defaultBranch?: string; autoInit?: boolean }): Repo {
    const tick = this.currentTick();
    const repo = new Repo(
      this.nextRepoId,
      this.viewer.login,
      input.name,
      input.description ?? '',
      input.isPrivate ?? false,
      input.defaultBranch ?? 'main',
      tick,
      tick,
    );
    this.nextRepoId += 1;
    this.repos.set(repo.fullName.toLowerCase(), repo);
    if (input.autoInit === true) {
      const identity: Identity = { name: this.viewer.name, email: this.viewer.email, when: this.nowSec(), tz: '+0000' };
      const blob = putObject(repo.objects, 'blob', Buffer.from(`# ${input.name}\n`, 'utf8'));
      const tree = buildTreeFromFlat(repo.objects, new Map([['README.md', { mode: '100644', oid: blob }]]));
      const commit = putObject(repo.objects, 'commit', buildCommit({ tree, parents: [], author: identity, committer: identity, message: 'Initial commit' }));
      repo.refs.set(repo.headRef(), commit);
    }
    return repo;
  }

  /** Repos are only visible under their owner; anyone else's name is a 404. */
  repoFor(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (repo === undefined || repo.owner !== owner) return undefined;
    return repo;
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === this.viewer.login).sort((a, b) => a.id - b.id);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName.toLowerCase());
  }

  // ----------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[]; user?: string }): Issue {
    const tick = this.currentTick();
    const issue: Issue = {
      number: repo.nextNumber,
      id: this.nextIssueId,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: input.labels ?? [],
      user: input.user ?? this.viewer.login,
      createdTick: tick,
      updatedTick: tick,
      closedTick: null,
      comments: [],
    };
    repo.nextNumber += 1;
    this.nextIssueId += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(target: Issue | Pull, body: string, user?: string): Comment {
    const comment: Comment = { id: this.nextCommentId, body, user: user ?? this.viewer.login, tick: this.currentTick() };
    this.nextCommentId += 1;
    target.comments.push(comment);
    return comment;
  }

  createLabel(repo: Repo, name: string, color: string, description?: string): Label {
    const label: Label = { id: this.nextLabelId, name, color, description: description ?? null };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------------ pulls

  createPull(repo: Repo, input: { title: string; body?: string; headRef: string; baseRef: string; user?: string }): Pull {
    const tick = this.currentTick();
    const pull: Pull = {
      number: repo.nextNumber,
      id: this.nextIssueId,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedTick: null,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      user: input.user ?? this.viewer.login,
      createdTick: tick,
      updatedTick: tick,
      comments: [],
    };
    repo.nextNumber += 1;
    this.nextIssueId += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  openPullFor(repo: Repo, headRef: string, baseRef: string): Pull | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return undefined;
  }

  // ------------------------------------------------------- commits via REST

  /**
   * Commit a file change on a branch: replace (or remove, when blob is null)
   * one path in the branch tip's tree and create a commit on top. Returns the
   * new commit oid, or null when the branch does not exist and may not be
   * created implicitly.
   */
  commitFileChange(
    repo: Repo,
    branch: string,
    path: string,
    blobOid: string | null,
    message: string,
  ): { commitOid: string; createdBranch: boolean } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const store = repo.objects;
    let flat = new Map<string, { mode: string; oid: string }>();
    let parents: string[] = [];
    if (tip !== undefined) {
      const tipObj = getObject(store, tip);
      if (tipObj === undefined || tipObj.type !== 'commit') return null;
      flat = flattenTree(store, parseCommit(tipObj.data).tree);
      parents = [tip];
    } else if (branch !== repo.defaultBranch) {
      return null;
    }
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: blobOid });
    const tree = buildTreeFromFlat(store, flat);
    const identity = this.viewerIdentity();
    const commitOid = putObject(store, 'commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
    repo.refs.set(ref, commitOid);
    repo.updatedTick = this.currentTick();
    return { commitOid, createdBranch: tip === undefined };
  }
}
