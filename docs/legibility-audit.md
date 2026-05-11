# Legibility Audit

## Current Strengths

- The repository is small and has a clear action surface in `action.yml`.
- Runtime code is split between orchestration in `src/index.ts` and testable git,
  redaction, response extraction, and prompt helpers in `src/lib.ts`.
- Prompt instructions live in versioned Markdown assets under `src/prompts/`,
  are copied into `dist/prompts/`, and are checked for bundle availability.
- CI checks tests, generated README action reference freshness, build output,
  and committed `dist/` freshness.
- The release workflow dogfoods the action with `uses: ./`.

## Guardrails In Place

- `docs/index.md` is the maintainer and agent documentation entry point.
- `docs/architecture.md` records runtime flow, module ownership, public action
  contracts, and external boundaries.
- `docs/development.md` records setup, validation, CI, and release mechanics.
- `AGENTS.md` stays short enough to be a route map.
- `tests/repo-legibility.test.ts` enforces documentation routing, generated
  README reference freshness, runtime/default alignment, prompt asset bundling,
  and release workflow contracts.

## Implemented Reliability Work

- Automatic previous-tag discovery is graph-aware and semantic-release only.
- Reruns update existing draft releases by default and avoid editing published
  releases unless explicitly configured.
- `create_release: false` supports output-only release-note generation.
- Likely secrets are redacted before release context is sent to OpenAI by
  default, with summary-count logging.
- Diagnostic outputs expose previous tag, included commit count, prompt size,
  batching status, and redaction count.
