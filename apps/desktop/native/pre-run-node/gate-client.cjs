'use strict';
/** Cooperative gate-body protocol. Loading this module never attests entry.
 * Call enter() in the check body, complete(code) after its work, then exit.
 * This is not an attestation mechanism against hostile same-process code. */
const { createConnection } = require('node:net');
const { isMainThread } = require('node:worker_threads');
let socket, pending, failure, entered = false, completed = false, response = '';
function frame(verb, code) {
  if (failure || !socket || socket.destroyed) return Promise.reject(failure || new Error('Gate protocol is closed'));
  if (pending) return Promise.reject(new Error('Concurrent pre-run gate protocol call'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    socket.write(verb + ' ' + process.env.CINDY_PRE_RUN_GATE_NONCE + (code === undefined ? '' : ' ' + code) + '\n');
  });
}
async function enter() {
  if (!isMainThread || entered || completed) throw new Error('Gate entry must occur once in the root main thread');
  const endpoint = process.env.CINDY_PRE_RUN_GATE_ENDPOINT;
  if (!endpoint || !process.env.CINDY_PRE_RUN_GATE_NONCE) throw new Error('Gate is not running under the Cindy pre-run supervisor');
  socket = createConnection(endpoint);
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    response += chunk;
    if (response.length > 16) { socket.destroy(new Error('Invalid gate acknowledgement')); return; }
    if (response.endsWith('\n')) {
      const operation = pending; pending = undefined;
      if (!operation) { socket.destroy(new Error('Unexpected gate acknowledgement')); return; }
      const ok = response === 'ok\n'; response = '';
      if (ok) operation.resolve(); else operation.reject(new Error('Gate proof rejected'));
    }
  });
  socket.on('error', error => { failure = error; const operation = pending; pending = undefined; operation?.reject(error); });
  socket.on('close', () => { failure ??= new Error('Gate protocol closed before acknowledgement'); const operation = pending; pending = undefined; operation?.reject(failure); });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  await frame('ENTER'); entered = true;
}
async function complete(code) {
  if (!entered || completed || ![0, 2].includes(code)) throw new Error('Gate must enter and complete once with 0 or 2');
  await frame('COMPLETE', code); completed = true; process.exitCode = code;
  await new Promise((resolve, reject) => { socket.once('close', resolve); socket.once('error', reject); socket.end(); });
}
async function exit(code) { await complete(code); process.exit(code); }
module.exports = { enter, complete, exit };
