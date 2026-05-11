# Release Notes Scribe

![Release Notes Scribe banner](https://raw.githubusercontent.com/btfranklin/release-notes-scribe/main/.github/social%20preview/release_notes_scribe_social_preview.jpg "Release Notes Scribe")
[![Build Status](https://github.com/btfranklin/release-notes-scribe/actions/workflows/build.yml/badge.svg)](https://github.com/btfranklin/release-notes-scribe/actions/workflows/build.yml)

Generate draft GitHub release notes using the OpenAI Responses API, based on the commit messages and diffs between tags.

## How it works

- Triggered by a tag push (recommended).
- Finds the previous tag and gathers commits in the range.
- Builds a structured prompt with commit messages + diff lines.
- Calls the OpenAI Responses API (model configurable, default `gpt-5.5`).
- Creates a **draft** GitHub Release with the generated notes.

## Example workflow

```yaml
name: Draft Release Notes

on:
  push:
    tags:
      - "v*.*.*"

permissions:
  contents: write

jobs:
  draft-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.1
        with:
          fetch-depth: 0
      - name: Generate release notes
        uses: btfranklin/release-notes-scribe@v0
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          include_github_generated_notes: "true"
```

<!-- action-reference:start -->
## Inputs

- `openai_api_key`(required): OpenAI-compatible API key (Responses API required).
- `openai_base_url`: Optional base URL for OpenAI-compatible providers.
- `model`: Model name (must support OpenAI Responses API). Default: `gpt-5.5`.
- `github_token`: GitHub token with contents:write permissions. Defaults to GITHUB_TOKEN env var.
- `tag`: Release tag. Defaults to the tag that triggered the workflow.
- `previous_tag`: Override the previous tag for comparison.
- `include_github_generated_notes`: Include GitHub-generated release notes as extra context for the model. Default: `false`.
- `redact_secrets`: Redact likely secrets before sending release context to OpenAI. Default: `true`.
- `max_diff_lines`: Max diff lines per commit to include in the prompt. Default: `120`.
- `max_commits`: Max commits to include in the prompt. Default: `200`.
- `max_stage_chars`: Max characters per summarization stage (approx 4 chars/token). Default: `400000`.
- `source_extensions`: Comma/space-separated list of source code file extensions to diff (e.g. .ts,.py). Non-source files are filename-only.
- `draft`: Create the release as a draft. Default: `true`.
- `prerelease`: Mark the release as a prerelease. Default: `false`.
- `create_release`: Create or update a GitHub Release. Set to false to only generate release_notes output. Default: `true`.
- `existing_release_behavior`: What to do when a release for the tag already exists: update_draft, fail, or update_any. Default: `update_draft`.
- `release_name`: Override the release title. Defaults to the tag.

## Outputs

- `release_notes`: Generated release notes in Markdown.
- `release_url`: URL of the created GitHub release.
- `previous_tag`: Resolved previous tag, or an empty string when comparing against the empty tree.
- `commit_count`: Number of commits included after max_commits truncation.
- `prompt_char_count`: Character count of the prompt used for the final OpenAI response.
- `used_batching`: Whether the action summarized commits in batches before final release-note generation.
- `redaction_count`: Number of likely secrets redacted before sending context to OpenAI.
<!-- action-reference:end -->

## Notes

- Ensure `actions/checkout` uses `fetch-depth: 0` so tags are available.
- Shallow clones will warn and can block tag discovery.
- If no previous tag is found, the action compares against the empty tree.
- For tag-triggered workflows, prefer `v*.*.*` so moving major tags like `v1` don't trigger runs.
- Large releases are summarized in multiple stages to stay within prompt limits.
- Automatic previous-tag discovery uses the nearest reachable semantic release tag and ignores moving major tags.
- Reruns update an existing draft release by default and fail rather than editing a published release.
- Likely secrets are redacted before release context is sent to OpenAI by default.

## Testing

```bash
npm install
npm run check
```

Maintainer and agent-facing architecture, validation, and release details live in
[`docs/`](docs/index.md).

## Release

```bash
npm run release -- v0.1.0
```

Optional moving tag update:

```bash
npm run release -- v0.1.0 --move-major-tag
```

## License

MIT
