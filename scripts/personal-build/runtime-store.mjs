/** Immutable signed runtimes. Business releases reference these; preparation never selects one. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function runtimeKey(inputs) { return hash(JSON.stringify(inputs)); }
export function treeIdentity(root) {
  const entries = [];
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), rel = prefix + name, st = fs.lstatSync(file);
      if (st.isSymbolicLink()) entries.push([rel, 'link', fs.readlinkSync(file)]);
      else if (st.isDirectory()) walk(file, rel + '/');
      else if (st.isFile()) entries.push([rel, st.mode & 0o777, hash(fs.readFileSync(file))]);
      else throw Error(`Unsupported runtime entry: ${rel}`);
    }
  };
  walk(root); return runtimeKey(entries);
}
export function verifyRuntime(runtime, verifySignature = () => {}) {
  if (!runtime || !/^[a-f0-9]{64}$/.test(runtime.key) || !path.isAbsolute(runtime.directory)) throw Error('Invalid personal runtime');
  const receipt = JSON.parse(fs.readFileSync(path.join(runtime.directory, 'runtime.json'), 'utf8'));
  if (receipt.key !== runtime.key || runtimeKey(receipt.inputs) !== runtime.key || receipt.signingIdentity !== receipt.inputs.signingIdentity || receipt.digest !== runtime.digest || treeIdentity(path.join(runtime.directory, 'Cindy.app')) !== receipt.digest)
    throw Error('Personal runtime changed; prepare a new candidate');
  verifySignature(path.join(runtime.directory, 'Cindy.app'), receipt.signingIdentity);
  return receipt;
}
export function prepareRuntime({store, inputs, signingIdentity, build, verifySignature}) {
  fs.mkdirSync(store, {recursive:true, mode:0o700});
  store = fs.realpathSync(store);
  inputs = {...inputs, signingIdentity};
  const key = runtimeKey(inputs), directory = path.join(store, 'versions', key);
  if (fs.existsSync(directory)) {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    const runtime = {key, directory, digest:receipt.digest}; verifyRuntime(runtime, verifySignature); return runtime;
  }
  fs.mkdirSync(path.dirname(directory), {recursive:true, mode:0o700});
  // A crashed or concurrent build is visible, never silently reused or overwritten.
  const lock = directory + '.lock'; fs.mkdirSync(lock, {mode:0o700});
  const stage = directory + '.building-' + randomUUID();
  try {
    fs.mkdirSync(stage, {mode:0o700});
    const app = path.join(stage, 'Cindy.app'); build(app); verifySignature(app, signingIdentity);
    const receipt = {version:1, key, inputs, signingIdentity, digest:treeIdentity(app)};
    fs.writeFileSync(path.join(stage, 'runtime.json'), JSON.stringify(receipt, null, 2), {mode:0o600});
    fs.renameSync(stage, directory);
    return {key, directory, digest:receipt.digest};
  } finally { fs.rmSync(stage, {recursive:true, force:true}); fs.rmdirSync(lock); }
}
/** Called only after the supervisor's stop/profile guard. Smoke checks never call this. */
export function selectRuntime(runtime, {isRunning, verifySignature}) {
  verifyRuntime(runtime, verifySignature);
  const store = path.dirname(path.dirname(runtime.directory)), link = path.join(store, 'Cindy.app');
  if (fs.existsSync(link)) {
    if (!fs.lstatSync(link).isSymbolicLink()) throw Error('Personal app entry is not a managed link');
    const previous = fs.realpathSync(link);
    if (previous === path.join(runtime.directory, 'Cindy.app')) return link;
    if (!previous.startsWith(path.join(store, 'versions') + path.sep) || isRunning(previous)) throw Error('Previous runtime is still in use or unmanaged');
  }
  const temp = link + '.' + randomUUID();
  fs.symlinkSync(path.join(runtime.directory, 'Cindy.app'), temp); fs.renameSync(temp, link);
  return link;
}
