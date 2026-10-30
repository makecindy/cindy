// cindy_browser MCP 面(L2)。改这块前先读维护者指南:
// packages/browser-control-runtime/upstream/MAINTAINING.md
export * from './server.js';
export * from './tool-registry.js';
export * from './tools.js';
// Recipe schema/parse/merge — re-exported so the desktop host can build the L2
// user-recipe layer (parseRecipes/parseSiteGuides) without deep-importing.
// loadRecipes()'s import.meta.glob only runs when called, so this is import-safe.
export * from './recipe-loader.js';
export * from './experience.js';
