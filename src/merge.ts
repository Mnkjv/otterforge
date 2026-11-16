// Three-way merges for pull requests: file-level merge against the merge
// base, plus the commit construction for squash, merge and rebase methods.

import {
  buildCommit,
  buildTreeFromFlat,
  commitsBetween,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  putObject,
  type Identity,
} from './gitcore.ts';
import type { Forge, Pull, Repo } from './store.ts';

export interface MergePlan {
  baseTip: string;
  headTip: string;
  baseCommit: string | null;
  /** The merged tree oid when the merge is clean. */
  mergedTree: string | null;
  conflicts: string[];
}

/** Plan a merge of head into base without changing any state. */
export function planMerge(repo: Repo, pull: Pull): MergePlan | null {
  const store = repo.objects;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const baseCommit = mergeBase(store, baseTip, headTip);
  if (baseCommit === null) {
    return { baseTip, headTip, baseCommit: null, mergedTree: null, conflicts: ['*'] };
  }
  const baseTree = parseCommit((store.get(baseCommit) as { data: Buffer }).data).tree;
  const headTree = parseCommit((store.get(headTip) as { data: Buffer }).data).tree;
  const intoTree = parseCommit((store.get(baseTip) as { data: Buffer }).data).tree;
  const fromBase = flattenTree(store, baseTree);
  const fromHead = flattenTree(store, headTree);
  const fromInto = flattenTree(store, intoTree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const paths = new Set([...fromBase.keys(), ...fromHead.keys(), ...fromInto.keys()]);
  for (const path of paths) {
    const base = fromBase.get(path);
    const head = fromHead.get(path);
    const into = fromInto.get(path);
    const headChanged = (head?.oid ?? null) !== (base?.oid ?? null);
    const intoChanged = (into?.oid ?? null) !== (base?.oid ?? null);
    if (headChanged && intoChanged) {
      if ((head?.oid ?? null) === (into?.oid ?? null)) {
        if (head !== undefined) merged.set(path, head);
      } else {
        conflicts.push(path);
      }
    } else if (headChanged) {
      if (head !== undefined) merged.set(path, head);
    } else if (intoChanged) {
      if (into !== undefined) merged.set(path, into);
    } else if (base !== undefined) {
      merged.set(path, base);
    }
  }
  if (conflicts.length > 0) return { baseTip, headTip, baseCommit, mergedTree: null, conflicts };
  const mergedTree = buildTreeFromFlat(store, merged);
  return { baseTip, headTip, baseCommit, mergedTree, conflicts: [] };
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergeOutcome {
  sha: string;
}

/**
 * Perform the merge: write the merge commit(s), advance the base branch and
 * mark the pull request merged. Returns null when the merge conflicts.
 */
export function performMerge(forge: Forge, repo: Repo, pull: Pull, method: MergeMethod): MergeOutcome | null {
  const plan = planMerge(repo, pull);
  if (plan === null || plan.mergedTree === null) return null;
  const store = repo.objects;
  const identity: Identity = { name: forge.viewer.name, email: forge.viewer.email, when: forge.nowSec(), tz: '+0000' };
  let sha: string;
  if (method === 'squash') {
    const message = `${pull.title} (#${pull.number})`;
    sha = putObject(store, 'commit', buildCommit({ tree: plan.mergedTree, parents: [plan.baseTip], author: identity, committer: identity, message }));
  } else if (method === 'rebase') {
    // Replay each head-only commit, oldest first, onto the base tip. When a
    // replayed commit's tree already equals the running tree it is dropped,
    // like git rebase dropping empty commits; the final tree must equal the
    // three-way result for linear histories.
    const replay = commitsBetween(store, plan.baseTip, plan.headTip);
    let parent = plan.baseTip;
    sha = plan.baseTip;
    for (const oid of replay) {
      const commit = parseCommit((store.get(oid) as { data: Buffer }).data);
      const parentTree = parseCommit((store.get(parent) as { data: Buffer }).data).tree;
      if (commit.tree === parentTree && oid !== plan.headTip) continue;
      sha = putObject(store, 'commit', buildCommit({ tree: commit.tree, parents: [parent], author: commit.author, committer: identity, message: commit.message }));
      parent = sha;
    }
    if (sha === plan.baseTip) {
      // Nothing to replay (head already contained): fall back to a squash commit.
      const message = `${pull.title} (#${pull.number})`;
      sha = putObject(store, 'commit', buildCommit({ tree: plan.mergedTree, parents: [plan.baseTip], author: identity, committer: identity, message }));
    }
  } else {
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    sha = putObject(store, 'commit', buildCommit({ tree: plan.mergedTree, parents: [plan.baseTip, plan.headTip], author: identity, committer: identity, message }));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedTick = forge.currentTick();
  pull.mergeCommitSha = sha;
  pull.updatedTick = forge.currentTick();
  repo.updatedTick = forge.currentTick();
  return { sha };
}

/** True when the head branch has commits the base branch does not. */
export function hasNewCommits(repo: Repo, headRef: string, baseRef: string): boolean {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (headTip === undefined || baseTip === undefined) return false;
  if (headTip === baseTip) return false;
  return !isAncestor(repo.objects, headTip, baseTip);
}
