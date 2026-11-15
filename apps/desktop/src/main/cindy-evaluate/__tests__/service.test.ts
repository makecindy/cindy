import sharp from 'sharp';
import { setModelVisibilityMirror } from '../../maker-host/model-visibility-mirror.js';
import { parseGatewayMediaBillingHeader } from '../../usage/gatewayMediaBillingHeader.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), pricing: vi.fn(), billing: vi.fn(), refresh: vi.fn(),
  models: [{ id: 'example-decision', mode: 'evaluation', availability: 'available' }, { id: 'example-rerank', mode: 'rerank', availability: 'available' }],
  access: { disabledModels: {} as Record<string, boolean>, disabledProviders: {} as Record<string, boolean> },
  gateway: true, generation: 1,
}));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: mocks.gateway }) }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ ownerGeneration: mocks.generation }) }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getXdGatewayModels: () => mocks.models, getActiveCatalog: () => ({ providers: [{ id: 'xd', agents: ['claude-code'] }] }) }));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => mocks.access }));
vi.mock('../../model-access/gatewayConnection.js', () => ({
  resolveGatewayConnection: () => ({ baseUrl: 'https://gateway.invalid/v1', apiKey: 'fake-test-key', onUnauthorized: vi.fn() }),
  GatewayConnectionError: class extends Error {},
}));
vi.mock('../../model-access/index.js', () => ({ refreshXdGatewayModels: mocks.refresh }));
vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({ outboundFetch: mocks.fetch }));
vi.mock('../../usage/modelPricing.js', async () => ({
  getGatewayModelPricing: mocks.pricing,
  getModelPriceQuote: (await import('../../../shared/modelPriceQuote.js')).getModelPriceQuote,
}));
vi.mock('../../usage/gatewayMediaBilling.js', () => ({ prepareGatewayMediaBilling: async (input: { estimatedBilling(): unknown }) =>
  Object.assign(async (response: Response) => {
    const actual = parseGatewayMediaBillingHeader(response.headers.get('X-Nova-AIGateway-Billing'));
    mocks.billing(actual ? { amount: actual.cost, currency: 'CNY' } : input.estimatedBilling());
  }, { finish: vi.fn() }) }));
import * as evaluationService from '../service.js';
import { listEvaluationModels } from '../models.js';
import { callEvaluate, installEvaluationRuntime } from '../runtime.js';
// Unit contract: the new paid entry point must use local model membership, distinguish
// known HTTP rejection from an unknown submission, and omit caller document text.
// Existing media tests do not cover these synchronous endpoints or their token usage shape.
// Minimal failures: empty-agent reranker, HTTP 403, transport rejection, missing price.
const context = { assertCurrent: () => {}, readImage: vi.fn() };
beforeEach(() => {
  setModelVisibilityMirror({});
  installEvaluationRuntime(evaluationService);
  mocks.fetch.mockReset(); mocks.pricing.mockReset().mockResolvedValue(null); mocks.billing.mockClear();
  mocks.generation = 1; mocks.gateway = true; mocks.access.disabledProviders = {}; mocks.access.disabledModels = {};
  mocks.models[0].id = 'example-decision';
  mocks.models.forEach(model => { model.availability = 'available'; });
});
describe('evaluate', () => {
  it('lists local enabled models without any network call', async () => {
    expect(await callEvaluate({ action: 'list_models', api: 'rerank' }, context)).toEqual({ ok: true, models: [{ id: 'example-rerank', provider_id: 'xd', name: 'example-rerank' }], guide: expect.any(Array) });
    mocks.models[1].availability = 'requires_payment';
    expect(await callEvaluate({ action: 'list_models', api: 'rerank' }, context)).toMatchObject({ models: [] });
    mocks.models[1].availability = 'available'; mocks.gateway = false;
    expect(await callEvaluate({ action: 'list_models', api: 'rerank' }, context)).toMatchObject({ models: [] });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.pricing).not.toHaveBeenCalled();
  });
  // Unit: the settings switch must affect both discovery and explicitly named paid calls.
  it.each(['decisions', 'rerank'] as const)('rejects a hidden %s model before dispatch', async api => {
    const id = api === 'decisions' ? 'example-decision' : 'example-rerank';
    setModelVisibilityMirror({ [`claude-code:xd:${id}`]: false });
    expect(listEvaluationModels(api, { includeHidden: true })).toMatchObject([{ id }]);
    expect(await callEvaluate({ action: 'list_models', api }, context)).toMatchObject({ ok: true, models: [] });
    expect(await callEvaluate({ action: api, model_id: id }, context)).toMatchObject({ errorCode: 'MODEL_NOT_AUTHORIZED', outcomeKnown: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
    setModelVisibilityMirror({ [`claude-code:xd:${id}`]: true });
    expect(await callEvaluate({ action: 'list_models', api }, context)).toMatchObject({ models: [{ id }] });
  });
  it('uses the root decisions path and preserves answers with missing-price null', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ model: 'example-decision', answers: { q: true }, usage: { input_tokens: 4, output_tokens: 1 } }));
    const result = await callEvaluate({ action: 'decisions', questions: { q: { type: 'noul', instructions: 'Check' } }, state: 'state' }, context);
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://gateway.invalid/api/alpha/decisions');
    expect(result).toMatchObject({ ok: true, answers: { q: true }, estimated_cost: null });
  });
  it('charges rerank total_tokens as input, respecting explicit zero output price and discount', async () => {
    mocks.pricing.mockResolvedValue({ xd: { 'example-rerank': { providerId: 'xd', modelId: 'example-rerank', currency: 'CNY', source: 'gateway', approximate: false, inputPerMtok: 1, outputPerMtok: 0, costDiscount: 0.5 } } });
    mocks.fetch.mockResolvedValue(Response.json({ model: 'example-rerank', results: [{ index: 0, relevance_score: 0.9, document: { text: 'private text' } }], usage: { total_tokens: 100 } }));
    const result = await callEvaluate({ action: 'rerank', query: 'question', documents: ['private text'] }, context);
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://gateway.invalid/v1/rerank');
    expect(result).toMatchObject({ ok: true, results: [{ index: 0, relevance_score: 0.9 }], estimated_cost: { amount: 0.00005, currency: 'CNY' } });
    expect(JSON.stringify(result)).not.toContain('private text');
    expect(mocks.billing).toHaveBeenCalledWith({ amount: 0.00005, currency: 'CNY' });
  });
  // Unit: a successful response with both usage and a confirmed bill must settle
  // once. Keep the recorder mock non-idempotent to expose duplicate service calls.
  it('settles a successful header bill once instead of the token estimate', async () => {
    mocks.pricing.mockResolvedValue({ xd: { 'example-rerank': { providerId: 'xd', modelId: 'example-rerank', currency: 'CNY', source: 'gateway', approximate: false, inputPerMtok: 1, outputPerMtok: 0 } } });
    mocks.fetch.mockResolvedValue(Response.json({ results: [{ index: 0, relevance_score: 0.9 }], usage: { total_tokens: 100 } }, {
      headers: { 'X-Nova-AIGateway-Billing': Buffer.from(JSON.stringify({ cost: 0.1 })).toString('base64url') },
    }));
    expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context))
      .toMatchObject({ ok: true, estimated_cost: { amount: 0.0001, currency: 'CNY' } });
    expect(mocks.billing).toHaveBeenCalledExactlyOnceWith({ amount: 0.1, currency: 'CNY' });
  });
  it.each([[400, 'INVALID_INPUT', false], [403, 'MODEL_NOT_AUTHORIZED', false], [404, 'MODEL_NOT_FOUND', false], [429, 'UPSTREAM_UNAVAILABLE', true]])('maps HTTP %s without replay', async (status, code, retryable) => {
    mocks.fetch.mockResolvedValue(Response.json({ error: { message: 'rejected fake-test-key' } }, { status: Number(status) }));
    expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context)).toMatchObject({ ok: false, errorCode: code, retryable, outcomeKnown: true, message: 'rejected [redacted]' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503, 504])('does not invite replay after HTTP %s', async status => {
    mocks.fetch.mockResolvedValue(Response.json({ error: { message: 'upstream failed' } }, { status }));
    expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context))
      .toMatchObject({ errorCode: 'UPSTREAM_UNAVAILABLE', outcomeKnown: false, retryable: false,
        message: 'upstream failed；请求可能已执行，请勿自动重提' });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('does not replay uncertain submissions', async () => {
    mocks.fetch.mockRejectedValue(new Error('connection reset'));
    expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context)).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN', outcomeKnown: false, retryable: false });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed input before submitting', async () => {
    expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'], top_n: 2 }, context)).toMatchObject({ errorCode: 'INVALID_INPUT', outcomeKnown: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

// Unit: a caller-authorized file must be decoded before submission; image format and
// minimum size must follow the selected model's contract.
it('normalizes authorized WebP images and limits the minimum size to typesafe models', async () => {
  const state = [{ type: 'image_url', image_url: { url: '/example/image.webp' } }];
  const request = { action: 'decisions' as const, questions: { q: { type: 'noul', instructions: 'Check' } }, state };
  const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#336699' } }).webp().toBuffer();
  const readImage = vi.fn(async () => image);
  mocks.fetch.mockResolvedValue(Response.json({ answers: { q: true }, usage: { input_tokens: 10, output_tokens: 0 } }));
  expect(await callEvaluate(request, { ...context, readImage })).toMatchObject({ ok: true });
  expect(readImage).toHaveBeenCalledWith('/example/image.webp');
  const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
  expect(sent.state[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  expect(state[0].image_url.url).toBe('/example/image.webp');
  mocks.fetch.mockClear();
  const tiny = await sharp(image).resize(128, 128).png().toBuffer();
  mocks.fetch.mockResolvedValue(Response.json({ answers: { q: true }, usage: { input_tokens: 10, output_tokens: 0 } }));
  expect(await callEvaluate(request, { ...context, readImage: async () => tiny })).toMatchObject({ ok: true });
  mocks.fetch.mockClear();
  mocks.models[0].id = 'typesafe/jev-1.14';
  expect(await callEvaluate(request, { ...context, readImage: async () => tiny })).toMatchObject({ errorCode: 'INVALID_INPUT', outcomeKnown: true });
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('bounds successful response bodies and does not retry when the result cannot be read', async () => {
  mocks.fetch.mockResolvedValue(new Response('x'.repeat(8 * 1024 * 1024 + 1)));
  expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context)).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN', outcomeKnown: false });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

// Unit: retain confirmed charges even when no body can be delivered; do not encourage
// replay when an account boundary hides an already submitted result.
it('settles a confirmed header charge even if the successful body is malformed', async () => {
  mocks.fetch.mockResolvedValue(new Response('invalid json', { headers: { 'X-Nova-AIGateway-Billing': Buffer.from(JSON.stringify({ cost: 0.1 })).toString('base64url') } }));
  expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context)).toMatchObject({ outcomeKnown: false });
  expect(mocks.billing).toHaveBeenCalledOnce();
});
it('does not claim the outcome is known when an account change hides a submitted result', async () => {
  mocks.fetch.mockImplementation(async () => { mocks.generation = 2; return Response.json({ answers: { q: true }, usage: { input_tokens: 1, output_tokens: 0 } }); });
  expect(await callEvaluate({ action: 'decisions', questions: { q: { type: 'noul', instructions: 'check' } }, state: 'text' }, context))
    .toMatchObject({ errorCode: 'ACCOUNT_CHANGED', outcomeKnown: false, retryable: false });
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it('retains the sanitized 401 explanation when credential recovery cannot replace the key', async () => {
  mocks.fetch.mockResolvedValue(Response.json({ error: { message: 'expired fake-test-key' } }, { status: 401 }));
  expect(await callEvaluate({ action: 'rerank', query: 'q', documents: ['d'] }, context)).toMatchObject({ errorCode: 'CONNECTION_UNAVAILABLE', message: expect.stringContaining('expired [redacted]'), outcomeKnown: true });
  expect(mocks.fetch).toHaveBeenCalledOnce();
});
