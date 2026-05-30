# Changesets

Per-PR version-bump queue for the `@crewhaus/*` packages in this workspace.

See [factory/.changeset/README.md](https://github.com/crewhaus/factory/blob/main/.changeset/README.md) for the full convention — the utilities workspace follows the same rules, just rooted at `https://github.com/crewhaus/utilities`.

## Quick reference

```bash
bun x changeset            # author a bump intent for your PR
bun x changeset version    # consume the queue and bump
bun x changeset publish    # publish bumped packages
```

All packages were initialized at **v0.1.1** on 2026-05-30 (a v0.1.0 cut earlier the same day shipped with broken workspace:* deps and is tombstoned — pin `^0.1.1` or newer).
