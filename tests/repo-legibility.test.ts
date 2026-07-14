import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

function readYaml<T>(path: string): T {
  return parse(read(path)) as T;
}

type ActionMetadata = {
  inputs: Record<string, { default?: string }>;
  runs: {
    using: string;
    main: string;
  };
};

type WorkflowStep = {
  uses?: string;
  with?: Record<string, string | number>;
};

type Workflow = {
  on?: {
    push?: {
      tags?: string[];
    };
  };
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};

function actionDefault(input: string): string {
  const action = readYaml<ActionMetadata>("action.yml");
  const metadata = action.inputs[input];
  if (!metadata) {
    throw new Error(`action.yml is missing input ${input}.`);
  }
  if (metadata.default !== undefined) {
    return String(metadata.default);
  }

  throw new Error(`action.yml input ${input} is missing a default.`);
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

describe("documentation governance", () => {
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
      "the current legibility guardrails should be discoverable"
    );
    requireText(
      "AGENTS.md",
      "Current legibility guardrails",
      "AGENTS.md should route to current-state guardrails"
    );
    requireText(
      "docs/index.md",
      "npm run docs:reference",
      "README action reference generation should be documented"
    );
  });

  it("keeps AGENTS.md short enough to be a route map", () => {
    const lines = read("AGENTS.md")
      .split("\n")
      .filter((line) => line.trim());

    expect(lines.length).toBeLessThanOrEqual(45);
  });

  it("keeps generated README defaults aligned with action metadata", () => {
    const defaults = [
      "model",
      "include_github_generated_notes",
      "max_diff_lines",
      "max_commits",
      "max_stage_chars",
      "draft",
      "prerelease",
      "create_release",
      "existing_release_behavior",
      "redact_secrets",
    ];

    for (const input of defaults) {
      expect(readmeDefault(input)).toBe(actionDefault(input));
    }

    requireText(
      "docs/architecture.md",
      "existing_release_behavior",
      "rerun behavior is part of the public action contract"
    );
    requireText(
      "docs/architecture.md",
      "create_release: false",
      "output-only generation is part of the public action contract"
    );
    requireText(
      "docs/architecture.md",
      "redact_secrets",
      "redaction behavior is part of the public action contract"
    );
  });

  it("keeps README action reference generated from action.yml", () => {
    execFileSync("node", ["scripts/update-readme-reference.mjs", "--check"], {
      cwd: root,
      stdio: "pipe",
    });
  });

  it("documents the self-hosted release workflow contract", () => {
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

  it("documents the JavaScript action runtime", () => {
    requireText(
      "docs/architecture.md",
      "Node 24",
      "architecture docs should name the declared action runtime"
    );
  });

  it("keeps the legibility audit focused on current state", () => {
    const audit = read("docs/legibility-audit.md");

    expect(audit).not.toContain("Remaining Gaps");
    expect(audit).not.toContain("Next Investments");
    expect(audit).not.toContain("generated inventory");
    expect(audit).not.toContain("prompt policy grows");
  });
});

describe("runtime metadata and packaging contracts", () => {
  it("preserves the parsed self-hosted release workflow contract", () => {
    const workflow = readYaml<Workflow>(".github/workflows/release.yml");
    const releaseJob = workflow.jobs["draft-release"];
    const steps = releaseJob?.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@")
    );

    expect(workflow.on?.push?.tags).toContain("v*.*.*");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(steps.some((step) => step.uses === "./")).toBe(true);
  });

  it("aligns the parsed action runtime, entrypoint, and CI Node version", () => {
    const action = readYaml<ActionMetadata>("action.yml");
    const workflow = readYaml<Workflow>(".github/workflows/build.yml");
    const runtimeVersion = /^node(\d+)$/.exec(action.runs.using)?.[1];
    const setupNode = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/setup-node@"));

    expect(runtimeVersion).toBeDefined();
    expect(String(setupNode?.with?.["node-version"])).toBe(runtimeVersion);
    expect(action.runs.main).toBe("dist/index.js");
    expect(existsSync(join(root, action.runs.main))).toBe(true);
  });

  it("loads packaged prompt assets through the built action entrypoint", () => {
    execFileSync(process.execPath, ["-e", 'require("./dist/index.js")'], {
      cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: "false" },
      stdio: "pipe",
    });
  });
});
