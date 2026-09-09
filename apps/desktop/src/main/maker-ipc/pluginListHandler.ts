import { z } from 'zod';
import type { BotToolsetContext } from '../../shared/botRemoteCapabilities.js';
import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const botContextSchema = z.object({
  botId: z.string().min(1),
  agentKind: z.enum(['claude-code', 'codex', 'pi']),
  remoteHostId: z.string().nullish(),
});

/** Preserve the settings catalog, adding actual mount availability only for Bot queries. */
export function registerPluginListHandler(registry: IpcHandlerRegistry, deps: {
  getPluginRegistry: () => Pick<PluginRegistry, 'listPlugins'>;
  isBotToolsetAvailable: (input: BotToolsetContext & { toolsetId: string }) => boolean;
  assertBotQuery: (event: unknown) => void;
}): void {
  registry.handle(MAKER_INVOKE.PLUGINS_LIST, async (event, workingDir, includeHidden, botContext) => {
    const wd = typeof workingDir === 'string' ? workingDir : undefined;
    if (botContext === undefined) return deps.getPluginRegistry().listPlugins(wd, includeHidden === true);
    deps.assertBotQuery(event);
    const parsed = botContextSchema.safeParse(botContext);
    if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid Bot toolset context');
    const items = await deps.getPluginRegistry().listPlugins(wd, includeHidden === true);
    return items.map((item) => ({
      ...item,
      available: item.effectiveEnabled && deps.isBotToolsetAvailable({
        ...parsed.data, workingDir: wd ?? '', toolsetId: item.id,
      }),
    }));
  });
}
