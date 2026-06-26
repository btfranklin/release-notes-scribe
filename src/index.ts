import { readFileSync } from "fs";
import { join } from "path";
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
  redactCommitData,
  redactPossibleSecrets,
  resolvePreviousTag,
} from "./lib";

type ExistingReleaseBehavior = "update_draft" | "fail" | "update_any";

type ActionCore = {
  getInput: (name: string, options?: { required?: boolean }) => string;
  info: (message: string) => void;
  warning: (message: string) => void;
  setOutput: (name: string, value: string) => void;
  setFailed: (message: string) => void;
};

type ActionContext = {
  ref?: string;
  sha: string;
  repo: {
    owner: string;
    repo: string;
  };
};

type ReleaseData = {
  id: number;
  html_url?: string | null;
  draft?: boolean;
};

type OctokitLike = {
  rest: {
    repos: {
      generateReleaseNotes: (args: {
        owner: string;
        repo: string;
        tag_name: string;
        target_commitish: string;
        previous_tag_name?: string;
      }) => Promise<{ data: { body?: string | null } }>;
      getReleaseByTag: (args: {
        owner: string;
        repo: string;
        tag: string;
      }) => Promise<{ data: ReleaseData }>;
      createRelease: (args: ReleaseRequest) => Promise<{ data: ReleaseData }>;
      updateRelease: (
        args: ReleaseRequest & { release_id: number }
      ) => Promise<{ data: ReleaseData }>;
    };
  };
};

type OpenAIClientLike = {
  responses: {
    create: (args: {
      model: string;
      input: string;
      instructions: string;
    }) => Promise<unknown>;
  };
};

type ReleaseRequest = {
  owner: string;
  repo: string;
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  target_commitish: string;
};

export type ActionDependencies = {
  core: ActionCore;
  context: ActionContext;
  env: NodeJS.ProcessEnv;
  getOctokit: (token: string) => OctokitLike;
  createOpenAIClient: (options: {
    apiKey: string;
    baseURL?: string;
  }) => OpenAIClientLike;
};

function getInputBoolean(
  actionCore: Pick<ActionCore, "getInput">,
  name: string,
  defaultValue: boolean
): boolean {
  const raw = actionCore.getInput(name);
  if (!raw) {
    return defaultValue;
  }
  return ["true", "1", "yes", "y", "on"].includes(raw.toLowerCase());
}

function parseExistingReleaseBehavior(input: string): ExistingReleaseBehavior {
  const value = input || "update_draft";
  if (["update_draft", "fail", "update_any"].includes(value)) {
    return value as ExistingReleaseBehavior;
  }
  throw new Error(
    "existing_release_behavior must be one of: update_draft, fail, update_any."
  );
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

const PROMPTS_DIRECTORY = join(__dirname, ...["prompts"]);

function readPromptAsset(name: string): string {
  return readFileSync(join(PROMPTS_DIRECTORY, name), "utf8").trim();
}

const FINAL_RELEASE_PROMPT = readPromptAsset("final-release.md");
const STAGE_SUMMARY_PROMPT = readPromptAsset("stage-summary.md");

function loadPrompt(name: string): string {
  switch (name) {
    case "final-release.md":
      return FINAL_RELEASE_PROMPT;
    case "stage-summary.md":
      return STAGE_SUMMARY_PROMPT;
    default:
      throw new Error(`Unknown prompt asset: ${name}`);
  }
}

function setDiagnosticOutputs(
  actionCore: Pick<ActionCore, "setOutput">,
  previousTag: string,
  commitCount: number,
  promptCharCount: number,
  usedBatching: boolean,
  redactionCount: number
): void {
  actionCore.setOutput("previous_tag", previousTag);
  actionCore.setOutput("commit_count", String(commitCount));
  actionCore.setOutput("prompt_char_count", String(promptCharCount));
  actionCore.setOutput("used_batching", String(usedBatching));
  actionCore.setOutput("redaction_count", String(redactionCount));
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
  client: OpenAIClientLike,
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

async function getExistingRelease(
  octokit: OctokitLike,
  actionContext: ActionContext,
  tag: string
): Promise<ReleaseData | null> {
  try {
    const release = await octokit.rest.repos.getReleaseByTag({
      owner: actionContext.repo.owner,
      repo: actionContext.repo.repo,
      tag,
    });
    return release.data;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function writeRelease(
  octokit: OctokitLike,
  actionContext: ActionContext,
  tag: string,
  releaseName: string,
  releaseNotes: string,
  draft: boolean,
  prerelease: boolean,
  behavior: ExistingReleaseBehavior
): Promise<ReleaseData> {
  const existingRelease = await getExistingRelease(octokit, actionContext, tag);
  const request: ReleaseRequest = {
    owner: actionContext.repo.owner,
    repo: actionContext.repo.repo,
    tag_name: tag,
    name: releaseName,
    body: releaseNotes,
    draft,
    prerelease,
    target_commitish: actionContext.sha,
  };

  if (!existingRelease) {
    return (await octokit.rest.repos.createRelease(request)).data;
  }

  if (behavior === "fail") {
    throw new Error(`Release ${tag} already exists.`);
  }
  if (behavior === "update_draft" && !existingRelease.draft) {
    throw new Error(
      `Release ${tag} already exists and is not a draft. Set existing_release_behavior to update_any to update published releases.`
    );
  }

  return (
    await octokit.rest.repos.updateRelease({
      ...request,
      release_id: existingRelease.id,
    })
  ).data;
}

export async function runAction(dependencies: ActionDependencies): Promise<void> {
  const actionCore = dependencies.core;
  const actionContext = dependencies.context;
  const apiKey = actionCore.getInput("openai_api_key", { required: true });
  const baseUrl = actionCore.getInput("openai_base_url") || undefined;
  const model = actionCore.getInput("model") || "gpt-5.5";
  const githubToken =
    actionCore.getInput("github_token") || dependencies.env.GITHUB_TOKEN;
  const inputTag = actionCore.getInput("tag");
  const previousTagInput = actionCore.getInput("previous_tag");
  const includeGithubNotes = getInputBoolean(
    actionCore,
    "include_github_generated_notes",
    false
  );
  const redactSecrets = getInputBoolean(actionCore, "redact_secrets", true);
  const maxDiffLines = Number.parseInt(
    actionCore.getInput("max_diff_lines") || "120",
    10
  );
  const maxCommits = Number.parseInt(
    actionCore.getInput("max_commits") || "200",
    10
  );
  const maxStageChars = Number.parseInt(
    actionCore.getInput("max_stage_chars") || "400000",
    10
  );
  const sourceExtensions = parseSourceExtensions(
    actionCore.getInput("source_extensions")
  );
  const draft = getInputBoolean(actionCore, "draft", true);
  const prerelease = getInputBoolean(actionCore, "prerelease", false);
  const createRelease = getInputBoolean(actionCore, "create_release", true);
  const existingReleaseBehavior = parseExistingReleaseBehavior(
    actionCore.getInput("existing_release_behavior")
  );
  const releaseNameOverride = actionCore.getInput("release_name");

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

  const tag = inputTag || getTagFromRef(actionContext.ref) || "";
  if (!tag) {
    throw new Error(
      "No tag detected. Provide the 'tag' input or run on a tag push."
    );
  }

  if (isShallowRepository()) {
    actionCore.warning(
      "Repository is shallow. Tag discovery may be incomplete; set actions/checkout fetch-depth: 0."
    );
  }

  const logger = {
    info: actionCore.info,
    warning: actionCore.warning,
  };
  const previousTag = resolvePreviousTag(tag, previousTagInput, logger);
  const commitShas = getCommitShas(previousTag, tag, maxCommits, logger);
  if (!commitShas.length) {
    actionCore.warning("No commits found between tags; nothing to summarize.");
  }

  const commits = buildCommitData(
    commitShas,
    maxDiffLines,
    logger,
    sourceExtensions
  );

  const octokit = dependencies.getOctokit(githubToken);

  let githubNotes = "";
  if (includeGithubNotes) {
    try {
      const notes = await octokit.rest.repos.generateReleaseNotes({
        owner: actionContext.repo.owner,
        repo: actionContext.repo.repo,
        tag_name: tag,
        target_commitish: actionContext.sha,
        ...(previousTag ? { previous_tag_name: previousTag } : {}),
      });
      githubNotes = notes.data.body ?? "";
    } catch (error) {
      actionCore.warning(`Failed to fetch GitHub-generated notes: ${error}`);
    }
  }

  let promptCommits = commits;
  let promptGithubNotes = githubNotes;
  let redactionCount = 0;
  if (redactSecrets) {
    const redactedCommits = redactCommitData(commits);
    const redactedGithubNotes = redactPossibleSecrets(githubNotes);
    promptCommits = redactedCommits.commits;
    promptGithubNotes = redactedGithubNotes.text;
    redactionCount = redactedCommits.count + redactedGithubNotes.count;

    if (redactionCount > 0) {
      actionCore.warning(
        `Possible secret detected; redacted ${redactionCount} value(s) before transmission to OpenAI.`
      );
    }
  }

  const client = dependencies.createOpenAIClient({
    apiKey,
    baseURL: baseUrl,
  });

  const finalInstructions = loadPrompt("final-release.md");
  const stageInstructions = loadPrompt("stage-summary.md");

  const fullPrompt = buildPrompt(
    tag,
    previousTag,
    promptCommits,
    promptGithubNotes
  );
  let releaseNotes = "";
  let promptCharCount = fullPrompt.length;
  let usedBatching = false;

  if (fullPrompt.length <= maxStageChars) {
    releaseNotes = await generateResponseText(
      client,
      model,
      fullPrompt,
      finalInstructions,
      "final"
    );
  } else {
    usedBatching = true;
    const chunkBudget = Math.max(1000, maxStageChars - 2000);
    const chunks = chunkCommits(promptCommits, chunkBudget, logger);
    const summaries: string[] = [];

    actionCore.info(
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
      promptGithubNotes
    );
    promptCharCount = finalPrompt.length;
    releaseNotes = await generateResponseText(
      client,
      model,
      finalPrompt,
      finalInstructions,
      "final"
    );
  }

  const releaseName = releaseNameOverride || tag;

  if (!createRelease) {
    actionCore.setOutput("release_notes", releaseNotes);
    actionCore.setOutput("release_url", "");
    setDiagnosticOutputs(
      actionCore,
      previousTag,
      commitShas.length,
      promptCharCount,
      usedBatching,
      redactionCount
    );
    actionCore.info(
      "Release creation skipped because create_release is false."
    );
    return;
  }

  const release = await writeRelease(
    octokit,
    actionContext,
    tag,
    releaseName,
    releaseNotes,
    draft,
    prerelease,
    existingReleaseBehavior
  );
  actionCore.setOutput("release_notes", releaseNotes);
  actionCore.setOutput("release_url", release.html_url ?? "");
  setDiagnosticOutputs(
    actionCore,
    previousTag,
    commitShas.length,
    promptCharCount,
    usedBatching,
    redactionCount
  );

  actionCore.info(`Created or updated release ${releaseName} (${release.html_url ?? ""}).`);
}

async function run(): Promise<void> {
  try {
    await runAction({
      core,
      context,
      env: process.env,
      getOctokit: (token) => getOctokit(token) as unknown as OctokitLike,
      createOpenAIClient: (options) => new OpenAI(options),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

if (require.main === module) {
  run();
}
