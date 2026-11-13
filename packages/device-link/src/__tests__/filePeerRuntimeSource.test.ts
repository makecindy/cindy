import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
it.each(['file-peer-runtime.mjs', 'direct-link-runtime.mjs'])("ships current %s without native function serialization", (script) => {
  execFileSync(process.execPath, [
    fileURLToPath(
      new URL(`../../../../scripts/${script}`, import.meta.url),
    ),
    "--check",
  ]);
});
