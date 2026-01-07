import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCommitData,
  buildPrompt,
  extractResponseText,
  getCommitShas,
  getTagFromRef,
  resolvePreviousTag,
} from "../src/lib";

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

  it("extracts text from Responses API shapes", () => {
    expect(extractResponseText({ output_text: "hello" })).toBe("hello");
    expect(
      extractResponseText({
        output: [{ type: "output_text", text: "hi" }],
      })
    ).toBe("hi");
  });
});
