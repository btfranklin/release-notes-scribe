import { readFileSync, writeFileSync } from "node:fs";

const readmePath = new URL("../README.md", import.meta.url);
const actionPath = new URL("../action.yml", import.meta.url);

const START = "<!-- action-reference:start -->";
const END = "<!-- action-reference:end -->";

function parseActionYaml(source) {
  const lines = source.split("\n");
  const sections = {
    inputs: {},
    outputs: {},
  };
  let section = "";
  let current = "";

  for (const line of lines) {
    if (line === "inputs:" || line === "outputs:") {
      section = line.slice(0, -1);
      current = "";
      continue;
    }
    if (/^[A-Za-z_]+:/.test(line) && line !== "inputs:" && line !== "outputs:") {
      section = "";
      current = "";
      continue;
    }
    if (!section) {
      continue;
    }

    const itemMatch = /^  ([A-Za-z0-9_]+):$/.exec(line);
    if (itemMatch) {
      current = itemMatch[1];
      sections[section][current] = {};
      continue;
    }

    const fieldMatch = /^    ([A-Za-z_]+): "?([^"]*)"?$/.exec(line);
    if (current && fieldMatch) {
      sections[section][current][fieldMatch[1]] = fieldMatch[2];
    }
  }

  return sections;
}

function renderInput(name, data) {
  const parts = [`- \`${name}\``];
  if (data.required === "true") {
    parts.push("(required)");
  }
  parts.push(`: ${data.description}`);
  if (data.default !== undefined && data.default !== "") {
    parts.push(` Default: \`${data.default}\`.`);
  }
  return parts.join("");
}

function renderOutput(name, data) {
  return `- \`${name}\`: ${data.description}`;
}

function buildReference(action) {
  const inputLines = Object.entries(action.inputs).map(([name, data]) =>
    renderInput(name, data)
  );
  const outputLines = Object.entries(action.outputs).map(([name, data]) =>
    renderOutput(name, data)
  );

  return [
    START,
    "## Inputs",
    "",
    ...inputLines,
    "",
    "## Outputs",
    "",
    ...outputLines,
    END,
  ].join("\n");
}

const readme = readFileSync(readmePath, "utf8");
const action = parseActionYaml(readFileSync(actionPath, "utf8"));
const reference = buildReference(action);
const pattern = new RegExp(`${START}[\\s\\S]*${END}`);

if (!pattern.test(readme)) {
  throw new Error(`README.md is missing ${START}/${END} markers.`);
}

const nextReadme = readme.replace(pattern, reference);
if (process.argv.includes("--check")) {
  if (nextReadme !== readme) {
    throw new Error("README action reference is stale. Run npm run docs:reference.");
  }
} else {
  writeFileSync(readmePath, nextReadme);
}
