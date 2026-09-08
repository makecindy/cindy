import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../apps/mobile/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: [
      process.env.CINDY_DEVICE_LINK_TEST_MODE === "interop"
        ? "scripts/device-link/interop.test.ts"
        : "scripts/device-link/reconnect.test.ts",
    ],
    pool: "threads",
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});
