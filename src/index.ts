import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import OpenAI from "openai";
import {
  buildCommitData,
  buildPrompt,
  extractResponseText,
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

    const commits = buildCommitData(commitShas, maxDiffLines);

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

    const prompt = buildPrompt(tag, previousTag, commits, githubNotes);

    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    const response = await client.responses.create({
      model,
      input: prompt,
      instructions:
        "Write concise release notes in Markdown for end users. " +
        "Use a '## What's Changed' heading and bullet points. " +
        "Prefer user-facing changes over internal refactors. " +
        "Do not include code fences.",
    });

    const releaseNotes = extractResponseText(response).trim();
    if (!releaseNotes) {
      throw new Error("Model response did not include any text output.");
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
