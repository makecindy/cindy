// No network, Agent, tools or Node worker. All results are synthetic fixture data.
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'event') return;
  let result;
  if (msg.name === 'will-start-turn') {
    result = { action: 'route', route: msg.data.route };
  } else if (msg.name === 'will-model-request') {
    result = msg.data.phase === 'select'
      ? { action: 'route', route: msg.data.route }
      : { action: 'transform', request: { ...msg.data.request, max_tokens: 256 } };
  } else if (msg.name === 'will-compose-context') {
    result = { action: 'context', blocks: [{ id: 'reference', text: 'RUNTIME_EXAMPLE_CONTEXT: synthetic reference material.' }] };
  } else if (msg.name === 'will-search-memory') {
    result = { action: 'memories', entries: [{ id: 'memory', title: 'Example memory', type: 'reference',
      content: 'RUNTIME_EXAMPLE_MEMORY: synthetic memory returned inline.' }] };
  }
  if (result) await cindy.send({ type: 'event-verdict', hookId: msg.hookId, ...result });
});
