# Repository Docs

This directory is the system of record for maintainers and coding agents. Keep
`AGENTS.md` short and route deeper context here.

## Maps

- `docs/architecture.md`: action flow, module boundaries, and dependency rules.
- `docs/development.md`: setup, validation, CI, and release workflow.
- `docs/releasing.md`: release ordering for this action's self-use of
  `release-notes-scribe`.
- `docs/legibility-audit.md`: current strengths, gaps, and next investments.

## Quick Context

Release Notes Scribe is distributed as a GitHub Action. The TypeScript source is
bundled into `dist/index.js` with `ncc`, and that generated bundle is part of the
published action surface.

The release workflow in this repository uses `uses: ./`, so tag pushes exercise
the local action implementation before consumers install a versioned tag.

## Documentation Rules

- Keep user-facing setup and inputs in `README.md`.
- Keep maintainer and agent workflow details in this directory.
- When `action.yml` defaults change, update `README.md` in the same change.
- When source behavior changes, update `docs/architecture.md` if boundaries or
  data flow changed.
- When validation expectations change, update `docs/development.md`.
