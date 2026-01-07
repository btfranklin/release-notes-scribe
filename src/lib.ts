import { execFileSync } from "node:child_process";

const MAX_LINE_LENGTH = 300;

export const DEFAULT_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".m",
  ".mm",
  ".rb",
  ".php",
  ".scala",
  ".lua",
  ".sh",
  ".ps1",
  ".pl",
  ".r",
  ".dart",
  ".sql",
  ".hs",
  ".clj",
  ".cljs",
  ".erl",
  ".ex",
  ".exs",
]);

export type CommitData = {
  sha: string;
  message: string;
  diffLines: string[];
};

type FileStat = {
  path: string;
  isBinary: boolean;
  isSource: boolean;
};

export type Logger = {
  info: (message: string) => void;
  warning: (message: string) => void;
};

const noopLogger: Logger = {
  info: () => {},
  warning: () => {},
};

type GitCommandOptions = {
  allowFailure?: boolean;
  trim?: boolean;
  maxBuffer?: number;
};

export function runGit(args: string[], options: GitCommandOptions = {}): string {
  const { allowFailure = false, trim = true, maxBuffer } = options;

  try {
    const output = execFileSync("git", args, {
      encoding: "utf8",
      ...(maxBuffer ? { maxBuffer } : {}),
    });
    return trim ? output.trimEnd() : output;
  } catch (error) {
    if (allowFailure) {
      return "";
    }

    const err = error as { stderr?: string; stdout?: string; message?: string };
    const details = [err.stderr, err.stdout, err.message]
      .filter(Boolean)
      .join("\n");
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }
}

export function isShallowRepository(): boolean {
  const output = runGit(["rev-parse", "--is-shallow-repository"], {
    allowFailure: true,
  }).trim();
  return output === "true";
}

export function getTagFromRef(ref: string | undefined): string | null {
  if (!ref) {
    return null;
  }
  if (ref.startsWith("refs/tags/")) {
    return ref.slice("refs/tags/".length);
  }
  return null;
}

export function listTags(): string[] {
  const output = runGit(
    [
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname:short)",
      "refs/tags",
    ],
    { allowFailure: true }
  );
  if (!output) {
    return [];
  }
  return output.split("\n").map((tag) => tag.trim()).filter(Boolean);
}

export function resolvePreviousTag(
  currentTag: string,
  override: string,
  logger: Logger = noopLogger
): string {
  if (override) {
    const overrideExists = runGit(
      ["rev-parse", "-q", "--verify", `refs/tags/${override}`],
      { allowFailure: true }
    );
    if (!overrideExists) {
      throw new Error(
        `Override previous tag ${override} not found. Ensure tags are fetched.`
      );
    }
    return override;
  }

  const tags = listTags();
  if (!tags.length) {
    throw new Error(
      "No tags found locally. Ensure actions/checkout uses fetch-depth: 0."
    );
  }

  const index = tags.indexOf(currentTag);
  if (index === -1) {
    throw new Error(
      `Tag ${currentTag} not found in local tag list. Ensure tags are fetched.`
    );
  }

  if (index + 1 >= tags.length) {
    logger.info("No previous tag found; comparing against the empty tree.");
    return "";
  }

  return tags[index + 1];
}

export function getCommitShas(
  previousTag: string,
  currentTag: string,
  maxCommits: number,
  logger: Logger = noopLogger
): string[] {
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const output = runGit(["log", "--reverse", "--pretty=format:%H", range]);
  if (!output) {
    return [];
  }
  const commits = output.split("\n").map((sha) => sha.trim()).filter(Boolean);
  if (commits.length > maxCommits) {
    logger.warning(
      `Found ${commits.length} commits; truncating to the most recent ${maxCommits}.`
    );
    return commits.slice(commits.length - maxCommits);
  }
  return commits;
}

function formatFileStatus(status: string): string {
  if (status.startsWith("R")) {
    return "renamed";
  }
  if (status.startsWith("C")) {
    return "copied";
  }
  switch (status) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    default:
      return status;
  }
}

function fallbackFileChanges(sha: string, maxLines: number): string[] {
  const output = runGit(["show", "--name-status", "--pretty=format:", sha]);
  if (!output) {
    return [];
  }
  const results: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [status, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) {
      continue;
    }
    results.push(`${filePath}: ${formatFileStatus(status)}`);
    if (results.length >= maxLines) {
      break;
    }
  }
  return results;
}

function normalizePath(path: string): string {
  if (!path.includes("=>")) {
    return path;
  }
  const parts = path.split("=>");
  const candidate = parts[parts.length - 1]?.trim() ?? path;
  return candidate.replace(/[{}]/g, "");
}

function isSourcePath(path: string, extensions: Set<string>): boolean {
  const normalized = normalizePath(path).toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex === -1) {
    return false;
  }
  return extensions.has(normalized.slice(dotIndex));
}

function getFileStats(sha: string, extensions: Set<string>): FileStat[] {
  const output = runGit(["show", "--numstat", "--pretty=format:", sha]);
  if (!output) {
    return [];
  }
  const stats: FileStat[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [additions, deletions, ...pathParts] = line.split("\t");
    const rawPath = pathParts.join("\t");
    if (!rawPath) {
      continue;
    }
    const path = normalizePath(rawPath);
    const isBinary = additions === "-" || deletions === "-";
    const isSource = !isBinary && isSourcePath(path, extensions);
    stats.push({ path, isBinary, isSource });
  }
  return stats;
}

function summarizeNonSource(file: FileStat): string {
  if (file.isBinary) {
    return `${file.path}: binary change (diff omitted)`;
  }
  return `${file.path}: non-source change (diff omitted)`;
}

function summarizeSource(path: string): string {
  return `${path}: source change (diff omitted)`;
}

export function extractDiffLines(
  diff: string,
  maxLines: number,
  sha: string,
  allowedPaths?: Set<string>
): string[] {
  const results: string[] = [];
  let currentFile = "";
  let includeFile = true;

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentFile = match?.[2] ?? match?.[1] ?? "";
      includeFile = allowedPaths ? allowedPaths.has(currentFile) : true;
      continue;
    }

    if (!includeFile) {
      continue;
    }

    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }

    if (line.startsWith("Binary files ")) {
      const entry = currentFile ? `${currentFile}: ${line}` : line;
      results.push(entry);
    } else if (line.startsWith("+") || line.startsWith("-")) {
      if (line.startsWith("+++") || line.startsWith("---")) {
        continue;
      }
      const trimmed =
        line.length > MAX_LINE_LENGTH
          ? `${line.slice(0, MAX_LINE_LENGTH - 3)}...`
          : line;
      const entry = currentFile ? `${currentFile}: ${trimmed}` : trimmed;
      results.push(entry);
    }

    if (results.length >= maxLines) {
      break;
    }
  }

  if (!results.length) {
    return fallbackFileChanges(sha, maxLines);
  }

  return results;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function buildCommitData(
  shas: string[],
  maxDiffLines: number,
  logger: Logger = noopLogger,
  sourceExtensions: Set<string> = DEFAULT_SOURCE_EXTENSIONS
): CommitData[] {
  return shas.map((sha) => {
    const message = runGit(["log", "-1", "--pretty=format:%s%n%n%b", sha]).trim();
    const fileStats = getFileStats(sha, sourceExtensions);
    const sourcePaths = fileStats
      .filter((file) => file.isSource)
      .map((file) => file.path);
    const sourcePathSet = new Set(sourcePaths);
    const nonSourceEntries = fileStats
      .filter((file) => !file.isSource)
      .map((file) => summarizeNonSource(file));
    let diffLines: string[] = [];

    try {
      if (sourcePaths.length) {
        const diff = runGit(
          ["show", "--no-color", "--unified=0", "--pretty=format:", sha],
          { trim: false, maxBuffer: 10 * 1024 * 1024 }
        );
        diffLines = extractDiffLines(diff, maxDiffLines, sha, sourcePathSet);
      }
    } catch (error) {
      logger.warning(
        `Failed to read diff for ${sha.slice(0, 7)}: ${formatErrorMessage(
          error
        )}. Falling back to file summary.`
      );
      diffLines = sourcePaths.length
        ? sourcePaths.slice(0, maxDiffLines).map(summarizeSource)
        : [];
    }

    return {
      sha,
      message: message || "(no commit message)",
      diffLines: [...diffLines, ...nonSourceEntries].slice(0, maxDiffLines),
    };
  });
}

export function formatCommitBlock(commit: CommitData): string {
  const diffLines = commit.diffLines.length
    ? commit.diffLines
    : ["(No diff content available)"];
  const diffText = diffLines.map((line) => `- ${line}`).join("\n");
  return [
    `Commit ${commit.sha.slice(0, 7)}`,
    "The following changes had this commit message:",
    commit.message,
    "",
    "The changes in this commit were:",
    diffText,
  ].join("\n");
}

export function buildPrompt(
  currentTag: string,
  previousTag: string,
  commits: CommitData[],
  githubNotes: string
): string {
  const header = [
    `Release tag: ${currentTag}`,
    previousTag ? `Previous tag: ${previousTag}` : "Previous tag: (none)",
    `Commit count: ${commits.length}`,
    "",
  ].join("\n");

  const commitBlocks = commits.length
    ? commits.map((commit) => formatCommitBlock(commit))
    : [
        "No commits were found between the previous and current tag.",
        "Write a short placeholder release note that explains there are no code changes.",
      ];

  let prompt = `${header}${commitBlocks.join("\n\n")}`;
  if (githubNotes) {
    prompt += `\n\nGitHub auto-generated notes (extra context, do not quote verbatim):\n${githubNotes}`;
  }

  return prompt;
}

export function extractResponseText(response: any): string {
  if (response?.output_text) {
    return response.output_text;
  }

  const output = response?.output;
  if (Array.isArray(output)) {
    const textItems = output
      .filter((item) => item?.type === "output_text")
      .map((item) => item?.text)
      .filter((text) => typeof text === "string");

    if (textItems.length) {
      return textItems.join("\n");
    }
  }

  return "";
}
