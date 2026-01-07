import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import OpenAI from "openai";
import {
  buildCommitData,
  buildPrompt,
  DEFAULT_SOURCE_EXTENSIONS,
  extractResponseText,
  formatCommitBlock,
  getCommitShas,
  getTagFromRef,
  isShallowRepository,
  resolvePreviousTag,
} from "./lib";

function getInputBoolean(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name);
  if (!raw) {
    return defaultValue;
  }
  return ["true", "1", "yes", "y", "on"].includes(raw.toLowerCase());
}

function parseSourceExtensions(input: string): Set<string> {
  if (!input.trim()) {
    return new Set(DEFAULT_SOURCE_EXTENSIONS);
  }
  const values = input
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`
    );
  return new Set(values);
}

function trimText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function truncateCommit(
  commit: Parameters<typeof formatCommitBlock>[0],
  maxChars: number,
  logger: { warning: (message: string) => void }
) {
  let message = commit.message;
  let diffLines = [...commit.diffLines];
  let changed = false;

  const maxMessageLength = Math.max(200, Math.floor(maxChars / 4));
  if (message.length > maxMessageLength) {
    message = trimText(message, maxMessageLength);
    changed = true;
  }

  let block = formatCommitBlock({ ...commit, message, diffLines });
  while (block.length > maxChars && diffLines.length) {
    diffLines.pop();
    changed = true;
    block = formatCommitBlock({ ...commit, message, diffLines });
  }

  if (block.length > maxChars && diffLines.length) {
    diffLines = [];
    changed = true;
  }

  if (block.length > maxChars) {
    message = trimText(message, Math.max(50, maxChars - 200));
    diffLines = [];
    changed = true;
  }

  if (changed) {
    logger.warning(
      `Commit ${commit.sha.slice(0, 7)} truncated to fit prompt budget.`
    );
  }

  return { ...commit, message, diffLines };
}

function chunkCommits(
  commits: Parameters<typeof formatCommitBlock>[0][],
  maxChars: number,
  logger: { warning: (message: string) => void }
) {
  const chunks: typeof commits[] = [];
  let current: typeof commits = [];
  let currentSize = 0;

  for (const commit of commits) {
    let candidate = commit;
    let block = formatCommitBlock(candidate);
    if (block.length > maxChars) {
      candidate = truncateCommit(commit, maxChars, logger);
      block = formatCommitBlock(candidate);
    }

    if (current.length && currentSize + block.length + 2 > maxChars) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(candidate);
    currentSize += block.length + 2;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function buildSummaryPrompt(
  currentTag: string,
  previousTag: string,
  commits: Parameters<typeof formatCommitBlock>[0][]
): string {
  return buildPrompt(currentTag, previousTag, commits, "");
}

function buildFinalPrompt(
  currentTag: string,
  previousTag: string,
  summaries: string[],
  githubNotes: string
): string {
  const header = [
    `Release tag: ${currentTag}`,
    previousTag ? `Previous tag: ${previousTag}` : "Previous tag: (none)",
    `Summary batch count: ${summaries.length}`,
    "",
  ].join("\n");

  const blocks = summaries.map(
    (summary, index) => `Batch ${index + 1} summary:\n${summary}`
  );

  let prompt = `${header}${blocks.join("\n\n")}`;
  if (githubNotes) {
    prompt += `\n\nGitHub auto-generated notes (extra context, do not quote verbatim):\n${githubNotes}`;
  }
  return prompt;
}

async function generateResponseText(
  client: OpenAI,
  model: string,
  input: string,
  instructions: string,
  label: string
): Promise<string> {
  const response = await client.responses.create({
    model,
    input,
    instructions,
  });
  const text = extractResponseText(response).trim();
  if (!text) {
    throw new Error(`Model response did not include text output (${label}).`);
  }
  return text;
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("openai_api_key", { required: true });
    const baseUrl = core.getInput("openai_base_url") || undefined;
    const model = core.getInput("model") || "gpt-5.2";
    const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN;
    const inputTag = core.getInput("tag");
    const previousTagInput = core.getInput("previous_tag");
    const includeGithubNotes = getInputBoolean(
      "include_github_generated_notes",
      false
    );
    const maxDiffLines = Number.parseInt(
      core.getInput("max_diff_lines") || "120",
      10
    );
    const maxCommits = Number.parseInt(
      core.getInput("max_commits") || "200",
      10
    );
    const maxStageChars = Number.parseInt(
      core.getInput("max_stage_chars") || "400000",
      10
    );
    const sourceExtensions = parseSourceExtensions(
      core.getInput("source_extensions")
    );
    const draft = getInputBoolean("draft", true);
    const prerelease = getInputBoolean("prerelease", false);
    const releaseNameOverride = core.getInput("release_name");

    if (!githubToken) {
      throw new Error(
        "No GitHub token provided. Set github_token input or GITHUB_TOKEN env var."
      );
    }
    if (Number.isNaN(maxDiffLines) || maxDiffLines < 1) {
      throw new Error("max_diff_lines must be a positive integer.");
    }
    if (Number.isNaN(maxCommits) || maxCommits < 1) {
      throw new Error("max_commits must be a positive integer.");
    }
    if (Number.isNaN(maxStageChars) || maxStageChars < 1000) {
      throw new Error("max_stage_chars must be an integer >= 1000.");
    }

    const tag = inputTag || getTagFromRef(context.ref) || "";
    if (!tag) {
      throw new Error(
        "No tag detected. Provide the 'tag' input or run on a tag push."
      );
    }

    if (isShallowRepository()) {
      core.warning(
        "Repository is shallow. Tag discovery may be incomplete; set actions/checkout fetch-depth: 0."
      );
    }

    const logger = {
      info: core.info,
      warning: core.warning,
    };
    const previousTag = resolvePreviousTag(tag, previousTagInput, logger);
    const commitShas = getCommitShas(previousTag, tag, maxCommits, logger);
    if (!commitShas.length) {
      core.warning("No commits found between tags; nothing to summarize.");
    }

    const commits = buildCommitData(
      commitShas,
      maxDiffLines,
      logger,
      sourceExtensions
    );

    const octokit = getOctokit(githubToken);

    let githubNotes = "";
    if (includeGithubNotes) {
      try {
        const notes = await octokit.rest.repos.generateReleaseNotes({
          owner: context.repo.owner,
          repo: context.repo.repo,
          tag_name: tag,
          target_commitish: context.sha,
          ...(previousTag ? { previous_tag_name: previousTag } : {}),
        });
        githubNotes = notes.data.body ?? "";
      } catch (error) {
        core.warning(`Failed to fetch GitHub-generated notes: ${error}`);
      }
    }

    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    const finalInstructions =
      "Write concise release notes in Markdown for end users. " +
      "Use a '## What's Changed' heading and bullet points. " +
      "Prefer user-facing changes over internal refactors. " +
      "Do not include code fences.";
    const stageInstructions =
      "Summarize the following commits into a concise Markdown bullet list. " +
      "Focus on user-facing changes; mention notable internal changes briefly. " +
      "Do not include code fences.";

    const fullPrompt = buildPrompt(tag, previousTag, commits, githubNotes);
    let releaseNotes = "";

    if (fullPrompt.length <= maxStageChars) {
      releaseNotes = await generateResponseText(
        client,
        model,
        fullPrompt,
        finalInstructions,
        "final"
      );
    } else {
      const chunkBudget = Math.max(1000, maxStageChars - 2000);
      const chunks = chunkCommits(commits, chunkBudget, logger);
      const summaries: string[] = [];

      core.info(
        `Full prompt size ${fullPrompt.length} exceeds ${maxStageChars}. ` +
          `Summarizing in ${chunks.length} batches.`
      );

      for (let index = 0; index < chunks.length; index += 1) {
        const chunkPrompt = buildSummaryPrompt(tag, previousTag, chunks[index]);
        const summary = await generateResponseText(
          client,
          model,
          chunkPrompt,
          stageInstructions,
          `stage-${index + 1}`
        );
        summaries.push(summary);
      }

      const finalPrompt = buildFinalPrompt(
        tag,
        previousTag,
        summaries,
        githubNotes
      );
      releaseNotes = await generateResponseText(
        client,
        model,
        finalPrompt,
        finalInstructions,
        "final"
      );
    }

    const releaseName = releaseNameOverride || tag;

    const release = await octokit.rest.repos.createRelease({
      owner: context.repo.owner,
      repo: context.repo.repo,
      tag_name: tag,
      name: releaseName,
      body: releaseNotes,
      draft,
      prerelease,
      target_commitish: context.sha,
    });

    core.setOutput("release_notes", releaseNotes);
    core.setOutput("release_url", release.data.html_url ?? "");

    core.info(`Created release ${releaseName} (${release.data.html_url ?? ""}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

run();
