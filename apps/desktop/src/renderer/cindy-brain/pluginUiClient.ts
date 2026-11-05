import { pluginUiCapabilitiesForPoint, parsePluginUiViews, parsePluginUiInvocationResult,
  pluginUiRecord, pluginUiText, type PluginUiInvokeInput, type PluginUiInvocationResult } from '@cindy/maker-shared';
import type { PluginUiReadRequest, PluginUiReadResult, PluginUiRendererChoice } from '../../shared/pluginUi';
import { pluginUiComposerAccess, pluginUiComposerKey } from './pluginUiComposerActions';

export interface PluginUiClientTarget { deviceId?: string; sessionId?: string; point: string; target?: { kind: string; id: string } }
export function parsePluginUiReadResult(raw: unknown): PluginUiReadResult {
  if (!pluginUiRecord(raw) || typeof raw.revision !== 'string')
    throw new Error('Invalid plugin UI projection');
  const views = parsePluginUiViews(raw.views);
  if (!views) throw new Error('Invalid plugin UI view');
  let renderer: PluginUiReadResult['renderer'];
  if (raw.renderer !== undefined) {
    const value = raw.renderer;
    if (!pluginUiRecord(value) || !Array.isArray(value.candidates) || value.candidates.length > 64 ||
        !['automatic', 'original', 'selected'].includes(String(value.preference))) throw new Error('Invalid plugin renderer');
    const candidates = value.candidates.map(candidate => {
      if (!pluginUiRecord(candidate) || !pluginUiText(candidate.instanceId) || !pluginUiText(candidate.contributionId, 64) ||
          !/^[a-zA-Z0-9_-]+$/.test(candidate.contributionId) || !pluginUiText(candidate.pluginName, 1024))
        throw new Error('Invalid plugin renderer candidate');
      return { instanceId: candidate.instanceId, contributionId: candidate.contributionId, pluginName: candidate.pluginName };
    });
    let selected: PluginUiRendererChoice | undefined;
    if (value.selected !== undefined) {
      if (!pluginUiRecord(value.selected) || !candidates.some(candidate => candidate.instanceId === (value.selected as Record<string, unknown>).instanceId &&
          candidate.contributionId === (value.selected as Record<string, unknown>).contributionId)) throw new Error('Invalid plugin renderer selection');
      selected = { instanceId: value.selected.instanceId as string, contributionId: value.selected.contributionId as string };
    }
    renderer = { candidates, ...(selected ? { selected } : {}), preference: value.preference as 'automatic' | 'original' | 'selected' };
  }
  return { views, revision: raw.revision, ...(renderer ? { renderer } : {}) };
}
function requestFor(input: PluginUiClientTarget, subscriptionId?: string): PluginUiReadRequest {
  if (!input.sessionId) throw new Error('UI task unavailable');
  const capabilities = pluginUiCapabilitiesForPoint(input.point);
  return { sessionId: input.sessionId, point: input.point,
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(input.target ? { target: input.target } : {}), capabilities: { ...capabilities,
      effects: input.sessionId && pluginUiComposerAccess.has(pluginUiComposerKey(input)) ? capabilities.effects : [] } };
}
export async function readPluginUi(input: PluginUiClientTarget, subscriptionId?: string): Promise<PluginUiReadResult> {
  if (input.deviceId || !input.sessionId) return { views: [], revision: '' };
  return parsePluginUiReadResult(await window.electronAPI.ghosts.ui.read(requestFor(input, subscriptionId)));
}

export async function choosePluginUiRenderer(input: PluginUiClientTarget, choice: PluginUiRendererChoice | null): Promise<void> {
  if (input.deviceId) throw new Error('Renderer unavailable');
  await window.electronAPI.ghosts.ui.chooseRenderer({ request: requestFor(input), choice });
}

export async function releasePluginUi(input: PluginUiClientTarget, subscriptionId: string): Promise<void> {
  if (input.deviceId) return;
  try { await window.electronAPI.ghosts.ui.release({ subscriptionId }); }
  catch { /* A departed view has no write to retry. */ }
}

export async function invokePluginUi(target: PluginUiClientTarget, input: PluginUiInvokeInput): Promise<PluginUiInvocationResult> {
  const unknown: PluginUiInvocationResult = { invocationId: input.invocationId, status: 'outcome-unknown' };
  if (target.deviceId || !target.sessionId) return { invocationId: input.invocationId, status: 'rejected' };
  try {
    const raw: unknown = await window.electronAPI.ghosts.ui.invoke({ sessionId: target.sessionId, input });
    const result = parsePluginUiInvocationResult(raw);
    return result && pluginUiRecord(raw) && raw.invocationId === input.invocationId ? { ...result, invocationId: input.invocationId } : unknown;
  } catch { return unknown; }
}
