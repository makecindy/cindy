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
    // node-turn 0.0.6 omits integrity on CHANNEL-BIND success. Chromium keeps
    // retrying the binding and destroys the allocation after ~40s, even while
    // ICE consent checks succeed. Fix only the isolated test server's response.
    server.prependListener('channel_bind', (_msg, reply) => reply.addAttribute('message-integrity'));
    // The pinned fixture's refresh handler uses these historical property names.
    server.defaultLifetime = server.defaultAllocatetLifetime;
    server.maxAllocateTimeout = server.maxAllocateLifetime;
    server.start();
    if (process.env.CINDY_PEER_TEST_DIAG === '1') {
      for (const type of ['allocate', 'refresh', 'channel_bind', 'create_permission'])
        server.on(type, msg => process.send({ diagnostic: type, time: Date.now(), lifetime: msg.getAttribute('lifetime') }));
    }
    // This pinned test dependency has no public ready event.
    for (const socket of server.network.sockets) {
      // Its listening socket only parses STUN, despite advertising channel binding.
      // Supply UDP ChannelData forwarding for authenticated, live bindings only.
      const stun = socket.listeners('message')[0];
      socket.removeListener('message', stun);
      socket.on('message', (data, remote) => {
        if (data.length < 4 || (data[0] & 0xc0) !== 0x40) return stun(data, remote);
        const allocation = server.allocations[`UDP://${remote.address}:${remote.port}>127.0.0.1:${port}`];
        const peer = allocation?.channelBindings[data.readUInt16BE(0)];
        const length = data.readUInt16BE(2);
        if (!peer || allocation.timeToExpiry <= Date.now() || allocation.permissions[peer.address] <= Date.now()
          || !allocation.permissions[peer.address] || length > data.length - 4 || data.length - 4 - length > 3) return;
        allocation.sockets[0].send(data.subarray(4, 4 + length), peer.port, peer.address);
      });
      socket.once('error', () => process.exit(1));
      socket.once('listening', () => process.send({
        urls: `turn:127.0.0.1:${port}?transport=udp`, username, credential,
      }));
    }
    process.on('disconnect', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  });
});
