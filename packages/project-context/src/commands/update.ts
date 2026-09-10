import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { findRepoRoot, getCurrentHead, getDiff, getDiffText } from '../git.js';
import { loadConfig, migrateLegacyContextRoot, resolvePaths } from '../config.js';
import { buildIgnoreFilter } from '../ignore.js';
import { readKnowledgeFile, writeKnowledgeFile } from '../knowledge.js';
import {
  findKnowledgeIdsForFile,
  findEntryById,
  rebuildManifestFromDisk,
  readManifest,
  writeManifest,
} from '../manifest.js';
import { makeAdapter } from '../adapters/factory.js';
import { writeToc } from '../toc.js';
import type { Manifest } from '../types.js';

export interface UpdateOptions {
  since?: string;
  checkOnly?: boolean;
  cwd?: string;
}

export interface UpdateResult {
  updated: string[];
  staled: string[];
  readOnlySkipped: string[];
  uncoveredFiles: string[];
  skippedNoChange: boolean;
}

const REWRITE_INSTRUCTION = `
You are maintaining a piece of project knowledge for an AI agent's future reference.
Below you will see (1) the current knowledge file in markdown, and (2) a git diff
covering the relevant code change. Rewrite the markdown body so it reflects the
new code reality.

Rules:
- Keep the H2 section structure intact (是什么 / 关键抽象 / 模块边界 / 不要做的事 / 演进备忘 ...).
- If a section is unchanged, copy it through verbatim.
- "演进备忘" is append-only — keep all existing entries and append at most one new
  one-line entry summarising what THIS diff did and why (use the diff's commit
  intent if obvious; otherwise omit the new entry).
- Be concise. Bullet form for lists. No marketing language.
- Output ONLY the markdown body. Do NOT include the "---" frontmatter block.
`.trim();

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  migrateLegacyContextRoot(repoRoot);
  const paths = resolvePaths(repoRoot);

  if (!fs.existsSync(paths.contextDir)) {
    throw new Error(
      `No .cindy/project-knowledge/ found in ${repoRoot}. Run \`project-context init\` first.`,
    );
  }

  // Acquire lock to avoid concurrent update conflicts (§8.5).
  const lockHandle = tryAcquireLock(paths.lockPath);
  if (!lockHandle) {
    console.log(chalk.dim('update: another instance is running (lock held). Skipping.'));
    return {
      updated: [],
      staled: [],
      readOnlySkipped: [],
      uncoveredFiles: [],
      skippedNoChange: false,
    };
  }

  try {
    const config = loadConfig(paths.configPath);
    const manifest = readManifest(paths.manifestPath);
    if (manifest.entries.length === 0) {
      throw new Error('Manifest is empty. Run `project-context init` first.');
    }

    const head = await getCurrentHead(repoRoot);
    const baseRef = options.since ?? earliestSyncedCommit(manifest);
    if (!baseRef) {
      throw new Error('No last_synced_commit found in manifest. Re-run `init`.');
    }

    if (baseRef === head) {
      console.log(chalk.dim(`update: HEAD == last sync (${head.slice(0, 7)}). Nothing to do.`));
      return {
        updated: [],
        staled: [],
        readOnlySkipped: [],
        uncoveredFiles: [],
        skippedNoChange: true,
      };
    }

    const diff = await getDiff(repoRoot, baseRef, head);
    const ignoreFilter = buildIgnoreFilter(repoRoot, config.ignore);

    const interestingFiles = diff.files.filter((f) => !ignoreFilter.isIgnored(f));
    if (interestingFiles.length === 0) {
      console.log(chalk.dim(`update: no interesting changes between ${baseRef.slice(0, 7)}..${head.slice(0, 7)}.`));
      // Still bump last_synced_commit so we don't keep recomputing the same diff.
      bumpAllSyncedCommits(paths.modulesDir, paths.concernsDir, head);
      writeManifest(paths.manifestPath, rebuildManifestFromDisk(paths));
      writeToc(paths);
      return {
        updated: [],
        staled: [],
        readOnlySkipped: [],
        uncoveredFiles: [],
        skippedNoChange: false,
      };
    }

    // Group changed files by knowledge ID.
    const idToFiles = new Map<string, string[]>();
    const uncoveredFiles: string[] = [];
    for (const file of interestingFiles) {
      const ids = findKnowledgeIdsForFile(file, manifest);
      if (ids.length === 0) {
        uncoveredFiles.push(file);
        continue;
      }
      for (const id of ids) {
        if (!idToFiles.has(id)) idToFiles.set(id, []);
        idToFiles.get(id)!.push(file);
      }
    }

    const adapter = makeAdapter(config);

    const updated: string[] = [];
    const staled: string[] = [];
    const readOnlySkipped: string[] = [];

    for (const [id, files] of idToFiles.entries()) {
      const entry = findEntryById(manifest, id);
      if (!entry) continue;
      const filePath = path.join(paths.contextDir, entry.path.replace(/\//g, path.sep));
      const knowledge = readKnowledgeFile(filePath);

      // Read-only short-circuit: respect the user's freeze. Don't rewrite, don't
      // even flip stale (a frozen module isn't expected to track HEAD).
      if (knowledge.frontmatter.auto_update === false) {
        readOnlySkipped.push(id);
        continue;
      }

      const moduleFileSet = new Set(files);
      let moduleLines = 0;
      for (const stat of diff.fileStats) {
        if (moduleFileSet.has(stat.file)) {
          moduleLines += stat.insertions + stat.deletions;
        }
      }

      const isSmall =
        files.length <= config.small_diff_threshold.files &&
        moduleLines <= config.small_diff_threshold.lines;

      if (!isSmall) {
        if (options.checkOnly) {
          staled.push(id);
          continue;
        }
        if (!knowledge.frontmatter.stale) {
          knowledge.frontmatter.stale = true;
          knowledge.frontmatter.stale_reason = `${head.slice(0, 7)}: ${files.length} file(s), ${moduleLines} line(s) changed`;
          knowledge.frontmatter.last_synced_commit = head;
          knowledge.frontmatter.last_synced_at = new Date().toISOString();
          writeKnowledgeFile(filePath, knowledge.frontmatter, knowledge.body);
        }
        staled.push(id);
        continue;
      }

      if (options.checkOnly) {
        updated.push(id);
        continue;
      }

      const diffText = await getDiffText(repoRoot, baseRef, head, files);
      try {
        const fullOld = fs.readFileSync(filePath, 'utf8');
        const newBody = await adapter.rewriteKnowledge({
          cwd: repoRoot,
          oldContent: fullOld,
          diff: diffText,
          instruction: REWRITE_INSTRUCTION,
        });
        const bodyChanged = newBody.trim() !== knowledge.body.trim();
        const metaChanged =
          knowledge.frontmatter.stale ||
          knowledge.frontmatter.last_synced_commit !== head;
        if (bodyChanged || metaChanged) {
          knowledge.frontmatter.stale = false;
          knowledge.frontmatter.stale_reason = null;
          knowledge.frontmatter.last_synced_commit = head;
          knowledge.frontmatter.last_synced_at = new Date().toISOString();
          writeKnowledgeFile(filePath, knowledge.frontmatter, bodyChanged ? newBody : knowledge.body);
        }
        updated.push(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`  ! ${id} update failed: ${msg}`));
        if (!knowledge.frontmatter.stale) {
          knowledge.frontmatter.stale = true;
          knowledge.frontmatter.stale_reason = `update failed at ${head.slice(0, 7)}: ${msg.split('\n')[0]}`;
          knowledge.frontmatter.last_synced_commit = head;
          knowledge.frontmatter.last_synced_at = new Date().toISOString();
          writeKnowledgeFile(filePath, knowledge.frontmatter, knowledge.body);
        }
        staled.push(id);
      }
    }

    if (!options.checkOnly) {
      writeManifest(paths.manifestPath, rebuildManifestFromDisk(paths));
      writeToc(paths);
    }

    // Verbose log (D2).
    console.log(chalk.bold(`project-context update`));
    console.log(`  diff: ${baseRef.slice(0, 7)}..${head.slice(0, 7)}`);
    console.log(
      `  ${chalk.green(`updated: ${updated.length}`)}, ` +
        `${chalk.yellow(`staled: ${staled.length}`)}, ` +
        `${chalk.dim(`read-only skipped: ${readOnlySkipped.length}`)}, ` +
        `${chalk.dim(`uncovered files: ${uncoveredFiles.length}`)}`,
    );
    if (updated.length > 0) {
      for (const id of updated) console.log(`    ~ ${id}`);
    }
    if (staled.length > 0) {
      for (const id of staled) console.log(chalk.yellow(`    s ${id}`));
    }
    if (readOnlySkipped.length > 0) {
      for (const id of readOnlySkipped) console.log(chalk.dim(`    r ${id}  (auto_update=false)`));
    }
    if (uncoveredFiles.length > 0) {
      console.log(chalk.dim('  uncovered files (consider adding a module/concern):'));
      for (const f of uncoveredFiles.slice(0, 20)) console.log(chalk.dim(`    - ${f}`));
      if (uncoveredFiles.length > 20) {
        console.log(chalk.dim(`    ... +${uncoveredFiles.length - 20} more`));
      }
    }
    if (options.checkOnly) {
      console.log(chalk.dim('  (check-only: no files written)'));
    }

    return { updated, staled, readOnlySkipped, uncoveredFiles, skippedNoChange: false };
  } finally {
    releaseLock(paths.lockPath, lockHandle);
  }
}

function earliestSyncedCommit(manifest: Manifest): string | null {
  let earliest: string | null = null;
  for (const entry of manifest.entries) {
    if (!entry.last_synced_commit) continue;
    // We can't sort commit SHAs lexicographically — use the manifest order as a stable
    // approximation. All `init`-created entries share the same commit, so picking any
    // is fine. Update will pick the OLDEST commit if some files lag behind.
    if (!earliest) earliest = entry.last_synced_commit;
    // No reliable way to compare commits without git history walk; default to the
    // first non-empty value. For MVP this is enough because init writes the same SHA
    // to every entry.
  }
  return earliest;
}

function bumpAllSyncedCommits(modulesDir: string, concernsDir: string, head: string): void {
  for (const dir of [modulesDir, concernsDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const filePath = path.join(dir, file);
      const knowledge = readKnowledgeFile(filePath);
      if (knowledge.frontmatter.stale) continue;
      if (knowledge.frontmatter.last_synced_commit === head) continue;
      knowledge.frontmatter.last_synced_commit = head;
      writeKnowledgeFile(filePath, knowledge.frontmatter, knowledge.body);
    }
  }
}

function tryAcquireLock(lockPath: string): number | null {
  try {
    return fs.openSync(lockPath, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw err;
  }
}

function releaseLock(lockPath: string, handle: number | null): void {
  if (handle == null) return;
  try {
    fs.closeSync(handle);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}
