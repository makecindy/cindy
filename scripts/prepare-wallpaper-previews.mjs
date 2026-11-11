#!/usr/bin/env node
// Reproducible resize of the original artwork; only these previews enter the renderer bundle.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const sharp = require("sharp");
const source = fileURLToPath(
  new URL("../apps/desktop/src/renderer/assets/wallpapers/", import.meta.url),
);
const output = path.join(source, "previews");
await fs.mkdir(output, { recursive: true });
let total = 0;
for (const id of ["cindy-window", "cindy-studio", "cindy-dream"]) {
  const result = await sharp(path.join(source, id + ".webp"))
    .resize({
      width: 640,
      height: 400,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 70 })
    .toFile(path.join(output, id + ".webp"));
  total += result.size;
  console.log(`${id}: ${result.width}x${result.height}, ${result.size} bytes`);
}
if (total > 300 * 1024)
  throw new Error("Wallpaper previews exceed the 300 KiB bundle budget");
console.log(`Preview total: ${total} bytes`);
