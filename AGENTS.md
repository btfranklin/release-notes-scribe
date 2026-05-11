# AGENTS.md

## Start Here

Release Notes Scribe is a Node 24 GitHub Action that generates draft GitHub
release notes with the OpenAI Responses API.

Use this file as the route map. Start deeper repo context at `docs/index.md`.

## Task Routing

- Product and user-facing behavior: read `README.md`.
- Architecture and code boundaries: read `docs/architecture.md`.
- Local setup, validation, and release mechanics: read `docs/development.md`.
- Release ordering with this action dogfooding itself: read `docs/releasing.md`.
- Current legibility guardrails and implemented reliability work: read `docs/legibility-audit.md`.
- Action inputs, outputs, and runtime metadata: inspect `action.yml`.

## Key Files

- `src/index.ts`: action entrypoint; reads inputs, calls OpenAI, creates releases.
- `src/lib.ts`: git inspection and prompt helpers; unit-testable core logic.
- `tests/`: Vitest coverage for release-note behavior and repo legibility.
- `dist/index.js`: generated ncc bundle; commit it after action code changes.
- `.github/workflows/build.yml`: CI validation and dist freshness gate.
- `.github/workflows/release.yml`: tag-triggered self-use of this action.

## Standard Validation

- Install dependencies: `npm install`
- Type-check: `npm run lint`
- Run tests: `npm test`
- Build bundle: `npm run build`
- Full local check: `npm run check`

After changing `src/` or `action.yml`, run `npm run build` and commit the
updated `dist/` output.
