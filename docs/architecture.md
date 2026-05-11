# Architecture

Release Notes Scribe has three runtime responsibilities:

1. Discover the release range from reachable semantic Git tags.
2. Convert commits and diffs into a bounded prompt for the Responses API.
3. Publish, update, or output the generated Markdown according to action inputs.

## Runtime Flow

1. GitHub Actions loads `action.yml`, which points Node 24 at `dist/index.js`.
2. The bundled entrypoint mirrors `src/index.ts`.
3. `src/index.ts` reads action inputs through `@actions/core`.
4. Git helpers in `src/lib.ts` resolve the current tag, previous tag, commit
   SHAs, file stats, and diff snippets.
5. `src/index.ts` optionally asks GitHub for generated release notes as extra
   context.
6. Likely secrets are redacted from commit messages, diff lines, and
   GitHub-generated notes unless `redact_secrets` is disabled.
7. Prompt instructions are loaded from Markdown assets in `src/prompts/`.
8. If the prompt exceeds `max_stage_chars`, commits are summarized in batches
   before a final release-note prompt is built.
9. The OpenAI client calls the Responses API for the final release notes.
10. If `create_release` is enabled, `@actions/github` creates the release or
   updates an existing release according to `existing_release_behavior`.
11. Action outputs, including diagnostics, are set.

## Module Boundaries

- `src/index.ts` owns action orchestration, input validation, OpenAI calls,
  GitHub API calls, chunking, prompt asset loading, and action outputs.
- `src/lib.ts` owns pure or mostly deterministic helper behavior around git
  commands, tag resolution, commit shaping, prompt construction, and response
  text extraction.
- `src/prompts/` owns Markdown instruction assets that must be bundled into
  `dist/`.
- `tests/release-notes.test.ts` validates the git and prompt helper contract
  with temporary repositories.
- `tests/repo-legibility.test.ts` validates documentation and metadata
  invariants that future agents should not have to rediscover.

Keep helper behavior in `src/lib.ts` when it can be unit-tested without the
GitHub Actions runtime. Keep behavior in `src/index.ts` when it depends on
action inputs, secrets, OpenAI, or GitHub API side effects.

## Important Contracts

- Tags are expected to follow semantic release tags such as `v1.2.3`.
- Automatic previous-tag discovery ignores non-semantic tags and moving major
  tags such as `v1`.
- Workflows must use `actions/checkout` with `fetch-depth: 0`; tag discovery is
  unreliable in shallow clones.
- Reruns update an existing draft release by default, but do not edit published
  releases unless `existing_release_behavior` is set to `update_any`.
- `create_release: false` still generates `release_notes` but skips GitHub
  release lookup, create, and update calls.
- `redact_secrets` defaults to `true`; redaction logs a summary count without
  exposing matched values, paths, or commit SHAs.
- Diagnostic outputs report the resolved previous tag, included commit count,
  final prompt size, batching status, and redaction count.
- `source_extensions` controls which file diffs are included. Non-source files
  are summarized by filename to avoid noisy prompts.
- The generated `dist/index.js` bundle is committed because GitHub Actions runs
  JavaScript actions from checked-in built output.
- README action input and output reference is generated from `action.yml`.

## External Boundaries

- Git is invoked through `runGit` in `src/lib.ts`.
- GitHub API access uses `@actions/github`.
- OpenAI access uses the Responses API through the `openai` package.
- Prompt instructions are Markdown files copied into `dist/prompts/` after the
  ncc build; tests verify that source prompt assets are present in the generated
  action output.
