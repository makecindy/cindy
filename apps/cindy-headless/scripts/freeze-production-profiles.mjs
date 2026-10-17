import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
}

for (const target of [
  { directory: 'cindy-production-claude', aliases: ['cindy-production-cc'] },
  { directory: 'cindy-production-pi' },
]) {
  const directory = path.join(appDir, 'profiles', target.directory);
  const profileFile = 'profile.example.json';
  const rawProfile = await readFile(path.join(directory, profileFile), 'utf8');
  const profile = JSON.parse(rawProfile);
  const prompt = profile.systemPromptFile ? await readFile(path.join(directory, profile.systemPromptFile)) : null;
  const lock = {
    schemaVersion: 1,
    status: 'frozen',
    profileId: profile.id,
    ...(target.aliases ? { aliases: target.aliases } : {}),
    profileFile,
    profileFileSha256: sha256(rawProfile),
    profileDigest: sha256(JSON.stringify(canonicalize(profile))),
    systemPromptDigest: prompt ? sha256(prompt) : null,
    agentBinaryVersion: profile.agentBinaryVersion,
    cindyUpstreamCommit: packageJson.cindyUpstreamCommit,
  };
  if (profile.expectedSystemPromptDigest && profile.expectedSystemPromptDigest !== lock.systemPromptDigest) {
    throw new Error(`${target.directory} expectedSystemPromptDigest does not match ${profile.systemPromptFile}`);
  }
  await writeFile(path.join(directory, 'profile.lock.json'), JSON.stringify(lock, null, 2) + '\n');
}
