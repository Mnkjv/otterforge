# Otterforge

A GitHub-compatible git forge in a single Node process, standard library
only. One in-memory store serves four surfaces:

- **Git smart HTTP** — protocol v2 advertisement, `ls-refs` and `fetch`
  (including shallow clones and deepening), plus v0 `receive-pack` with
  report-status, fast-forward enforcement and annotated tags.
- **REST API v3** — repositories, branches, git refs, commits, contents,
  labels, issues, comments and pull requests (including merges: squash,
  merge and rebase).
- **GraphQL API v4** — viewer, repository, node, issues and pull request
  connections with cursor pagination, mutations (create/close issue,
  create/merge pull request, add comment) and introspection.
- **MCP endpoint** — the modern `server/discover` handshake plus the
  legacy `initialize` flow, with a GitHub-flavoured tool set that shares
  state with the other surfaces.

State is deterministic: a logical clock stamps every mutation, so two
runs fed the same requests export identical state.

Run it the way the harness does:

```
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=shpat_... \
  node --experimental-strip-types main.ts
```
