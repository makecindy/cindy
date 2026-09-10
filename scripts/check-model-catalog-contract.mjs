#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const peer = process.argv[2];
if (!peer)
  throw new Error(
    "Usage: node scripts/check-model-catalog-contract.mjs /absolute/path/to/peer-worktree",
  );
const locate = (root) => {
  const dir = [
    "packages/model-providers/fixtures/published-catalog",
    "model-access-server/fixtures/published-catalog",
  ]
    .map((path) => join(root, path))
    .find(existsSync);
  if (!dir) throw new Error(`No catalog fixtures under ${root}`);
  return dir;
};
const local = locate(process.cwd()),
  other = locate(resolve(peer));
const files = readdirSync(local).sort();
if (JSON.stringify(files) !== JSON.stringify(readdirSync(other).sort()))
  throw new Error("Fixture file sets differ");
for (const file of files) {
  const hash = (root) =>
    createHash("sha256")
      .update(readFileSync(join(root, file)))
      .digest("hex");
  if (hash(local) !== hash(other))
    throw new Error(`Contract fixture mismatch: ${file}`);
}
process.stdout.write(
  `${files.length} identical contract files; run each repository's contract tests independently.\n`,
);
