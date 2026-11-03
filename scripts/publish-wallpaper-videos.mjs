#!/usr/bin/env node
// Verify/publish original wallpaper images and videos; only small previews are bundled.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createOSSClient,
  resolveOssConfig,
  uploadToOSS,
} from "./shared/oss.mjs";

const args = process.argv.slice(2);
const region =
  args.find((arg) => arg.startsWith("--region="))?.slice(9) ?? "global";
const directory = args.find((arg) => arg.startsWith("--directory="))?.slice(12);
const verifyOnly = args.includes("--verify-only");
const checkCdn = args.includes("--check-cdn");
if (!["global", "cn", "dev"].includes(region)) {
  throw new Error(
    "Usage: node scripts/publish-wallpaper-videos.mjs [--directory=<originals>] --region=global|cn|dev [--verify-only | --check-cdn]",
  );
}
const source =
  directory ??
  fileURLToPath(
    new URL("../apps/desktop/src/renderer/assets/wallpapers/", import.meta.url),
  );
const manifest = JSON.parse(
  await fs.readFile(
    new URL(
      "../apps/desktop/src/shared/wallpaper-video-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const assets = [];
for (const [id, entry] of Object.entries(manifest)) {
  if (!["bundled", "cdn"].includes(entry.delivery))
    throw new Error("Unknown wallpaper delivery: " + id);
  for (const [asset, ext, mime] of [
    [entry.sha256 ? entry : null, ".mp4", "video/mp4"],
    [entry.image, ".webp", "image/webp"],
  ]) {
    if (!asset) continue;
    // Read-only CDN checks verify against the manifest alone; clean checkouts lack originals.
    if (checkCdn) {
      if (entry.delivery === "cdn") assets.push({ id, ...asset, ext, mime });
      continue;
    }
    let file = path.resolve(source, id + ext);
    // Accept both the prepared hash-named upload folder and the old external HD input layout.
    if (directory) {
      const candidates = [file, path.resolve(source, asset.sha256 + ext)];
      if (ext === ".mp4") candidates.push(path.resolve(source, id + "-hd.mp4"));
      file = undefined;
      for (const candidate of candidates) {
        if (
          await fs.stat(candidate).then(
            (s) => s.isFile(),
            () => false,
          )
        ) {
          file = candidate;
          break;
        }
      }
      if (!file) throw new Error("Missing wallpaper source: " + id + ext);
    }
    const bytes = await fs.readFile(file);
    if (
      bytes.length !== asset.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256
    )
      throw new Error("Asset differs from reviewed manifest: " + id + ext);
    if (entry.delivery === "cdn")
      assets.push({ id, file, ...asset, ext, mime });
    console.log(id + ext + ": " + asset.bytes + " bytes");
  }
}
console.log(
  "CDN upload total: " +
    assets.reduce((sum, asset) => sum + asset.bytes, 0) +
    " bytes",
);
if (checkCdn || !verifyOnly) {
  // Read-only verification needs no OSS credentials and never uploads.
  let config;
  if (checkCdn) {
    const cdnEnvName = {
      global: "XDT_GLOBAL_CDN_BASE_URL",
      cn: "XDT_CDN_BASE_URL",
      dev: "XDT_DEVCH_CDN_BASE_URL",
    }[region];
    let cdnBase = process.env[cdnEnvName]?.trim();
    if (!cdnBase) {
      const endpointFile = {
        global: "endpoint.global.json",
        cn: "endpoint.json",
        dev: "endpoint.dev.json",
      }[region];
      const endpoint = JSON.parse(
        await fs.readFile(
          new URL("../config/" + endpointFile, import.meta.url),
          "utf8",
        ),
      );
      cdnBase = endpoint.cdnBaseUrl;
    }
    config = { cdnBase };
  } else {
    config = resolveOssConfig(region);
  }
  const client = checkCdn ? null : createOSSClient(region);
  for (const asset of assets) {
    const relative = "wallpapers/" + asset.sha256 + asset.ext;
    if (client)
      await uploadToOSS(
        client,
        config.prefix.replace(/\/+$/, "") + "/" + relative,
        asset.file,
        {
          headers: {
            "Content-Type": asset.mime,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        },
      );
    const response = await fetch(
      config.cdnBase.replace(/\/+$/, "") + "/" + relative,
      {
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `CDN resource is not readable (${region}, ${asset.id}${asset.ext}): ${response.status}`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length !== asset.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256
    )
      throw new Error("CDN resource integrity mismatch");
    if (response.headers.get("content-type")?.split(";")[0] !== asset.mime)
      throw new Error("CDN content type mismatch");
    console.log("Verified " + region + ": " + relative);
  }
}
