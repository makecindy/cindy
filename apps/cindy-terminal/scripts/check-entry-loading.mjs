import assert from 'node:assert/strict';
import { buildCli } from './build-cli.mjs';

// Distribution integration check: follow emitted static imports, not source
// spelling. A dynamic boundary that esbuild folds away must fail this check.
const {metafile:{outputs}}=await buildCli({write:false});
function closure(entry) {
  const seen=new Set(),external=new Set(),inputs=new Set();
  function visit(file) {
    if(seen.has(file))return;
    seen.add(file);
    const output=outputs[file];assert.ok(output,`Missing emitted module: ${file}`);
    for(const input of Object.keys(output.inputs))inputs.add(input.replaceAll('\\','/'));
    for(const item of output.imports){
      if(item.kind==='dynamic-import')continue;
      if(item.external)external.add(item.path);else visit(item.path);
    }
  }
  visit(entry);return {files:seen.size,external:[...external],inputs:[...inputs]};
}
for(const [name,suffix] of [['cli','/src/cli.tsx'],['service','/src/service.ts']]){
  const entry=Object.entries(outputs).find(([,output])=>output.entryPoint?.replaceAll('\\','/').endsWith(suffix));
  assert.ok(entry,`Missing ${name} entry`);
  const loaded=closure(entry[0]);
  assert.ok(!loaded.external.some(item=>/^(react|ink)(\/|$)/.test(item)),`${name} statically loads React/Ink`);
  assert.ok(!loaded.inputs.some(item=>item.endsWith('/ui/tui.tsx')),`${name} statically loads TUI`);
  if(name==='cli')assert.ok(!loaded.inputs.some(item=>item.endsWith('/src/service.ts')),'CLI statically loads service');
  console.log(`${name}: ${loaded.files} static modules; no React/Ink/TUI${name==='cli'?' or service':''}`);
}
