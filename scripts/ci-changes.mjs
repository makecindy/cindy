#!/usr/bin/env node
// Fast, fail-safe CI change classifier for .github/workflows/ci.yml.
// Keeps the workflow and required checks (verify / Windows unit tests) unconditional
// while skipping provably unaffected job groups (mobile-only, desktop-only, renderer-only,
// docs/non-CI-workflow-only). Any unknown range, API error, or truncated file list falls
// back to running everything — never silently skips.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST_INFRASTRUCTURE, hostRendererEntrypoints, needsHostTests } from './ci-host-tests.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_PR_FILES_PAGES = 10;
const PR_FILES_PER_PAGE = 100;
const COMPARE_API_FILE_CAP = 300;
const SHA40 = /^[a-f0-9]{40}$/i;

export const CI_CHANGE_KEYS = Object.freeze([
  'verify_checks',
  'typecheck_desktop',
  'typecheck_mobile',
  'unit_desktop',
  'unit_mobile',
  'unit_packages',
  'windows_runner_checks',
  'git_integration',
  'host',
]);

export function allRequiredChanges() {
  return Object.fromEntries(CI_CHANGE_KEYS.map((key) => [key, true]));
}

export function isNonGovernedPath(file) {
  if (file === '.github/workflows/ci.yml') return false;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return true;
  if (/^\.github\/(?:ISSUE_TEMPLATE\/|assets\/|PULL_REQUEST_TEMPLATE\.md$|CODEOWNERS$|dependabot\.yml$|dco\.yml$)/.test(file)) {
    return true;
  }
  if (/^(?:blog\/|README(?:\.[^/]+)?\.md$|CONTRIBUTING(?:\.[^/]+)?\.md$|CONTRIBUTORS\.md$|CHANGELOG(?:\.[^/]+)?\.md$|LICENSE(?:\.[^/]+)?$|NOTICE(?:\.[^/]+)?$|SECURITY\.md$)/.test(file)) {
    return true;
  }
  return false;
}

export function isGovernedDocPath(file) {
  return file.startsWith('docs/')
    || file === 'AGENTS.md'
    || file === 'REVIEW.md'
    || /^apps\/[^/]+\/AGENTS\.md$/.test(file)
    || /^packages\/[^/]+\/AGENTS\.md$/.test(file);
}

function isWideInfrastructurePath(file) {
  if (HOST_INFRASTRUCTURE.has(file)) return true;
  if (/^(?:scripts\/|patches\/|config\/|tools\/)/.test(file)) return true;
  // Any unknown top-level file outside our explicit doc/app/package trees fails safe.
  if (!file.includes('/') && !isNonGovernedPath(file) && !isGovernedDocPath(file)) return true;
  return false;
}

export function classifyCiChanges(files, { rendererEntrypoints = hostRendererEntrypoints(ROOT) } = {}) {
  const result = Object.fromEntries(CI_CHANGE_KEYS.map((key) => [key, false]));
  if (files.length === 0) return result;

  for (const file of files) {
    if (isNonGovernedPath(file)) continue;

    result.verify_checks = true;
    if (isGovernedDocPath(file)) continue;

    if (isWideInfrastructurePath(file)) {
      return allRequiredChanges();
    }

    if (file.startsWith('packages/')) {
      // Shared workspace packages can feed Desktop, Mobile, Host and Git integration.
      return allRequiredChanges();
    }

    if (file.startsWith('apps/mobile/')) {
      result.typecheck_mobile = true;
      result.unit_mobile = true;
      // Desktop's transfer-baseline test helper reads apps/mobile/src/device-link/.
      if (file.startsWith('apps/mobile/src/device-link/')) {
        result.typecheck_desktop = true;
        result.unit_desktop = true;
        result.windows_runner_checks = true;
      }
      continue;
    }

    if (file.startsWith('apps/desktop/')) {
      result.typecheck_desktop = true;
      result.unit_desktop = true;
      // packages/lizi-im reads desktop locales; packages/maker-core reads desktop system skills & prompts.
      result.unit_packages = true;
      result.windows_runner_checks = true;
      // Pure renderer / capture-renderer edits do not feed Desktop Git integration suites.
      if (
        !file.startsWith('apps/desktop/src/renderer/')
        && !file.startsWith('apps/desktop/src/capture-renderer/')
      ) {
        result.git_integration = true;
      }
      if (needsHostTests([file], rendererEntrypoints)) {
        result.host = true;
      }
      continue;
    }

    if (file.startsWith('apps/host/')) {
      result.host = true;
      result.unit_desktop = true;
      result.windows_runner_checks = true;
      result.git_integration = true;
      continue;
    }

    if (/^apps\/(?:web|[^/]+-bin)\//.test(file)) {
      result.typecheck_desktop = true;
      result.unit_desktop = true;
      result.unit_packages = true;
      result.windows_runner_checks = true;
      result.git_integration = true;
      result.host = true;
      continue;
    }

    // Any other unrecognized path (e.g. a new top-level directory) fails safe to full CI.
    return allRequiredChanges();
  }

  return result;
}

function collectApiPaths(items) {
  const paths = new Set();
  for (const item of items) {
    if (typeof item?.filename === 'string' && item.filename) paths.add(item.filename);
    if (typeof item?.previous_filename === 'string' && item.previous_filename) {
      paths.add(item.previous_filename);
    }
  }
  return [...paths];
}

export async function fetchChangedFilesFromGitHubApi({
  eventName,
  event = {},
  head,
  repository,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !token || typeof fetchImpl !== 'function') return null;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cindy-ci-changes',
  };

  if (eventName === 'pull_request') {
    const number = event.pull_request?.number;
    if (!Number.isInteger(number) || number <= 0) return null;
    const allItems = [];
    for (let page = 1; page <= MAX_PR_FILES_PAGES; page += 1) {
      const url = `${apiUrl.replace(/\/$/, '')}/repos/${repository}/pulls/${number}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`;
      const res = await fetchImpl(url, { headers });
      if (!res.ok) return null;
      const items = await res.json();
      if (!Array.isArray(items)) return null;
      allItems.push(...items);
      if (items.length < PR_FILES_PER_PAGE) {
        return { files: collectApiPaths(allItems), source: `github-pr-api (${allItems.length} entries)` };
      }
    }
    // Truncated at MAX_PR_FILES_PAGES * PR_FILES_PER_PAGE; fail safe to full run.
    return null;
  }

  if (eventName === 'merge_group' || eventName === 'push') {
    const base = eventName === 'merge_group' ? event.merge_group?.base_sha : event.before;
    if (!base || /^0+$/.test(base) || !SHA40.test(base) || !SHA40.test(head ?? '')) return null;
    const url = `${apiUrl.replace(/\/$/, '')}/repos/${repository}/compare/${base}...${head}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.files) || data.status === 'diverged') return null;
    if (data.files.length >= COMPARE_API_FILE_CAP) return null;
    return { files: collectApiPaths(data.files), source: `github-compare-api (${data.files.length} entries)` };
  }

  return null;
}

export async function detectCiChanges({
  eventName,
  event = {},
  head,
  repository,
  token,
  apiUrl,
  root = ROOT,
  fetchImpl = globalThis.fetch,
  git,
}) {
  if (eventName === 'workflow_dispatch') {
    return { changes: allRequiredChanges(), reason: 'workflow_dispatch: run full CI', files: null };
  }

  const rendererEntrypoints = hostRendererEntrypoints(root);

  if (repository && token) {
    try {
      const apiResult = await fetchChangedFilesFromGitHubApi({
        eventName, event, head, repository, token, apiUrl, fetchImpl,
      });
      if (apiResult) {
        return {
          changes: classifyCiChanges(apiResult.files, { rendererEntrypoints }),
          reason: `${apiResult.source}, ${apiResult.files.length} unique paths`,
          files: apiResult.files,
        };
      }
      if (!git) {
        return {
          changes: allRequiredChanges(),
          reason: 'GitHub API unavailable or truncated; fail safe to full CI',
          files: null,
        };
      }
    } catch (error) {
      if (!git) {
        return {
          changes: allRequiredChanges(),
          reason: `GitHub API error (${error instanceof Error ? error.message : String(error)}); fail safe to full CI`,
          files: null,
        };
      }
    }
  }

  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha
    : eventName === 'merge_group' ? event.merge_group?.base_sha
      : eventName === 'push' ? event.before : undefined;
  if (!base || /^0+$/.test(base)) {
    return { changes: allRequiredChanges(), reason: 'No event base; run full CI', files: null };
  }
  if (!SHA40.test(base) || !SHA40.test(head ?? '')) {
    throw new Error('CI change detection requires complete event base/head commit SHAs');
  }
  const runGit = git ?? execFileSync;
  const output = runGit('git', ['diff', '--name-only', '--no-renames', '-z', base, head, '--'], {
    cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  const files = output.split('\0').filter(Boolean);
  return {
    changes: classifyCiChanges(files, { rendererEntrypoints }),
    reason: `git diff (${files.length} changed paths)`,
    files,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const result = await detectCiChanges({
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      head: process.env.GITHUB_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    });
    console.log(`CI changes (${result.reason}):`, JSON.stringify(result.changes));
    if (process.env.GITHUB_OUTPUT) {
      const lines = CI_CHANGE_KEYS.map((key) => `${key}=${result.changes[key]}\n`).join('');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
