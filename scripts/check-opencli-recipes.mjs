// Full offline coverage check: import every command without executing it.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "packages/opencli-vendor");
const upstream = JSON.parse(
  await readFile(path.join(vendor, "UPSTREAM.json"), "utf8"),
);
for (const [name, expected] of Object.entries(upstream.files)) {
  const bytes = await readFile(path.join(vendor, name));
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Upstream source changed: ${name}`);
}
const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  ssr: { noExternal: ["@jackwener/opencli"] },
  logLevel: "error",
});
try {
  const { catalog, loadAdapter } = await server.ssrLoadModule(
    "/packages/opencli-vendor/cindy/index.ts",
  );
  const failures = [];
  const { upstreamCatalog, excludedSites, excludedCommands } = await server.ssrLoadModule('/packages/opencli-vendor/cindy/catalog.ts');
  // Verify even deliberately excluded sources: full import and product selection
  // are separate contracts, and neither may silently lose a command.
  for (const entry of upstreamCatalog) {
    if (entry.site in excludedSites || excludedCommands.has(`${entry.site}/${entry.name}`))
      await server.ssrLoadModule(`/packages/opencli-vendor/clis/${entry.modulePath}`);
  }
  for (const entry of catalog) {
    const id = `${entry.site}/${entry.name}`;
    try {
      const command = await loadAdapter(id);
      if (command.access !== entry.access)
        throw new Error("Access metadata mismatch");
    } catch (error) {
      failures.push({ id, message: String(error) });
    }
  }
  const { getRegistry } = await server.ssrLoadModule(
    "/packages/opencli-vendor/src/registry.ts",
  );
  const manifestIds = new Set(
    catalog.flatMap(entry => [entry.name, ...(entry.aliases ?? [])].map(name => `${entry.site}/${name}`)),
  );
  const allManifestIds = new Set(upstreamCatalog.flatMap(entry => [entry.name, ...(entry.aliases ?? [])].map(name => `${entry.site}/${name}`)));
  for (const id of getRegistry().keys()) {
    if (!allManifestIds.has(id))
      failures.push({
        id,
        message: "Registered command missing from upstream manifest",
      });
    else if (manifestIds.has(id)) await loadAdapter(id);
  }
  const { loadRecipes, loadSiteGuides } = await server.ssrLoadModule(
    "/packages/lizi-mcps/src/browser/recipe-loader.ts",
  );
  const recipes = loadRecipes();
  const guides = loadSiteGuides();
  const discoverable = new Set(
    [...guides.values()].flatMap((guide) => guide.recipes ?? []),
  );
  for (const id of allManifestIds) {
    if (!getRegistry().has(id)) failures.push({ id, message: 'Upstream command did not register' });
    if (!manifestIds.has(id) && (recipes.has(`opencli:${id}`) || discoverable.has(`opencli:${id}`)))
      failures.push({ id, message: 'Excluded command leaked into product catalog' });
  }
  for (const commandId of manifestIds) {
    const id = `opencli:${commandId}`;
    if (!recipes.has(id) || !discoverable.has(id))
      failures.push({ id, message: "Recipe not runnable/discoverable" });
  }
  const result = {
    revision: upstream.revision,
    upstreamCommands: upstreamCatalog.length,
    includedCommands: catalog.length,
    excludedCommands: upstreamCatalog.length - catalog.length,
    aliases: manifestIds.size - catalog.length,
    recipes: recipes.size,
    guides: guides.size,
    sourceFiles: Object.keys(upstream.files).length,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length || upstreamCatalog.length !== upstream.commands)
    process.exitCode = 1;
} finally {
  await server.close();
}
