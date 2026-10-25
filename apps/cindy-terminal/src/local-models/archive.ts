import { createReadStream } from "node:fs";
import { chmod, link, mkdir, realpath, symlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import path from "node:path";
import * as tar from "tar";
import { findOllamaBinary } from "@cindy/model-providers/local-runtime/ollamaSidecar";
import { archivePath } from "../engines/archive.js";

/** Linux releases use zstd; no shell, system zstd or desktop runtime is needed. */
export async function extractLinuxOllama(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let invalid: unknown,
    bytes = 0,
    count = 0;
  const links = new Map<string, { target: string; hard: boolean }>();
  const extract = tar.x({
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter(name, entry) {
      try {
        const relative = path.posix.normalize(archivePath(name));
        if (
          !("type" in entry) ||
          !["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(
            entry.type,
          )
        )
          throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
        if (entry.type === "SymbolicLink" || entry.type === "Link") {
          const link = entry.linkpath;
          if (
            !link ||
            /[\\:\x00-\x1f]/.test(link) ||
            path.posix.isAbsolute(link)
          )
            throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
          const target = archivePath(
            path.posix.normalize(
              path.posix.join(
                entry.type === "Link" ? "" : path.posix.dirname(relative),
                link,
              ),
            ),
          );
          if (relative === "." || links.has(relative))
            throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
          links.set(relative, { target, hard: entry.type === "Link" });
        }
        bytes += entry.size;
        if (++count > 100_000 || bytes > 16 * 1024 ** 3)
          throw new Error("LOCAL_RUNTIME_ARCHIVE_TOO_LARGE");
      } catch (error) {
        invalid ??= error;
      }
      // Extract ordinary entries with node-tar's traversal guards intact. Its
      // symlink-target guard rejects valid version chains in official CUDA
      // libraries, so publish validated, flattened links after file extraction.
      return !invalid && "type" in entry && entry.type !== "SymbolicLink" && entry.type !== "Link";
    },
  });
  await pipeline(createReadStream(archive), createZstdDecompress(), extract, {
    signal,
  });
  if (invalid) throw invalid;
  signal?.throwIfAborted();
  const root = await realpath(destination);
  const inside = (file: string) => {
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
  };
  const resolveTarget = (name: string, visited = new Set<string>()): string => {
    const parts = archivePath(name).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const reference = links.get(prefix);
      if (!reference) continue;
      if (visited.has(prefix) || visited.size >= 40)
        throw new Error("UNSAFE_LOCAL_RUNTIME_ARCHIVE");
      visited.add(prefix);
      return resolveTarget(path.posix.join(reference.target, ...parts.slice(i)), visited);
    }
    return name;
  };
  for (const [name, reference] of links) {
    signal?.throwIfAborted();
    const target = path.join(root, resolveTarget(reference.target, new Set([name])));
    const output = path.join(root, name);
    inside(target);
    inside(output);
    // A link may never replace an extracted entry or redirect another entry's
    // writes. The private staging tree contains no links until this phase.
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    inside(await realpath(path.dirname(output)));
    inside(await realpath(target));
    if (reference.hard) await link(target, output);
    else await symlink(path.relative(path.dirname(output), target), output);
  }
  const binary = findOllamaBinary(destination);
  if (!binary) throw new Error("LOCAL_RUNTIME_BINARY_MISSING");
  await chmod(binary, 0o755);
  return binary;
}
