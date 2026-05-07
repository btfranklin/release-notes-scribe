# Development

## Setup

Use npm for this Node action.

```bash
npm install
```

## Validation

Run the full local check before asking for review:

```bash
npm run check
```

That command runs:

- `npm run lint`: TypeScript type-checking.
- `npm test`: Vitest unit tests, including repo-legibility checks.
- `npm run build`: ncc bundle generation into `dist/`.

After source or action metadata changes, inspect `git status --short` and commit
any intended `dist/` changes. CI fails when build output is stale.

## Test Shape

- `tests/release-notes.test.ts` creates temporary git repositories to verify tag
  discovery, commit range selection, prompt formatting, non-source summaries,
  and response text extraction.
- `tests/repo-legibility.test.ts` keeps the agent-facing documentation and key
  action metadata aligned.

When adding behavior, prefer tests that assert the contract a user or maintainer
depends on. Avoid tests that only mirror incidental implementation details.

## CI

`.github/workflows/build.yml` runs on pushes and pull requests targeting `main`.
It installs dependencies with `npm ci`, runs the local check, and verifies that
the working tree is still clean after the build.

## Release

The full release ordering, including how this repository dogfoods
`release-notes-scribe`, is documented in `docs/releasing.md`.

Use the release script for normal releases:

```bash
npm run release -- v0.1.0
```

Add `--move-major-tag` when updating the moving major tag:

```bash
npm run release -- v0.1.0 --move-major-tag
```

The release script requires a clean working tree, validates semantic tag shape,
updates `package.json` when needed, runs tests unless `--skip-tests` is passed,
rebuilds `dist/`, commits release artifacts when they changed, tags the release,
and pushes the branch and tag.

The repository release workflow is self-hosted:

- `.github/workflows/release.yml` runs on `v*.*.*` tag pushes.
- It checks out full history with `fetch-depth: 0`.
- It runs this repository's action with `uses: ./`.
- It creates a draft release using `OPENAI_API_KEY` and `GITHUB_TOKEN`.
