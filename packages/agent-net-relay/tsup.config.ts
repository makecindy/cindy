import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/client.ts', 'src/sharingAuth.ts', 'src/notificationBridge.ts'], format: ['esm'], target: 'node22',
  noExternal: ['@cindy/agent-net-protocol', '@cindy/device-link-sharing', 'jose', 'ws'], sourcemap: true, clean: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
