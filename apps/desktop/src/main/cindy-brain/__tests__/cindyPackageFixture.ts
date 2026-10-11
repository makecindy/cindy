import fs from 'node:fs/promises';
import JSZip from 'jszip';

export async function writeTestCindyPackage(
  filePath: string,
  manifest: object | null,
  files: Record<string, string | Uint8Array> = { 'main.js': '// ok\n' },
): Promise<string> {
  const zip = new JSZip();
  if (manifest !== null) zip.file('ghost.json', JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}
