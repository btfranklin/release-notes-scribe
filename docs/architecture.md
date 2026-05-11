# Architecture

Release Notes Scribe has three runtime responsibilities:

1. Discover the release range from reachable semantic Git tags.
2. Convert commits and diffs into a bounded prompt for the Responses API.
3. Create a draft GitHub Release with the generated Markdown.

## Runtime Flow

1. GitHub Actions loads `action.yml`, which points Node 24 at `dist/index.js`.
2. The bundled entrypoint mirrors `src/index.ts`.
3. `src/index.ts` reads action inputs through `@actions/core`.
4. Git helpers in `src/lib.ts` resolve the current tag, previous tag, commit
   SHAs, file stats, and diff snippets.
5. `src/index.ts` optionally asks GitHub for generated release notes as extra
   context.
6. The OpenAI client calls the Responses API.
7. If the prompt exceeds `max_stage_chars`, commits are summarized in batches
   before a final release-note prompt is built.
8. If `create_release` is enabled, `@actions/github` creates the release or
   updates an existing release according to `existing_release_behavior`.
9. Action outputs are set.

## Module Boundaries

- `src/index.ts` owns action orchestration, input validation, OpenAI calls,
  GitHub API calls, chunking, and action outputs.
- `src/lib.ts` owns pure or mostly deterministic helper behavior around git
  commands, tag resolution, commit shaping, prompt construction, and response
  text extraction.
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
- `source_extensions` controls which file diffs are included. Non-source files
  are summarized by filename to avoid noisy prompts.
- The generated `dist/index.js` bundle is committed because GitHub Actions runs
  JavaScript actions from checked-in built output.
- README input defaults must match `action.yml`.

## External Boundaries

- Git is invoked through `runGit` in `src/lib.ts`.
- GitHub API access uses `@actions/github`.
- OpenAI access uses the Responses API through the `openai` package.
- No prompts are stored externally today; prompt text is assembled in code.
  If prompts become larger or reused across flows, move them into versioned
  Markdown templates bundled into `dist/`, or TypeScript prompt modules. Any
  external prompt assets must be included in the ncc bundle and covered by
  tests that prove the action can load them at runtime.
