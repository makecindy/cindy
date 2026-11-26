// Report execution independently of worker delivery, timeout or cancellation.
const Database = require('better-sqlite3');
const { parentPort } = require('node:worker_threads');
module.exports = class extends Database {
  constructor(file, options) {
    super(file, { ...options, verbose(sql) {
      const write = /^update "schedules" set "next_fire_at" = (\d+)/i.exec(sql);
      if (write) parentPort.postMessage({
        event: 'log', payload: { level: 'debug', scope: 'replan-test',
          payload: { event: 'sqlite-start', nextFireAt: Number(write[1]) } },
      });
    } });
  }
};
