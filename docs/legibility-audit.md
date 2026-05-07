# Legibility Audit

## Current Strengths

- The repository is small and has a clear action surface in `action.yml`.
- Runtime code is split between orchestration in `src/index.ts` and testable git
  and prompt helpers in `src/lib.ts`.
- CI already checks tests, build output, and committed `dist/` freshness.
- The release workflow dogfoods the action with `uses: ./`.

## Fixed In This Pass

- Added `docs/index.md` as the maintainer and agent documentation entry point.
- Added `docs/architecture.md` so agents can see runtime flow, module ownership,
  and external boundaries without reconstructing them from source.
- Added `docs/development.md` for setup, validation, CI, and release mechanics.
- Shortened `AGENTS.md` into a route map instead of a mixed encyclopedia.
- Added `tests/repo-legibility.test.ts` to enforce docs routing and important
  workflow/default alignment.

## Remaining Gaps

- Prompt wording still lives inline in `src/index.ts`. That is acceptable while
  the prompts are short, but reusable prompt files would be more legible if the
  release-note policy grows.
- There is no integration test that mocks OpenAI and GitHub API calls through
  the full `src/index.ts` action path.
- There is no generated inventory for action inputs and README docs. The current
  legibility test covers the highest-risk defaults, but a generated reference
  would scale better if the input surface grows.

## Next Investments

1. Add a full action integration test with mocked OpenAI and GitHub clients if
   orchestration logic grows.
2. Move longer prompt instructions into versioned prompt files if prompt policy
   becomes more complex or repeated.
3. Generate an input/output reference from `action.yml` and check README
   freshness from that generated artifact.
