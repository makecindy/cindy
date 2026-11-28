#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPARE_API_FILE_CAP = 300;
const SHA40 = /^[a-f0-9]{40}$/i;

function isStaticOnlyPath(file) {
  return /^docs\/.+\.md$/.test(file)
    || /^(?:README|CONTRIBUTING|CHANGELOG)(?:\.[^/]+)?\.md$/.test(file)
    || /^(?:AGENTS|CONTRIBUTORS|REVIEW|SECURITY)\.md$/.test(file)
    || (file !== '.github/workflows/ci.yml' && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
}

export function classifyCiChanges(files) {
  const runtimeFiles = files.filter((file) => !isStaticOnlyPath(file));
  if (runtimeFiles.length === 0) return { client: false, host: false };
  // Desktop and Mobile suites consume each other's source, fixtures and assets.
  // Keep both suites together. Reuse the established Host scope for Mobile.
  return {
    client: true,
    host: runtimeFiles.some((file) => !file.startsWith('apps/mobile/')),
  };
}

async function fetchChangedFilesFromGitHubApi({
  eventName,
  event = {},
  head,
  repository,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
}) {
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha
    : eventName === 'merge_group' ? event.merge_group?.base_sha : undefined;
  if (!repository || !token || !SHA40.test(base ?? '') || !SHA40.test(head ?? '')) return null;

  // Use the candidate SHA from this run. A PR's file list can change while
  // the job is queued or paginating, especially when re-running an older head.
  const url = `${apiUrl.replace(/\/$/, '')}/repos/${repository}/compare/${base}...${head}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) return null;

  const data = await response.json();
  const files = data?.files;
  if (data?.status !== 'ahead' || !Array.isArray(files) || files.length >= COMPARE_API_FILE_CAP) return null;

  const paths = new Set();
  for (const file of files) {
    if (typeof file?.filename !== 'string' || !file.filename) return null;
    paths.add(file.filename);
    if (file.status === 'renamed' && !file.previous_filename) return null;
    if (typeof file.previous_filename === 'string' && file.previous_filename) paths.add(file.previous_filename);
  }
  return [...paths];
}

export async function detectCiChanges(options) {
  const { eventName } = options;
  const full = { client: true, host: true };
  // Concurrency can replace a pending main push with a newer one. Validate
  // the entire resulting tip even when its last change is documentation.
  if (eventName !== 'pull_request' && eventName !== 'merge_group') {
    return { changes: full, reason: `${eventName}: run full CI` };
  }
  try {
    const files = await fetchChangedFilesFromGitHubApi(options);
    if (files) {
      return { changes: classifyCiChanges(files), reason: `GitHub compare: ${files.length} unique paths` };
    }
  } catch {
    // Transport and response errors also require full CI.
  }
  return { changes: full, reason: 'GitHub comparison unavailable or incomplete; run full CI' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    const lines = Object.entries(result.changes).map(([key, required]) => `${key}=${required}\n`).join('');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  }
}
