// Git object engine for otterforge: content-addressed objects, trees, commits,
// packfiles (read with full delta resolution, write plain), ancestry and diffs.
// Everything is in memory; objects are stored per repository in a Map.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);
export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(store: ObjectStore, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export function getObject(store: ObjectStore, oid: string): GitObject | undefined {
  return store.get(oid);
}

// ---------------------------------------------------------------- identities

export interface Identity {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  when: number;
  /** Timezone offset string such as "+0000". */
  tz: string;
}

export function formatIdentity(id: Identity): string {
  return `${id.name} <${id.email}> ${id.when} ${id.tz}`;
}

export function parseIdentity(text: string): Identity {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', when: 0, tz: '+0000' };
  return { name: match[1], email: match[2], when: Number(match[3]), tz: match[4] };
}

// ------------------------------------------------------------------ commits

export interface Commit {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Identity = { name: '', email: '', when: 0, tz: '+0000' };
  let committer: Identity = { name: '', email: '', when: 0, tz: '+0000' };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  return { tree, parents, author, committer, message, raw: data };
}

export function buildCommit(commit: Omit<Commit, 'raw'>): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdentity(commit.author)}`);
  lines.push(`committer ${formatIdentity(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree ordering: names sort as bytes, directories as if they ended in "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> blob entry, recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = store.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> blob oid map. Returns the root tree oid. */
export function buildTreeFromFlat(store: ObjectStore, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, blob] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push({ mode: blob.mode, name: parts[parts.length - 1], oid: blob.oid });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

/** Peel an object to a commit: follow tags until a non-tag object remains. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1];
  }
}

/** Peel a tag object one level: returns the object it points at, or null. */
export function peelTagOnce(store: ObjectStore, oid: string): string | null {
  const obj = store.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1];
}

// ----------------------------------------------------------------- ancestry

/** All commits reachable from a tip, with their generation (longest distance from the tip). */
export function commitGenerations(store: ObjectStore, tip: string): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [{ oid: tip, gen: 0 }];
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    generations.set(oid, gen);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  return generations;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitGenerations(store, tip).has(ancestor);
}

/** Best common ancestor of two commits (the one with the smallest summed generations). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = commitGenerations(store, a);
  const fromB = commitGenerations(store, b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, genA] of fromA) {
    const genB = fromB.get(oid);
    if (genB === undefined) continue;
    const score = genA + genB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Commits in `tip` history that are not in `exclude` history, oldest first. */
export function commitsBetween(store: ObjectStore, exclude: string | null, tip: string): string[] {
  const excluded = exclude === null ? new Set<string>() : new Set(commitGenerations(store, exclude).keys());
  const gens = commitGenerations(store, tip);
  const list = [...gens.entries()].filter(([oid]) => !excluded.has(oid));
  list.sort((x, y) => y[1] - x[1]);
  return list.map(([oid]) => oid);
}

// ------------------------------------------------------------- reachability

/**
 * Full object closure from a set of tip objects. When `stopCommits` is given,
 * those commits are included but their parents are not walked (the shallow
 * boundary rule for fetch exclusion).
 */
export function objectClosure(store: ObjectStore, tips: Iterable<string>, stopCommits?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (stopCommits === undefined || !stopCommits.has(oid)) stack.push(...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = peelTagOnce(store, oid);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

// --------------------------------------------------------------------- diff

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts of a change between two blob contents, via a simple LCS diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Drop the phantom final empty line produced by a trailing newline, as diff tools do.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  // LCS over lines; histories in this forge are small, an O(mn) table is fine.
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

export function diffTrees(store: ObjectStore, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const baseFlat = baseTreeOid === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store, baseTreeOid);
  const headFlat = headTreeOid === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store, headTreeOid);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const oldText = before === undefined ? '' : (store.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (store.get(after.oid)?.data.toString('utf8') ?? '');
    const counts = lineDiffCounts(oldText, newText);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      oldOid: before?.oid ?? null,
      newOid: after?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

// --------------------------------------------------------------- pack write

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUM[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a complete, delta-free packfile containing the given objects. */
export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = store.get(oid);
    if (obj === undefined) continue;
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack read

/** Apply a git delta buffer to a base object, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[offset] << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[offset] << (8 * i); offset += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPack {
  /** oid -> object, hashes recomputed from content. */
  objects: Map<string, GitObject>;
}

interface RawEntry {
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset: number;
  baseOid: string;
  start: number;
}

/** Inflate exactly one zlib stream starting at `offset`; returns data and bytes consumed. */
function inflateOne(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, consumed };
}

/** Parse a packfile fully, resolving OFS and REF deltas (bases may live in `store`). */
export function parsePack(store: ObjectStore, pack: Buffer): ParsedPack {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: RawEntry[] = [];
  const indexByOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      shift += 7;
    }
    void shift;
    let type: RawEntry['type'];
    let baseOffset = -1;
    let baseOid = '';
    if (typeNum === 6) {
      type = 'ofs-delta';
      let back = pack[offset];
      offset += 1;
      let distance = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        distance = ((distance + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - distance;
    } else if (typeNum === 7) {
      type = 'ref-delta';
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else {
      const named = NUM_TYPE[typeNum];
      if (named === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      type = named;
    }
    const { data, consumed } = inflateOne(pack, offset);
    offset += consumed;
    indexByOffset.set(start, raw.length);
    raw.push({ type, data, baseOffset, baseOid, start });
  }
  const objects = new Map<string, GitObject>();
  const resolve = (index: number, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    const entry = raw[index];
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      return { type: entry.type, data: entry.data };
    }
    let base: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = indexByOffset.get(entry.baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      base = resolve(baseIndex, depth + 1);
    } else {
      const inPack = [...raw.keys()].find((j) => raw[j].type !== 'ofs-delta' && raw[j].type !== 'ref-delta' && hashObject(raw[j].type as ObjType, raw[j].data) === entry.baseOid);
      if (inPack !== undefined) base = resolve(inPack, depth + 1);
      else {
        const stored = store.get(entry.baseOid);
        if (stored === undefined) throw new Error('ref-delta base object is missing');
        base = stored;
      }
    }
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };
  for (let i = 0; i < raw.length; i += 1) {
    const obj = resolve(i, 0);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return { objects };
}
