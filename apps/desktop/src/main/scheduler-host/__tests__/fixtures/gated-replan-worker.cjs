// Load the production worker, then interpose only on delivery of scheduling CAS
// writes. Reads, claims, terminal run writes and all SQL execution stay real.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
require(path.join(path.dirname(workerData.dbPath), 'bundle', 'dbWorker.js'));
const dispatch = require('node:events').getEventListeners(parentPort, 'message').at(-1);
parentPort.removeListener('message', dispatch);
const held = [];
let writes = 0;
let armed = false;

function report(event, id) {
  parentPort.postMessage({ event: 'log', payload: { scope: 'replan-test', level: 'debug', payload: { event, id } } });
}

parentPort.on('message', async (req) => {
  if (req.op === 'armReplans') {
    armed = true;
    parentPort.postMessage({ id: req.id, ok: true });
    return;
  }
  if (req.op === 'blockWorker') {
    parentPort.postMessage({ id: req.id, ok: true });
    Atomics.wait(req.args.gate, 0, 0, 5000); // Also unblock teardown if the test fails.
    return;
  }
  if (req.op === 'releaseReplans') {
    for (const pending of held.splice(0, req.args?.count ?? held.length)) await dispatch(pending);
    parentPort.postMessage({ id: req.id, ok: true });
    return;
  }
  if (armed && req.op === 'rawAll' && /^update "schedules" set "next_fire_at" = \?/i.test(req.args.sql)) {
    report('entered', req.id);
    if (++writes <= 5) {
      held.push(req);
      return;
    }
    await dispatch(req);
    report('finished', req.id);
    return;
  }
  await dispatch(req);
});
