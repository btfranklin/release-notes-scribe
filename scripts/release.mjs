import { execFileSync } from "node:child_process";

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

function output(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();
}

function die(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) {
  die("Usage: node scripts/release.mjs <tag> [--move-major-tag] [--skip-tests]");
}

const tag = args[0];
const moveMajorTag = args.includes("--move-major-tag");
const skipTests = args.includes("--skip-tests");

if (!/^v\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/.test(tag)) {
  die("Tag must match vMAJOR.MINOR.PATCH (e.g., v0.1.0). Prerelease/build ok.");
}

const version = tag.slice(1);

const status = output("git", ["status", "--porcelain"]);
if (status) {
  die("Working tree is not clean. Commit or stash changes before releasing.");
}

const existingTag = output("git", ["tag", "--list", tag]);
if (existingTag) {
  die(`Tag ${tag} already exists.`);
}

const branch = output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") {
  console.warn(`Warning: releasing from branch '${branch}', expected 'main'.`);
}

run("npm", ["version", "--no-git-tag-version", version]);

if (!skipTests) {
  run("npm", ["test"]);
}

run("npm", ["run", "build"]);

run("git", ["add", "package.json", "package-lock.json", "dist/"]);

const postStatus = output("git", ["status", "--porcelain"]);
if (postStatus) {
  run("git", ["commit", "-m", `chore: release ${tag}`]);
} else {
  console.log("No changes to commit after version/build steps.");
}

run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", tag]);

if (moveMajorTag) {
  const majorMatch = /^v(\d+)\./.exec(tag);
  if (!majorMatch) {
    die("Unable to derive major tag from version.");
  }
  const majorTag = `v${majorMatch[1]}`;
  run("git", ["tag", "-f", majorTag]);
  run("git", ["push", "-f", "origin", majorTag]);
}
