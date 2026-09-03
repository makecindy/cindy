'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const TARGET_APPS = Object.freeze([
  {
    executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    bundleRoot: '/Applications/ChatGPT.app/Contents/Resources/app.asar/.vite/build',
  },
  {
    executable: '/Applications/Codex.app/Contents/MacOS/Codex',
    bundleRoot: '/Applications/Codex.app/Contents/Resources/app.asar/.vite/build',
  },
]);
const SUPPORT_PATH = __dirname;
const RECEIPT_PATH = path.join(SUPPORT_PATH, 'receipt.json');
const MAX_HEARTBEAT_AGE_SECONDS = 15;
const SERVICE_MARKERS = [
  'HID topology watcher addon not found',
  '@worklouder/device-kit-oai',
  'exports.CodexMicroService=',
  'getState(){',
  'start(){',
  'async updateLighting(',
  'async stop(){',
  'dispose(){',
];

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function captureSupportChain() {
  const parsed = path.parse(SUPPORT_PATH);
  const chain = [];
  let current = parsed.root;
  const components = SUPPORT_PATH.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const descriptor = fs.openSync(
      current,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isDirectory()) throw new Error('guard support ancestor is not a directory');
      chain.push({ pathname: current, stat });
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return chain;
}

let supportChain;
try {
  supportChain = captureSupportChain();
} catch {
  supportChain = null;
}

function assertSupportChainStable() {
  if (supportChain === null) throw new Error('guard support path was not safely opened');
  for (const entry of supportChain) {
    const current = fs.lstatSync(entry.pathname);
    if (!current.isDirectory() || !sameIdentity(current, entry.stat)) {
      throw new Error('guard support path changed after preload');
    }
  }
}

function openPrivateRegularFile(name) {
  assertSupportChainStable();
  const filename = path.join(SUPPORT_PATH, name);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('guard marker is not a regular file');
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('guard marker permissions are not private');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('guard marker owner mismatch');
    }
    assertSupportChainStable();
    if (!sameIdentity(stat, fs.lstatSync(filename))) {
      throw new Error('guard marker path changed while opening');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function guardIsFresh() {
  let enabledDescriptor;
  let heartbeatDescriptor;
  try {
    enabledDescriptor = openPrivateRegularFile('enabled');
    heartbeatDescriptor = openPrivateRegularFile('heartbeat');
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatDescriptor, 'utf8'));
    if (!Number.isFinite(heartbeat)) return false;
    const age = Date.now() / 1000 - heartbeat;
    return age >= 0 && age <= MAX_HEARTBEAT_AGE_SECONDS;
  } catch {
    return false;
  } finally {
    if (heartbeatDescriptor !== undefined) fs.closeSync(heartbeatDescriptor);
    if (enabledDescriptor !== undefined) fs.closeSync(enabledDescriptor);
  }
}

function sourceHasServiceMarkers(filename) {
  try {
    const source = fs.readFileSync(filename, 'utf8');
    return SERVICE_MARKERS.every((marker) => source.includes(marker));
  } catch {
    return false;
  }
}

function isExpectedBundleFile(filename, root, prefix) {
  return (
    typeof filename === 'string' &&
    path.dirname(filename) === root &&
    new RegExp(`^${prefix}-[A-Za-z0-9_-]+\\.js$`).test(path.basename(filename))
  );
}

function writeReceipt(serviceFilename) {
  const temporary = path.join(SUPPORT_PATH, `.receipt-${process.pid}-${Date.now()}.tmp`);
  let descriptor;
  try {
    assertSupportChainStable();
    const receipt = JSON.stringify({
      interceptedAt: Date.now() / 1000,
      service: path.basename(serviceFilename),
    });
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, receipt, 'utf8');
    fs.fsyncSync(descriptor);
    const temporaryStat = fs.fstatSync(descriptor);
    assertSupportChainStable();
    if (!sameIdentity(temporaryStat, fs.lstatSync(temporary))) {
      throw new Error('guard receipt path changed while writing');
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertSupportChainStable();
    fs.renameSync(temporary, RECEIPT_PATH);
    assertSupportChainStable();
    if (!sameIdentity(temporaryStat, fs.lstatSync(RECEIPT_PATH))) {
      throw new Error('guard receipt path changed while replacing');
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      assertSupportChainStable();
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function runtimeScope() {
  const isElectronMain = Boolean(process.versions.electron) && process.type === 'browser';
  if (!isElectronMain) return null;
  return TARGET_APPS.find((target) => target.executable === process.execPath)?.bundleRoot ?? null;
}

class CodexMicroService {
  start() {}

  getState() {
    return {
      status: 'unavailable',
      controlPlaneStatus: 'unavailable',
      transport: null,
      model: null,
      error: null,
      battery: null,
    };
  }

  async stop() {}

  async updateLighting() {
    return false;
  }

  dispose() {}
}

const serviceStub = Object.freeze({ CodexMicroService });
const bundleRoot = runtimeScope();

if (bundleRoot !== null) {
  const originalLoad = Module._load;
  const originalResolveFilename = Module._resolveFilename;

  Module._load = function guardedLoad(request, parent, isMain) {
    try {
      const resolved = originalResolveFilename.call(Module, request, parent, isMain);
      if (
        isExpectedBundleFile(parent && parent.filename, bundleRoot, 'main') &&
        isExpectedBundleFile(resolved, bundleRoot, 'service') &&
        guardIsFresh() &&
        sourceHasServiceMarkers(resolved)
      ) {
        writeReceipt(resolved);
        return serviceStub;
      }
    } catch {
      // Fail open: preserve Node's original loading behavior on any guard error.
    }
    return originalLoad.apply(this, arguments);
  };
}
