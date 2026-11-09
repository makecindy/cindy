#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prepare an inspectable input bundle. No model call, payment, or avatar write.
const skillRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error('Usage: node prepare-avatar.mjs <character-brief.md> <new-input.json>');
  }
  const [briefPath, outputPath] = args.map((path) => resolve(path));
  const templatePath = resolve(skillRoot, 'prompts/avatar.md');
  const referencePath = resolve(skillRoot, 'assets/cindy-reference.png');
  const [templateBytes, briefBytes, referenceBytes] = await Promise.all([
    readFile(templatePath), readFile(briefPath), readFile(referencePath),
  ]);
  const blocks = [...templateBytes.toString('utf8').matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length !== 1) throw new Error('Expected one generation prompt in avatar.md.');
  const base = blocks[0][1];
  if (base.split('{CHARACTER_BRIEF}').length !== 2) {
    throw new Error('Expected exactly one {CHARACTER_BRIEF} slot.');
  }
  const brief = briefBytes.toString('utf8').trim();
  if (!brief) throw new Error('The character brief is empty.');
  if (!referenceBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('The fixed Cindy reference is not a PNG.');
  }
  const prompt = base.replace('{CHARACTER_BRIEF}', () => brief);
  if (/\{[A-Z][A-Z_]*\}/.test(prompt)) throw new Error('Unfilled placeholder in prompt.');
  const bundle = {
    prompt,
    referenceImages: [{
      path: referencePath,
      purpose: 'Primary art-style reference; create a new character drawing.',
      sha256: digest(referenceBytes),
    }],
    sources: {
      template: { path: templatePath, sha256: digest(templateBytes), promptSha256: digest(base) },
      characterBrief: { path: briefPath, sha256: digest(briefBytes) },
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`Avatar preparation failed: ${error.message}\n`);
  process.exitCode = 1;
});
