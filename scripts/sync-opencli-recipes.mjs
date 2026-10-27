#!/usr/bin/env node
// Import a reviewed OpenCLI checkout, including every adapter and its helpers.
// No network access, package install hooks, or adapter execution during sync.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: node scripts/sync-opencli-recipes.mjs <opencli-checkout>",
  );
const upstream = path.resolve(source);
const revision = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (
  execFileSync("git", ["-C", upstream, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim()
) {
  throw new Error("OpenCLI checkout must be clean");
}
const target = path.join(root, "packages/opencli-vendor");
// Refuse to discard locally edited source on later synchronizations.
try {
  const previous = JSON.parse(
    await readFile(path.join(target, "UPSTREAM.json"), "utf8"),
  );
  for (const [name, expected] of Object.entries(previous.files)) {
    const bytes = await readFile(path.join(target, name));
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Local vendor edit: ${name}`);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const manifest = JSON.parse(
  await readFile(path.join(upstream, "cli-manifest.json"), "utf8"),
);
const originalPackage = JSON.parse(
  await readFile(path.join(upstream, "package.json"), "utf8"),
);
const hashes = {};
const contents = new Map();
async function copy(relative) {
  const from = path.join(upstream, relative);
  const bytes = await readFile(from);
  contents.set(relative, bytes);
  hashes[relative] = createHash("sha256").update(bytes).digest("hex");
}
async function walk(relative) {
  for (const entry of (
    await readdir(path.join(upstream, relative), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!["__tests__", "__fixtures__"].includes(entry.name)) await walk(next);
    } else if (entry.isFile()) {
      if (
        !/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name) &&
        !/^(test-utils|test-dom-utils)\.js$/.test(entry.name)
      )
        await copy(next);
    } else throw new Error(`Unsupported upstream file: ${next}`);
  }
}
await walk("clis");
await walk("src");
await copy("LICENSE");
await copy("cli-manifest.json");
const patches = JSON.parse(
  await readFile(path.join(target, "cindy/patches.json"), "utf8"),
);
const patched = {};
for (const patch of patches) {
  if (!hashes[patch.file])
    throw new Error(`Patch is outside imported source: ${patch.file}`);
  const before = contents.get(patch.file).toString('utf8');
  if (before.split(patch.before).length - 1 !== (patch.count ?? 1))
    throw new Error(`Upstream changed; review patch: ${patch.file}`);
  patched[patch.file] ??= { upstreamSha256: hashes[patch.file] };
  const after = before.split(patch.before).join(patch.after);
  contents.set(patch.file, Buffer.from(after));
  hashes[patch.file] = createHash("sha256").update(after).digest("hex");
}
contents.set('package.upstream.json', await readFile(path.join(upstream, 'package.json')));
const exports = Object.fromEntries(
  Object.entries(originalPackage.exports)
    .filter(([name]) => name !== ".")
    .map(([name, value]) => [
      name,
      value.replace("./dist/", "./").replace(/\.js$/, ".ts"),
    ]),
);
exports["./cindy"] = "./cindy/index.ts";
exports["./catalog"] = "./cindy/catalog.ts";
exports["./cindy/host"] = "./cindy/host.ts";
const pkg = {
  name: originalPackage.name,
  version: originalPackage.version,
  private: true,
  type: "module",
  license: originalPackage.license,
  exports,
  dependencies: {
    ...originalPackage.dependencies,
    "@cindy/browser-control-runtime": "workspace:*",
  },
  devDependencies: {
    "@types/turndown": originalPackage.devDependencies["@types/turndown"],
    "@types/js-yaml": originalPackage.devDependencies["@types/js-yaml"],
  },
};
const commands = new Set();
for (const command of manifest) {
  const id = `${command.site}/${command.name}`;
  if (commands.has(id)) throw new Error(`Duplicate command: ${id}`);
  commands.add(id);
  if (!hashes[`clis/${command.modulePath}`])
    throw new Error(`Missing adapter: ${id}`);
}
// Validate source, manifest and every patch before replacing the previous snapshot.
for (const directory of ['clis', 'src']) await rm(path.join(target, directory), { recursive: true, force: true });
for (const [name, bytes] of contents) {
  const filename = path.join(target, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
}
await writeFile(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
await writeFile(
  path.join(target, "UPSTREAM.json"),
  JSON.stringify(
    {
      repository: "https://github.com/jackwener/opencli",
      revision,
      version: originalPackage.version,
      commands: manifest.length,
      sites: new Set(manifest.map((c) => c.site)).size,
      read: manifest.filter((c) => c.access === "read").length,
      write: manifest.filter((c) => c.access === "write").length,
      patches: patched,
      files: hashes,
    },
    null,
    2,
  ) + "\n",
);
// Keep the complete upstream snapshot, but only ship Cindy's selected adapters.
// This policy lives outside the snapshot so a later sync cannot undo exclusions.
const selection = JSON.parse(await readFile(path.join(target, 'cindy/selection.json'), 'utf8'));
// Explicit static imports let Vite bundle selected adapters without relying on
// runtime filesystem paths, npm installs, or importing upstream test helpers.
const modules = [...new Set(manifest.filter(c => !(c.site in selection.excludedSites)
  && !(selection.excludedCommands ?? []).includes(`${c.site}/${c.name}`)).map((c) => c.modulePath))].sort();
await mkdir(path.join(target, "cindy"), { recursive: true });
await rm(path.join(target, "cindy/modules.ts"), { force: true });
await writeFile(
  path.join(target, "cindy/modules.d.ts"),
  "export const modules: Record<string, true>;\n",
);
await writeFile(
  path.join(target, "cindy/modules.js"),
  "// Generated by scripts/sync-opencli-recipes.mjs.\n" +
    modules.map(m => `import ${JSON.stringify(`../clis/${m}`)};`).join("\n") + "\n" +
    "export const modules = {\n" +
    modules
      .map(
        (m) =>
          `  ${JSON.stringify(m)}: true,`,
      )
      .join("\n") +
    "\n};\n",
);
console.log(
  JSON.stringify({
    revision,
    commands: commands.size,
    modules: modules.length,
    files: Object.keys(hashes).length,
  }),
);
