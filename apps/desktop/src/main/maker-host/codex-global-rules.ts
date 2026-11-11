import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

export const CODEX_GLOBAL_RULES_FILE_NAME = 'AGENTS.md';
export const CODEX_GLOBAL_RULES_MARKER_FILE_NAME = 'AGENTS.md.xdt-managed';

export type CodexGlobalRulesStatus =
  | 'missing'
  | 'copied'
  | 'updated'
  | 'kept'
  | 'user-kept'
  | 'removed'
  | 'marker-removed'
  | 'error';

export interface CodexGlobalRulesPrepareResult {
  codexHome: string;
  source: string;
  destination: string;
  marker: string;
  changed: boolean;
  status: CodexGlobalRulesStatus;
  reason?: string;
  warnings: string[];
}

interface PrepareOptions {
  homeDir?: string;
}

interface PathState {
  exists: boolean;
  isFile: boolean;
  reason?: string;
}

export function codexGlobalRulesPaths(codexHome: string, homeDir = os.homedir()) {
  return {
    codexHome,
    sourceRulesFile: path.join(homeDir, '.codex', CODEX_GLOBAL_RULES_FILE_NAME),
    managedRulesFile: path.join(codexHome, CODEX_GLOBAL_RULES_FILE_NAME),
    markerFile: path.join(codexHome, CODEX_GLOBAL_RULES_MARKER_FILE_NAME),
  };
}

/** Keep document references anchored to the source without copying its directory. */
function managedRulesContent(source: Buffer, sourceRulesFile: string): Buffer {
  const original = source.toString('utf8');
  // remark removes a leading BOM before assigning offsets; keep it outside edits.
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = original.slice(bom.length);
  const base = pathToFileURL(sourceRulesFile);
  const edits: { start: number; end: number; value: string }[] = [];
  const capture = (
    node: { type: string; url?: string } | undefined,
    token: { start: { offset: number }; end: { offset: number } },
  ) => {
    if (node?.type !== 'link' && node?.type !== 'definition') return;
    const url = node.url;
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|[/\\#?]|~(?:[/\\]|$))/i.test(url)) return;

    // Markdown destinations use URL semantics: preserve existing escapes and
    // suffixes; encode literal percent signs and parentheses for bare links.
    // Escape ampersands for Markdown without changing URL query separators.
    const value = new URL(url.replace(/%(?![\da-f]{2})/gi, '%25'), base).href
      .replace(/&/g, '&amp;').replace(/\(/g, '%28').replace(/\)/g, '%29');
    const enclosed = text[token.start.offset] === '<';
    edits.push({
      start: token.start.offset + (enclosed ? 1 : 0),
      end: token.end.offset - (enclosed ? 1 : 0),
      value,
    });
  };

  // Destination tokens retain exact source offsets. Hook their enclosing exit
  // after remark has decoded the URL, leaving labels, titles and examples intact.
  unified().use(remarkParse).data('fromMarkdownExtensions', [{
    exit: {
      resourceDestination(token) { capture(this.stack.at(-1), token); },
      definitionDestination(token) { capture(this.stack.at(-1), token); },
    },
  }]).parse(text);

  if (!edits.length) return source;
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return Buffer.from(bom + result, 'utf8');
}

async function writeManagedRules(
  paths: ReturnType<typeof codexGlobalRulesPaths>,
  content: Buffer,
): Promise<void> {
  // copyFile used to preserve source permissions, including on existing copies.
  const mode = (await fsp.stat(paths.sourceRulesFile)).mode & 0o777;
  const file = await fsp.open(paths.managedRulesFile, 'w', mode);
  try {
    await file.writeFile(content);
    await file.chmod(mode);
  } finally {
    await file.close();
  }
}

async function statFile(value: string, followSymlink: boolean): Promise<PathState> {
  try {
    const stat = followSymlink ? await fsp.stat(value) : await fsp.lstat(value);
    return { exists: true, isFile: stat.isFile() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { exists: false, isFile: false };
    return { exists: false, isFile: false, reason: (err as Error).message };
  }
}

function makeResult(
  paths: ReturnType<typeof codexGlobalRulesPaths>,
  status: CodexGlobalRulesStatus,
  changed: boolean,
  warnings: string[] = [],
  reason?: string,
): CodexGlobalRulesPrepareResult {
  return {
    codexHome: paths.codexHome,
    source: paths.sourceRulesFile,
    destination: paths.managedRulesFile,
    marker: paths.markerFile,
    changed,
    status,
    reason,
    warnings,
  };
}

async function removeMarker(paths: ReturnType<typeof codexGlobalRulesPaths>): Promise<CodexGlobalRulesPrepareResult> {
  try {
    await fsp.unlink(paths.markerFile);
    return makeResult(paths, 'marker-removed', true);
  } catch (err) {
    const warning = `cannot remove orphan Codex rules marker ${paths.markerFile}: ${(err as Error).message}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }
}

async function removeManagedCopy(paths: ReturnType<typeof codexGlobalRulesPaths>): Promise<CodexGlobalRulesPrepareResult> {
  try {
    await fsp.unlink(paths.managedRulesFile);
  } catch (err) {
    const warning = `cannot remove managed Codex rules copy ${paths.managedRulesFile}: ${(err as Error).message}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  try {
    await fsp.unlink(paths.markerFile);
    return makeResult(paths, 'removed', true);
  } catch (err) {
    const warning = `cannot remove Codex rules marker ${paths.markerFile}: ${(err as Error).message}`;
    return makeResult(paths, 'error', true, [warning], warning);
  }
}

async function copyWithMarker(paths: ReturnType<typeof codexGlobalRulesPaths>): Promise<CodexGlobalRulesPrepareResult> {
  try {
    await fsp.writeFile(paths.markerFile, '');
  } catch (err) {
    const warning = `cannot create Codex rules marker ${paths.markerFile}: ${(err as Error).message}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  try {
    const source = await fsp.readFile(paths.sourceRulesFile);
    await writeManagedRules(paths, managedRulesContent(source, paths.sourceRulesFile));
    return makeResult(paths, 'copied', true);
  } catch (err) {
    const warning = `cannot copy Codex rules from ${paths.sourceRulesFile} to ${paths.managedRulesFile}: ${
      (err as Error).message
    }`;
    return makeResult(paths, 'error', true, [warning], warning);
  }
}

async function updateManagedCopy(
  paths: ReturnType<typeof codexGlobalRulesPaths>,
  content: Buffer,
): Promise<CodexGlobalRulesPrepareResult> {
  try {
    await writeManagedRules(paths, content);
  } catch (err) {
    const warning = `cannot update Codex rules copy ${paths.managedRulesFile}: ${(err as Error).message}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  try {
    await fsp.writeFile(paths.markerFile, '');
    return makeResult(paths, 'updated', true);
  } catch (err) {
    const warning = `cannot refresh Codex rules marker ${paths.markerFile}: ${(err as Error).message}`;
    return makeResult(paths, 'updated', true, [warning], warning);
  }
}

async function prepareCodexGlobalRulesCopyInner(
  paths: ReturnType<typeof codexGlobalRulesPaths>,
): Promise<CodexGlobalRulesPrepareResult> {
  await fsp.mkdir(paths.codexHome, { recursive: true });

  const [source, markerState, destination] = await Promise.all([
    statFile(paths.sourceRulesFile, true),
    statFile(paths.markerFile, false),
    statFile(paths.managedRulesFile, false),
  ]);
  const markerExists = markerState.exists;

  if (source.reason) {
    const warning = `cannot inspect Codex global rules source ${paths.sourceRulesFile}: ${source.reason}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  if (destination.reason) {
    const warning = `cannot inspect Codex rules destination ${paths.managedRulesFile}: ${destination.reason}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  if (!source.exists) {
    if (markerExists && destination.exists) return removeManagedCopy(paths);
    if (markerExists) return removeMarker(paths);
    if (destination.exists) {
      return makeResult(paths, 'user-kept', false, [], 'source missing and destination is not managed');
    }
    return makeResult(paths, 'missing', false);
  }

  if (!source.isFile) {
    const warning = `Codex global rules source is not a file: ${paths.sourceRulesFile}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  if (!markerExists && destination.exists) {
    return makeResult(paths, 'user-kept', false, [], 'destination exists without managed marker');
  }

  if (markerExists && !destination.exists) {
    const cleanup = await removeMarker(paths);
    if (cleanup.status === 'error') return cleanup;
    const copyResult = await copyWithMarker(paths);
    return copyResult.changed ? copyResult : { ...copyResult, changed: true };
  }

  if (!destination.exists) return copyWithMarker(paths);

  if (!destination.isFile) {
    const warning = `managed Codex rules destination is not a file: ${paths.managedRulesFile}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }

  try {
    const [sourceBuffer, destinationBuffer] = await Promise.all([
      fsp.readFile(paths.sourceRulesFile),
      fsp.readFile(paths.managedRulesFile),
    ]);
    const content = managedRulesContent(sourceBuffer, paths.sourceRulesFile);
    if (content.equals(destinationBuffer)) {
      return makeResult(paths, 'kept', false);
    }
    return updateManagedCopy(paths, content);
  } catch (err) {
    const warning = `cannot compare Codex rules files: ${(err as Error).message}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }
}

export async function prepareCodexGlobalRulesCopy(
  codexHome: string,
  opts: PrepareOptions = {},
): Promise<CodexGlobalRulesPrepareResult> {
  const paths = codexGlobalRulesPaths(codexHome, opts.homeDir);
  try {
    return await prepareCodexGlobalRulesCopyInner(paths);
  } catch (err) {
    const warning = `prepare Codex global rules failed: ${(err as Error).message}`;
    return makeResult(paths, 'error', false, [warning], warning);
  }
}
