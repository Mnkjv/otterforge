// Git smart HTTP: info/refs advertisement (protocol v0 and v2), the v2
// ls-refs and fetch commands, and v0 receive-pack with report-status.
// Packs we send are complete and delta-free; packs we receive are parsed
// with full delta resolution by gitcore.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  isAncestor,
  objectClosure,
  parseCommit,
  parsePack,
  parseTree,
  peelToCommit,
  writePack,
  type ObjectStore,
} from './gitcore.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'otterforge/1.0';

// -------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');

interface PktCursor {
  /** Next line as text, 'flush', 'delim', or null at end of data. */
  next(): string | 'flush' | 'delim' | null;
  /** Bytes not consumed by pkt-lines (the pack after the flush). */
  rest(): Buffer;
}

export function pktCursor(buffer: Buffer): PktCursor {
  let offset = 0;
  return {
    next() {
      if (offset + 4 > buffer.length) return null;
      const header = buffer.subarray(offset, offset + 4).toString('utf8');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
      const length = parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        return 'flush';
      }
      if (length === 1) {
        offset += 4;
        return 'delim';
      }
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
      const payload = buffer.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      return payload;
    },
    rest() {
      return buffer.subarray(offset);
    },
  };
}

/** Wrap a byte stream in side-band-64k packets on the given band. */
function sidebandWrap(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = 65520 - 1;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxPayload));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- helpers

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length });
  res.end(buf);
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function authorized(forge: Forge, req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${forge.token}`;
}

/** Sorted ref entries with peeled values for annotated tags. */
function refList(repo: Repo): Array<{ name: string; oid: string; peeled: string | null }> {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => {
    const oid = repo.refs.get(name) as string;
    let peeled: string | null = null;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') peeled = peelToCommit(repo.objects, oid);
    return { name, oid, peeled };
  });
}

function uploadCaps(repo: Repo): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
}

function receiveCaps(repo: Repo): string {
  return [
    'report-status',
    'delete-refs',
    'side-band-64k',
    'ofs-delta',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
}

// ------------------------------------------------------------- info/refs

function advertise(forge: Forge, repo: Repo, service: string, wantsV2: boolean, res: ServerResponse): void {
  const preamble = pktLine(`# service=${service}\n`);
  if (service === 'git-upload-pack' && wantsV2) {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow',
      'server-option',
      'object-format=sha1',
    ];
    const body = Buffer.concat([preamble, PKT_FLUSH, ...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
    send(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return;
  }
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps(repo);
  const refs = refList(repo);
  const headTip = repo.headTip();
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    let first = true;
    if (headTip !== undefined) {
      lines.push(pktLine(`${headTip} HEAD\0${caps}`));
      first = false;
    }
    for (const ref of refs) {
      lines.push(pktLine(first ? `${ref.oid} ${ref.name}\0${caps}` : `${ref.oid} ${ref.name}`));
      first = false;
      if (ref.peeled !== null) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}`));
    }
  }
  const body = Buffer.concat([preamble, PKT_FLUSH, ...lines, PKT_FLUSH]);
  send(res, 200, `application/x-${service}-advertisement`, body);
  void forge;
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const target = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.headTip();
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:${target}` : ''}`);
    }
  }
  for (const ref of refList(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled !== null) line += ` peeled:${ref.peeled}`;
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  send(res, 200, 'application/x-git-upload-pack-result', body);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  done: boolean;
  noProgress: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, done: false, noProgress: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.deepen = Number(arg.slice(7).trim());
    else if (arg === 'deepen-relative') out.deepenRelative = true;
    else if (arg.startsWith('deepen-since ')) out.deepenSince = Number(arg.slice(13).trim());
    else if (arg === 'done') out.done = true;
    else if (arg === 'no-progress') out.noProgress = true;
  }
  return out;
}

/** Commits to include for a fetch, honoring depth limits and the client's shallow boundary. */
function includedCommits(store: ObjectStore, fetch: FetchArgs, excluded: Set<string>): Set<string> {
  const included = new Set<string>();
  const shallowSet = new Set(fetch.shallow);
  if (fetch.deepen !== null) {
    // Distance in parent edges from the nearest want (a want is distance 0).
    // An absolute deepen D includes distances 0..D-1; a relative deepen
    // extends the client's current shallow boundary by that many edges.
    const distance = new Map<string, number>();
    let frontier = fetch.wants.filter((w) => store.has(w));
    for (let d = 0; frontier.length > 0; d += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (distance.has(oid)) continue;
        distance.set(oid, d);
        const obj = store.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        next.push(...parseCommit(obj.data).parents);
      }
      frontier = next;
    }
    let limit = fetch.deepen - 1;
    if (fetch.deepenRelative) {
      let base = 0;
      for (const boundary of fetch.shallow) {
        const d = distance.get(boundary);
        if (d !== undefined && d > base) base = d;
      }
      limit = base + fetch.deepen;
    }
    for (const [oid, d] of distance) {
      if (d <= limit) included.add(oid);
    }
    return included;
  }
  if (fetch.deepenSince !== null) {
    const since = fetch.deepenSince;
    const stack = [...fetch.wants];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      if (commit.committer.when > since) included.add(oid);
      stack.push(...commit.parents);
    }
    return included;
  }
  // Full history walk, stopping at commits the client already has.
  const stack = [...fetch.wants];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (included.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (excluded.has(oid)) continue;
    included.add(oid);
    if (shallowSet.has(oid)) continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return included;
}

function fetchObjects(repo: Repo, args: string[], res: ServerResponse): void {
  const store = repo.objects;
  const fetch = parseFetchArgs(args);
  for (const want of fetch.wants) {
    if (!store.has(want)) {
      send(res, 400, 'text/plain', `unknown object ${want}`);
      return;
    }
  }
  const shallowSet = new Set(fetch.shallow);
  const excluded = objectClosure(store, fetch.haves, shallowSet);
  const commits = includedCommits(store, fetch, excluded);
  // Object set: included commits + their trees and blobs, minus what the
  // client already has. Tag objects that point at included commits ride along.
  const objectSet = new Set<string>();
  for (const oid of commits) {
    objectSet.add(oid);
    const commit = parseCommit((store.get(oid) as { data: Buffer }).data);
    for (const inner of objectClosure(store, [commit.tree])) objectSet.add(inner);
  }
  for (const want of fetch.wants) {
    let current = want;
    // Include the tag chain above a wanted commit.
    while (store.get(current)?.type === 'tag') {
      objectSet.add(current);
      const peeled = peelToCommit(store, current);
      if (peeled === null) break;
      current = peeled;
    }
  }
  for (const oid of excluded) objectSet.delete(oid);

  // Shallow bookkeeping: boundary commits are included commits with a parent
  // left out; unshallow lines release old boundary commits now fully included.
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  for (const oid of commits) {
    const commit = parseCommit((store.get(oid) as { data: Buffer }).data);
    const parentsOut = commit.parents.filter((p) => !commits.has(p) && store.has(p));
    if (parentsOut.length > 0) shallowLines.push(`shallow ${oid}`);
    else if (shallowSet.has(oid)) unshallowLines.push(`unshallow ${oid}`);
  }

  const sections: Buffer[] = [];
  const commonHaves = fetch.haves.filter((h) => store.has(h));
  if (objectSet.size === 0) {
    // Nothing new: acknowledgments with "ready" and no packfile section.
    sections.push(pktLine('acknowledgments\n'));
    for (const have of commonHaves) sections.push(pktLine(`ACK ${have}\n`));
    sections.push(pktLine('ready\n'), PKT_DELIM);
  } else {
    // With "done" the client expects the packfile next. In a negotiation
    // round (no "done" yet) the acknowledgments must carry "ready" when the
    // pack follows in the same response.
    if (!fetch.done) {
      sections.push(pktLine('acknowledgments\n'));
      if (commonHaves.length === 0) sections.push(pktLine('NAK\n'));
      else for (const have of commonHaves) sections.push(pktLine(`ACK ${have}\n`));
      sections.push(pktLine('ready\n'), PKT_DELIM);
    }
    const shallowInfo = [...shallowLines, ...unshallowLines];
    if (shallowInfo.length > 0) {
      sections.push(pktLine('shallow-info\n'));
      for (const line of shallowInfo) sections.push(pktLine(`${line}\n`));
      sections.push(PKT_DELIM);
    }
    // Order the pack: commits, then trees, then blobs.
    const ordered = [...objectSet].sort((a, b) => {
      const rank = (oid: string): number => {
        const t = store.get(oid)?.type;
        return t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3;
      };
      return rank(a) - rank(b);
    });
    const pack = writePack(store, ordered);
    sections.push(pktLine('packfile\n'), sidebandWrap(1, pack), PKT_FLUSH);
  }
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(sections));
}

// ------------------------------------------------------------ upload-pack

async function uploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let cursor: PktCursor;
  try {
    cursor = pktCursor(body);
  } catch {
    send(res, 400, 'text/plain', 'malformed request');
    return;
  }
  let command = '';
  const args: string[] = [];
  try {
    let phase: 'command' | 'args' = 'command';
    for (;;) {
      const line = cursor.next();
      if (line === null || line === 'flush') break;
      if (line === 'delim') {
        phase = 'args';
        continue;
      }
      const text = line.replace(/\n$/, '');
      if (phase === 'command') {
        if (text.startsWith('command=')) command = text.slice('command='.length);
        // Capability lines (agent=..., object-format=...) are ignored.
      } else {
        args.push(text);
      }
    }
  } catch {
    send(res, 400, 'text/plain', 'malformed request');
    return;
  }
  if (command === 'ls-refs') {
    lsRefs(repo, args, res);
    return;
  }
  if (command === 'fetch') {
    fetchObjects(repo, args, res);
    return;
  }
  send(res, 400, 'text/plain', `unknown command ${command}`);
}

// ----------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Verify every object a tip needs is present in the store. */
function closureComplete(store: ObjectStore, tip: string): boolean {
  const stack = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined) return false;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m)?.[1];
      if (target === undefined) return false;
      stack.push(target);
    }
  }
  return true;
}

async function receivePack(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let commands: RefCommand[] = [];
  let capabilities = '';
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const cursor = pktCursor(body);
    let first = true;
    for (;;) {
      const line = cursor.next();
      if (line === null) break;
      if (line === 'flush') {
        packBytes = cursor.rest();
        break;
      }
      if (line === 'delim') continue;
      let text = line.replace(/\n$/, '');
      if (first) {
        const nul = text.indexOf('\0');
        if (nul !== -1) {
          capabilities = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
        first = false;
      }
      const parts = text.split(' ');
      if (parts.length !== 3) throw new Error('malformed ref command');
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch {
    send(res, 400, 'text/plain', 'malformed request');
    return;
  }
  const caps = new Set(capabilities.split(' ').filter((c) => c !== ''));
  const wantReport = caps.has('report-status') || caps.has('report-status-v2');
  const sideBand = caps.has('side-band-64k');

  // Unpack into a staging area first; objects join the repo only on success.
  let unpackError: string | null = null;
  const staged = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(repo.objects, packBytes);
      for (const [oid, obj] of parsed.objects) staged.set(oid, obj);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const merged: ObjectStore = new Map([...repo.objects, ...staged]);

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const apply: Array<() => void> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const pass = (fn: () => void): void => {
      results.push({ ref: command.ref, ok: true, reason: '' });
      apply.push(fn);
    };
    if (unpackError !== null) {
      fail('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      fail('invalid ref');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (command.ref === repo.headRef()) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      pass(() => repo.refs.delete(command.ref));
      continue;
    }
    const newObj = merged.get(command.newOid);
    if (newObj === undefined || !closureComplete(merged, command.newOid)) {
      fail('unknown object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const newCommit = newObj.type === 'commit' ? command.newOid : peelToCommit(merged, command.newOid);
      if (newCommit === null) {
        fail('not a commit');
        continue;
      }
      if (command.oldOid !== ZERO_OID) {
        const oldCommit = peelToCommit(merged, command.oldOid) ?? command.oldOid;
        if (!isAncestor(merged, oldCommit, newCommit)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    pass(() => repo.refs.set(command.ref, command.newOid));
  }

  if (unpackError === null) {
    for (const [oid, obj] of staged) repo.objects.set(oid, obj);
    for (const fn of apply) fn();
    if (apply.length > 0) repo.updatedTick = forge.currentTick();
  }

  if (!wantReport) {
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportLines: string[] = [];
  reportLines.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  let report = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
  if (sideBand) report = Buffer.concat([sidebandWrap(1, report), PKT_FLUSH]);
  send(res, 200, 'application/x-git-receive-pack-result', report);
}

// -------------------------------------------------------------- dispatch

export async function handleGitRequest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  tail: string,
  query: URLSearchParams,
): Promise<void> {
  if (!authorized(forge, req)) {
    send(res, 401, 'text/plain', 'Authentication required');
    return;
  }
  const repo = forge.repoFor(owner, repoName);
  if (repo === undefined) {
    send(res, 404, 'text/plain', 'Repository not found');
    return;
  }
  if (tail === 'info/refs' && req.method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      send(res, 400, 'text/plain', 'unknown service');
      return;
    }
    const protocol = req.headers['git-protocol'];
    const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
    advertise(forge, repo, service, wantsV2, res);
    return;
  }
  if (tail === 'git-upload-pack' && req.method === 'POST') {
    await uploadPack(repo, req, res);
    return;
  }
  if (tail === 'git-receive-pack' && req.method === 'POST') {
    await receivePack(forge, repo, req, res);
    return;
  }
  send(res, 404, 'text/plain', 'Not Found');
}
