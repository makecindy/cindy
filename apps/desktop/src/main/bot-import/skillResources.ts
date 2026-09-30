import { isUtf8 } from 'node:buffer';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompanionEnvironment } from './environment.js';
import type { ImportFile } from './types.js';
import { writeImportFiles } from './files.js';
import { redactEnvironmentValues } from './process.js';

/** Keep executable originals private; never publish their known credentials to a harness. */
export function projectImportedSkill(files: readonly ImportFile[], slug: string, secrets: Record<string, string>) {
  let changed = false;
  const projected = files.map(file => {
    const bigEndian = file.bytes[0] === 0xfe && file.bytes[1] === 0xff;
    const utf16 = bigEndian || file.bytes[0] === 0xff && file.bytes[1] === 0xfe;
    if (utf16 && file.bytes.length % 2) return file;
    if (!utf16 && (!isUtf8(file.bytes) || file.bytes.includes(0))) return file;
    const encoding = utf16 ? 'utf16le' : 'utf8';
    const text = (bigEndian ? Buffer.from(file.bytes).swap16() : file.bytes).toString(encoding);
    const redacted = redactEnvironmentValues(text, secrets);
    if (redacted === text) return file;
    changed = true;
    const bytes = Buffer.from(redacted, encoding);
    return { ...file, bytes: bigEndian ? bytes.swap16() : bytes };
  });
  if (!changed) return { files: projected, ...(files.some(file => file.interpreterLink) ? { originals: files.map(file => ({ ...file, bytes: file.bytes.toString('base64') })) } : {}) };
  const guidance = `\n\nImported credentials are masked in these readable files. Execute this skill's commands with companion_connections.run_command, using the original resources at "$CINDY_IMPORTED_SKILLS/${slug}" (Windows cmd: "%CINDY_IMPORTED_SKILLS%\\${slug}") instead of this readable skill directory. Preserve relative resource paths within that directory. Write generated outputs to the current companion workspace.\n`;
  return {
    files: projected.map(file => {
      if (file.name !== 'SKILL.md') return file;
      const suffix = file.bytes[0] === 0xfe && file.bytes[1] === 0xff ? Buffer.from(guidance, 'utf16le').swap16()
        : Buffer.from(guidance, file.bytes[0] === 0xff && file.bytes[1] === 0xfe ? 'utf16le' : 'utf8');
      return { ...file, bytes: Buffer.concat([file.bytes, suffix]) };
    }),
    originals: files.map(file => ({ ...file, bytes: file.bytes.toString('base64') })),
  };
}

/** Only the already-authorized host command receives this ephemeral directory. */
export async function withImportedSkillResources<T>(environment: CompanionEnvironment, assertOwner: () => void,
  run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const skills = Object.entries(environment.skillFiles ?? {});
  if (!skills.length) return run(environment.env);
  assertOwner();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-skills-'));
  try {
    assertOwner();
    await writeImportFiles(directory, skills.flatMap(([slug, files]) => files.map(file => ({
      ...file, name: `${slug}/${file.name}`, bytes: Buffer.from(file.bytes, 'base64'),
    }))));
    assertOwner();
    return await run({ ...environment.env, CINDY_IMPORTED_SKILLS: directory });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
