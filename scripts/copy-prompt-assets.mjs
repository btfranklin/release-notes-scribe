import { cpSync, mkdirSync } from "node:fs";

const source = new URL("../src/prompts/", import.meta.url);
const target = new URL("../dist/prompts/", import.meta.url);

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
