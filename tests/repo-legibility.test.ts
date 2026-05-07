import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function requireFile(path: string): void {
  if (!existsSync(join(root, path))) {
    throw new Error(`${path} is missing. Restore the documented repo map.`);
  }
}

function requireText(sourcePath: string, expected: string, reason: string): void {
  const source = read(sourcePath);
  if (!source.includes(expected)) {
    throw new Error(`${sourcePath} must mention ${expected}: ${reason}`);
  }
}

function actionDefault(input: string): string {
  const lines = read("action.yml").split("\n");
  const start = lines.findIndex((line) => line === `  ${input}:`);
  if (start === -1) {
    throw new Error(`action.yml is missing input ${input}.`);
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_]+:/.test(line)) {
      break;
    }
    const match = /^    default: "([^"]*)"/.exec(line);
    if (match) {
      return match[1];
    }
  }

  throw new Error(`action.yml input ${input} is missing a quoted default.`);
}

function readmeDefault(input: string): string {
  const line = read("README.md")
    .split("\n")
    .find((candidate) => candidate.startsWith(`- \`${input}\``));
  if (!line) {
    throw new Error(`README.md is missing input documentation for ${input}.`);
  }

  const match = /Default: `([^`]+)`/.exec(line);
  if (!match) {
    throw new Error(`README.md input ${input} is missing a default value.`);
  }
  return match[1];
}

describe("repo legibility", () => {
  it("keeps a discoverable docs spine", () => {
    const docs = [
      "docs/index.md",
      "docs/architecture.md",
      "docs/development.md",
      "docs/releasing.md",
      "docs/legibility-audit.md",
    ];

    for (const doc of docs) {
      requireFile(doc);
    }

    requireText("AGENTS.md", "docs/index.md", "agents need a docs entry point");
    requireText(
      "AGENTS.md",
      "docs/architecture.md",
      "architecture knowledge should not live only in source"
    );
    requireText(
      "AGENTS.md",
      "docs/development.md",
      "validation and release commands need a durable route"
    );
    requireText(
      "AGENTS.md",
      "docs/releasing.md",
      "release ordering should be explicit because the repo dogfoods itself"
    );
    requireText(
      "docs/index.md",
      "docs/legibility-audit.md",
      "the current legibility backlog should be discoverable"
    );
  });

  it("keeps AGENTS.md short enough to be a route map", () => {
    const lines = read("AGENTS.md")
      .split("\n")
      .filter((line) => line.trim());

    expect(lines.length).toBeLessThanOrEqual(45);
  });

  it("keeps README defaults aligned with action metadata", () => {
    const defaults = [
      "model",
      "include_github_generated_notes",
      "max_diff_lines",
      "max_commits",
      "max_stage_chars",
      "draft",
      "prerelease",
    ];

    for (const input of defaults) {
      expect(readmeDefault(input)).toBe(actionDefault(input));
    }

    requireText(
      "src/index.ts",
      `core.getInput("model") || "${actionDefault("model")}"`,
      "runtime fallback must match the documented action default"
    );
  });

  it("documents and preserves the self-hosted release workflow contract", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain('tags:\n      - "v*.*.*"');
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("uses: ./");

    requireText(
      "docs/development.md",
      "uses: ./",
      "the release workflow dogfoods the local action"
    );
    requireText(
      "docs/releasing.md",
      "uses: ./",
      "the release instructions must explain self-use of this action"
    );
    requireText(
      "docs/releasing.md",
      "v*.*.*",
      "release instructions must preserve the semantic-tag workflow boundary"
    );
  });

  it("keeps the JavaScript action runtime aligned with CI", () => {
    requireText(
      "action.yml",
      'using: "node24"',
      "GitHub Actions currently supports Node 24 for JavaScript actions"
    );
    requireText(
      ".github/workflows/build.yml",
      "node-version: 24",
      "CI should build and test on the declared action runtime"
    );
    requireText(
      "docs/architecture.md",
      "Node 24",
      "architecture docs should name the declared action runtime"
    );
  });
});
