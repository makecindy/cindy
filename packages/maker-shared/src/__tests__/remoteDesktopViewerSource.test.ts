import fs from 'node:fs';
import { expect, it } from 'vitest';
import { DESKTOP_VIEWER_SOURCE } from '../remote-desktop/viewerSource';

it('Mobile embeds the exact viewer module imported by Desktop, without Hermes serialization',()=>{
  const runtime=fs.readFileSync(new URL('../remote-desktop/viewerRuntime.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  expect(DESKTOP_VIEWER_SOURCE).toBe(runtime.replace('export function','function'));
  expect(runtime).not.toMatch(/\beval\s*\(|new Function\s*\(|ReactNativeWebView/);
});
