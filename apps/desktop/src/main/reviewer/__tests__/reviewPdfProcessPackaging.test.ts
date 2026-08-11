import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('Review PDF utility process packaging contract', () => {
  it('packages a dedicated utility-process entry without reopening RunAsNode', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const controller = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/reviewPdfProcess.ts'),
      'utf8',
    );
    const worker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/reviewPdfUtilityProcess.ts'),
      'utf8',
    );
    const viteConfig = fs.readFileSync(
      path.join(desktopRoot, 'vite.review-pdf-process.config.ts'),
      'utf8',
    );

    expect(forge).toContain("entry: 'src/main/reviewer/reviewPdfUtilityProcess.ts'");
    expect(forge).toContain("config: 'vite.review-pdf-process.config.ts'");
    expect(forge).toContain('[FuseV1Options.RunAsNode]: false');
    expect(controller).toContain("path.join(__dirname, 'reviewPdfUtilityProcess.js')");
    expect(controller).toContain('utilityProcess.fork');
    expect(controller).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(controller).not.toContain('process.execPath');
    expect(worker).toContain("import 'pdfjs-dist/legacy/build/pdf.worker.mjs'");
    expect(worker).toContain("from 'pdfjs-dist/legacy/build/pdf.mjs'");
    expect(viteConfig).toContain('inlineDynamicImports: true');
  });

  it('passes only system locale/temp variables and a neutral cwd to the helper', () => {
    const controller = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/reviewPdfProcess.ts'),
      'utf8',
    );

    expect(controller).toContain('const env: NodeJS.ProcessEnv = {}');
    expect(controller).not.toContain('...process.env');
    expect(controller).toContain('cwd: os.tmpdir()');
    expect(controller).toContain("execArgv: ['--max-old-space-size=128', '--max-semi-space-size=8']");
    expect(controller).toContain("stdio: 'ignore'");
  });
});
