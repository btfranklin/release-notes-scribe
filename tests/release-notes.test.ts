import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runAction, type ActionDependencies } from "../src/index";
import {
  buildCommitData,
  buildPrompt,
  extractResponseText,
  getCommitShas,
  getTagFromRef,
  REDACTION_PLACEHOLDER,
  redactPossibleSecrets,
  resolvePreviousTag,
} from "../src/lib";

const root = process.cwd();

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "scribe-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Release Notes Scribe"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.email", "scribe@example.com"], {
    cwd: dir,
  });
  return dir;
}

function commitFile(
  repo: string,
  filename: string,
  content: string,
  message: string,
  sequence: number
): void {
  const filePath = join(repo, filename);
  writeFileSync(filePath, content);
  execFileSync("git", ["add", filename], { cwd: repo });

  const date = new Date(Date.UTC(2020, 0, 1, 0, 0, sequence)).toISOString();
  execFileSync("git", ["commit", "-m", message, "--date", date], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function createTag(repo: string, tag: string, sequence: number): void {
  const date = new Date(Date.UTC(2020, 0, 2, 0, 0, sequence)).toISOString();
  execFileSync("git", ["tag", "-a", tag, "-m", tag], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_DATE: date,
    },
  });
}

function currentHead(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

function readPrompt(name: string): string {
  return readFileSync(join(root, "src", "prompts", name), "utf8").trim();
}

async function withRepo<T>(fn: (repo: string) => T | Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const repo = initRepo();
  process.chdir(repo);
  try {
    return await fn(repo);
  } finally {
    process.chdir(cwd);
  }
}

type MockRelease = {
  id: number;
  html_url: string;
  draft: boolean;
};

function makeCore(inputs: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const info: string[] = [];
  const warnings: string[] = [];
  return {
    outputs,
    info,
    warnings,
    core: {
      getInput: (name: string) => inputs[name] ?? "",
      info: (message: string) => info.push(message),
      warning: (message: string) => warnings.push(message),
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setFailed: () => {
        throw new Error("setFailed should not be called by runAction.");
      },
    },
  };
}

function makeOpenAIClient() {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      responses: {
        create: async (args: unknown) => {
          calls.push(args);
          return { output_text: "## What's Changed\n\n- Generated notes" };
        },
      },
    },
  };
}

function makeOctokit(existingRelease?: MockRelease) {
  const calls = {
    getReleaseByTag: [] as unknown[],
    createRelease: [] as unknown[],
    updateRelease: [] as unknown[],
    generateReleaseNotes: [] as unknown[],
  };
  return {
    calls,
    octokit: {
      rest: {
        repos: {
          generateReleaseNotes: async (args: unknown) => {
            calls.generateReleaseNotes.push(args);
            return { data: { body: "GitHub notes" } };
          },
          getReleaseByTag: async (args: unknown) => {
            calls.getReleaseByTag.push(args);
            if (!existingRelease) {
              const error = new Error("Not Found") as Error & { status: number };
              error.status = 404;
              throw error;
            }
            return { data: existingRelease };
          },
          createRelease: async (args: unknown) => {
            calls.createRelease.push(args);
            return {
              data: {
                id: 1,
                html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
                draft: true,
              },
            };
          },
          updateRelease: async (args: unknown) => {
            calls.updateRelease.push(args);
            return {
              data: {
                id: existingRelease?.id ?? 1,
                html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
                draft: existingRelease?.draft ?? true,
              },
            };
          },
        },
      },
    },
  };
}

async function runMockedAction(
  repo: string,
  inputs: Record<string, string> = {},
  existingRelease?: MockRelease
) {
  const coreMock = makeCore({
    openai_api_key: "openai-key",
    github_token: "github-token",
    tag: "v1.1.0",
    ...inputs,
  });
  const openAI = makeOpenAIClient();
  const github = makeOctokit(existingRelease);

  await runAction({
    core: coreMock.core,
    context: {
      ref: "refs/tags/v1.1.0",
      sha: currentHead(repo),
      repo: {
        owner: "acme",
        repo: "widgets",
      },
    },
    env: {},
    getOctokit: () => github.octokit,
    createOpenAIClient: () => openAI.client,
  } as ActionDependencies);

  return { coreMock, openAI, github };
}

function openAIInput(openAI: ReturnType<typeof makeOpenAIClient>): string {
  return (openAI.calls[0] as { input: string }).input;
}

function openAIInstructions(openAI: ReturnType<typeof makeOpenAIClient>): string {
  return (openAI.calls[0] as { instructions: string }).instructions;
}

describe.sequential("release notes helpers", () => {
  it("parses tag names from refs", () => {
    expect(getTagFromRef("refs/tags/v1.2.3")).toBe("v1.2.3");
    expect(getTagFromRef("refs/heads/main")).toBeNull();
  });

  it("resolves the previous tag", async () =>
    withRepo((repo) => {
      commitFile(repo, "file.txt", "one", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.txt", "two", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      const previous = resolvePreviousTag("v1.1.0", "");
      expect(previous).toBe("v1.0.0");
    }));

  it("resolves the nearest reachable semantic previous tag", async () =>
    withRepo((repo) => {
      commitFile(repo, "file.txt", "one", "feat: first", 1);
      createTag(repo, "v1.0.0", 10);
      commitFile(repo, "file.txt", "two", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);
      commitFile(repo, "file.txt", "three", "feat: third", 3);
      createTag(repo, "v1.2.0", 1);

      const previous = resolvePreviousTag("v1.2.0", "");
      expect(previous).toBe("v1.1.0");
    }));

  it("ignores moving major tags when resolving the previous tag", async () =>
    withRepo((repo) => {
      commitFile(repo, "file.txt", "one", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.txt", "two", "feat: second", 2);
      createTag(repo, "v1", 3);
      createTag(repo, "v1.1.0", 2);

      const previous = resolvePreviousTag("v1.1.0", "");
      expect(previous).toBe("v1.0.0");
    }));

  it("throws when the override tag is missing", async () =>
    withRepo((repo) => {
      commitFile(repo, "file.txt", "one", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);

      expect(() => resolvePreviousTag("v1.0.0", "v9.9.9")).toThrow(
        "Override previous tag v9.9.9 not found."
      );
    }));

  it("collects commits between tags", async () =>
    withRepo((repo) => {
      commitFile(repo, "file.txt", "one", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.txt", "two", "fix: second", 2);
      createTag(repo, "v1.1.0", 2);

      const shas = getCommitShas("v1.0.0", "v1.1.0", 10);
      expect(shas).toHaveLength(1);
    }));

  it("builds prompts from commit data", async () =>
    withRepo((repo) => {
      commitFile(repo, "file.txt", "one", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);

      const shas = getCommitShas("", "v1.0.0", 10);
      const commits = buildCommitData(shas, 50);
      const prompt = buildPrompt("v1.0.0", "", commits, "");

      expect(prompt).toContain("The following changes had this commit message:");
      expect(prompt).toContain("feat: first");
      expect(prompt).toContain("The changes in this commit were:");
    }));

  it("summarizes non-source files by filename only", async () =>
    withRepo((repo) => {
      commitFile(repo, "README.md", "docs", "docs: update readme", 1);
      createTag(repo, "v1.0.0", 1);

      const shas = getCommitShas("", "v1.0.0", 10);
      const commits = buildCommitData(shas, 50);

      expect(commits[0].diffLines.join("\n")).toContain(
        "README.md: non-source change (diff omitted)"
      );
      expect(commits[0].diffLines.join("\n")).not.toContain("+docs");
    }));

  it("extracts text from Responses API shapes", () => {
    expect(extractResponseText({ output_text: "hello" })).toBe("hello");
    expect(
      extractResponseText({
        output: [{ type: "output_text", text: "hi" }],
      })
    ).toBe("hi");
  });

  it("redacts high-confidence secrets while preserving normal text", () => {
    const openAiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const bearerToken = "abcdefghijklmnopqrstuvwxyz123456";
    const webhookSecret = ["whsec", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const stripeKey = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const githubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
    const privateKeyBlock = [
      "-----BEGIN " + "PRIVATE KEY-----",
      "abc123",
      "-----END " + "PRIVATE KEY-----",
    ].join("\n");
    const original = [
      "Release keeps normal feature notes.",
      `OPENAI_API_KEY=${openAiKey}`,
      `Authorization: Bearer ${bearerToken}`,
      `webhook=${webhookSecret}`,
      `stripe=${stripeKey}`,
      `github=${githubToken}`,
      privateKeyBlock,
    ].join("\n");

    const redacted = redactPossibleSecrets(original);

    expect(redacted.count).toBeGreaterThanOrEqual(6);
    expect(redacted.text).toContain("Release keeps normal feature notes.");
    expect(redacted.text).toContain(REDACTION_PLACEHOLDER);
    expect(redacted.text).not.toContain(openAiKey);
    expect(redacted.text).not.toContain(githubToken);
    expect(redacted.text).not.toContain("abc123");
  });
});

describe.sequential("action orchestration", () => {
  it("creates a release and sets outputs", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.ts", "export const two = 2;", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      const { coreMock, github, openAI } = await runMockedAction(repo);

      expect(openAI.calls).toHaveLength(1);
      expect(openAIInstructions(openAI)).toBe(readPrompt("final-release.md"));
      expect(github.calls.getReleaseByTag).toHaveLength(1);
      expect(github.calls.createRelease).toHaveLength(1);
      expect(github.calls.updateRelease).toHaveLength(0);
      expect(coreMock.outputs.release_notes).toContain("Generated notes");
      expect(coreMock.outputs.release_url).toBe(
        "https://github.com/acme/widgets/releases/tag/v1.1.0"
      );
      expect(coreMock.outputs.previous_tag).toBe("v1.0.0");
      expect(coreMock.outputs.commit_count).toBe("1");
      expect(coreMock.outputs.prompt_char_count).toMatch(/^\d+$/);
      expect(coreMock.outputs.used_batching).toBe("false");
      expect(coreMock.outputs.redaction_count).toBe("0");
    }));

  it("generates notes without writing a release when create_release is false", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.ts", "export const two = 2;", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      const { coreMock, github } = await runMockedAction(repo, {
        create_release: "false",
      });

      expect(github.calls.getReleaseByTag).toHaveLength(0);
      expect(github.calls.createRelease).toHaveLength(0);
      expect(github.calls.updateRelease).toHaveLength(0);
      expect(coreMock.outputs.release_notes).toContain("Generated notes");
      expect(coreMock.outputs.release_url).toBe("");
      expect(coreMock.outputs.previous_tag).toBe("v1.0.0");
      expect(coreMock.outputs.commit_count).toBe("1");
      expect(coreMock.outputs.used_batching).toBe("false");
    }));

  it("updates an existing draft release by default", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.ts", "export const two = 2;", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      const { github } = await runMockedAction(repo, {}, {
        id: 7,
        html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
        draft: true,
      });

      expect(github.calls.createRelease).toHaveLength(0);
      expect(github.calls.updateRelease).toHaveLength(1);
      expect(github.calls.updateRelease[0]).toMatchObject({
        release_id: 7,
        tag_name: "v1.1.0",
      });
    }));

  it("fails on an existing published release by default", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.ts", "export const two = 2;", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      await expect(
        runMockedAction(repo, {}, {
          id: 7,
          html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
          draft: false,
        })
      ).rejects.toThrow("already exists and is not a draft");
    }));

  it("fails on any existing release when configured to fail", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.ts", "export const two = 2;", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      await expect(
        runMockedAction(repo, { existing_release_behavior: "fail" }, {
          id: 7,
          html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
          draft: true,
        })
      ).rejects.toThrow("Release v1.1.0 already exists.");
    }));

  it("updates a published release when configured to update any release", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(repo, "file.ts", "export const two = 2;", "feat: second", 2);
      createTag(repo, "v1.1.0", 2);

      const { github } = await runMockedAction(
        repo,
        { existing_release_behavior: "update_any" },
        {
          id: 7,
          html_url: "https://github.com/acme/widgets/releases/tag/v1.1.0",
          draft: false,
        }
      );

      expect(github.calls.createRelease).toHaveLength(0);
      expect(github.calls.updateRelease).toHaveLength(1);
    }));

  it("redacts secrets from OpenAI input by default and logs a summary", async () =>
    withRepo(async (repo) => {
      const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
      commitFile(repo, "file.ts", `export const token = "${secret}";`, "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(
        repo,
        "file.ts",
        `export const rotatedToken = "${secret}";`,
        `fix: rotate ${secret}`,
        2
      );
      createTag(repo, "v1.1.0", 2);

      const { coreMock, openAI } = await runMockedAction(repo, {
        create_release: "false",
      });

      expect(openAIInput(openAI)).toContain(REDACTION_PLACEHOLDER);
      expect(openAIInput(openAI)).not.toContain(secret);
      expect(Number.parseInt(coreMock.outputs.redaction_count, 10)).toBeGreaterThan(0);
      const redactionWarning = coreMock.warnings.find((warning) =>
        warning.includes("Possible secret detected")
      );
      expect(redactionWarning).toContain("redacted");
      expect(redactionWarning).not.toContain(secret);
    }));

  it("keeps OpenAI input unredacted when redaction is disabled", async () =>
    withRepo(async (repo) => {
      const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(
        repo,
        "file.ts",
        `export const token = "${secret}";`,
        `fix: keep ${secret}`,
        2
      );
      createTag(repo, "v1.1.0", 2);

      const { coreMock, openAI } = await runMockedAction(repo, {
        create_release: "false",
        redact_secrets: "false",
      });

      expect(openAIInput(openAI)).toContain(secret);
      expect(coreMock.outputs.redaction_count).toBe("0");
      expect(
        coreMock.warnings.some((warning) =>
          warning.includes("Possible secret detected")
        )
      ).toBe(false);
    }));

  it("sets batching diagnostics for large prompts", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.0.0", 1);
      commitFile(
        repo,
        "file.ts",
        Array.from({ length: 150 }, (_, index) => `export const v${index} = ${index};`).join("\n"),
        "feat: large change",
        2
      );
      createTag(repo, "v1.1.0", 2);

      const { coreMock, openAI } = await runMockedAction(repo, {
        create_release: "false",
        max_stage_chars: "1000",
      });

      expect(openAI.calls.length).toBeGreaterThan(1);
      expect(coreMock.outputs.used_batching).toBe("true");
      expect(coreMock.outputs.prompt_char_count).toMatch(/^\d+$/);
    }));

  it("sets an empty previous_tag output for the first release", async () =>
    withRepo(async (repo) => {
      commitFile(repo, "file.ts", "export const one = 1;", "feat: first", 1);
      createTag(repo, "v1.1.0", 1);

      const { coreMock } = await runMockedAction(repo, {
        create_release: "false",
      });

      expect(coreMock.outputs.previous_tag).toBe("");
      expect(coreMock.outputs.commit_count).toBe("1");
    }));
});
