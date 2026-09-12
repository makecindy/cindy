import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
it("ships a current static WebView runtime without relying on native function serialization", () => {
  execFileSync(process.execPath, [
    fileURLToPath(
      new URL("../../../../scripts/file-peer-runtime.mjs", import.meta.url),
    ),
    "--check",
  ]);
});
