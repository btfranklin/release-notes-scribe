# Release Notes Scribe

Generate draft GitHub release notes using the OpenAI Responses API, based on the commit messages and diffs between tags.

## How it works

- Triggered by a tag push (recommended).
- Finds the previous tag and gathers commits in the range.
- Builds a structured prompt with commit messages + diff lines.
- Calls the OpenAI Responses API (model configurable, default `gpt-5.2`).
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

## Inputs

- `openai_api_key` (required): API key for an OpenAI-compatible provider.
- `openai_base_url`: Optional base URL for OpenAI-compatible providers.
- `model`: Model name (must support Responses API). Default: `gpt-5.2`.
- `github_token`: Token with `contents:write` permission. Defaults to `GITHUB_TOKEN` env var.
- `tag`: Override tag. Defaults to the tag that triggered the workflow.
- `previous_tag`: Override previous tag for comparison.
- `include_github_generated_notes`: Add GitHub-generated notes as extra context. Default: `false`.
- `max_diff_lines`: Max diff lines per commit in prompt. Default: `120`.
- `max_commits`: Max commits to include. Default: `200`.
- `max_stage_chars`: Max characters per summarization stage (approx 4 chars/token). Default: `400000`.
- `source_extensions`: Comma/space-separated list of source code extensions to include diffs for. Non-source files are filename-only. Default: built-in language list.
- `draft`: Create the release as a draft. Default: `true`.
- `prerelease`: Mark release as prerelease. Default: `false`.
- `release_name`: Override release title. Defaults to the tag.

## Outputs

- `release_notes`: Generated Markdown.
- `release_url`: URL of the created release.

## Notes

- Ensure `actions/checkout` uses `fetch-depth: 0` so tags are available.
- Shallow clones will warn and can block tag discovery.
- If no previous tag is found, the action compares against the empty tree.
- For tag-triggered workflows, prefer `v*.*.*` so moving major tags like `v1` don't trigger runs.
- Large releases are summarized in multiple stages to stay within prompt limits.

## Testing

```bash
npm install
npm test
```

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
