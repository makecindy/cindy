// Test-only subprocess: loopback listeners, random credentials, no user data.
const { randomBytes } = require('node:crypto');
const dgram = require('node:dgram');
const Turn = require(process.argv[2]);
const probe = dgram.createSocket('udp4');
probe.bind(0, '127.0.0.1', () => {
  const port = probe.address().port;
  probe.close(() => {
    const username = randomBytes(12).toString('hex');
    const credential = randomBytes(24).toString('hex');
    const server = new Turn({
      listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], listeningPort: port,
      authMech: 'long-term', credentials: { [username]: credential },
      realm: 'cindy-acceptance.invalid', debugLevel: 'OFF',
    });
    server.start();
    // This pinned test dependency has no public ready event.
    for (const socket of server.network.sockets) {
      socket.once('error', () => process.exit(1));
      socket.once('listening', () => process.send({
        urls: `turn:127.0.0.1:${port}?transport=udp`, username, credential,
      }));
    }
    process.on('disconnect', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  });
});
