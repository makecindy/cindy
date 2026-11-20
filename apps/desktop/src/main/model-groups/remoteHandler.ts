/**
 * 同账号的另一台电脑在这台开新任务时，按这台自己的模式选路(model-groups.md「在另一台电脑上开的新任务」)：
 * `model-groups:remote` 的 list / resolve / commit。配置、额度、例外与「轮流」位置都是这台的；
 * 发起端只传模式 id，不传它自己的模式。dispatch 已拒绝非同账号的调用方。
 */
import type { ModelGroupResolveRequest, ModelGroupResolveResult, ModelGroupsConfig } from '../../shared/modelGroups.js';
import { parseModelGroupsRemoteRequest, type ModelGroupRemoteNote } from '../../shared/modelGroupsRemote.js';

export interface ModelGroupsRemoteDeps {
  config(): ModelGroupsConfig;
  /** 与本机新任务同一个选路实例：选路凭据、「轮流」位置与「最近的选择」都记在这台。 */
  resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult>;
  commit(decisionId: string): boolean;
  /** 把说明写进这台上的任务记录，排在第一条消息下面；任务不在这台时什么都不做。 */
  writeNote(sessionId: string, note: ModelGroupRemoteNote): Promise<void>;
  warn(message: string): void;
}

export async function handleModelGroupsRemote(deps: ModelGroupsRemoteDeps, raw: unknown): Promise<unknown> {
  const request = parseModelGroupsRemoteRequest(raw);
  if (request.action === 'list') return { config: deps.config() };
  if (request.action === 'resolve') {
    // 只做真正的选路：不接受预览(预览不发凭据，发起端也无从提交)，也不接受运行位置限定。
    return deps.resolve({ selection: request.selection, ...(request.context ? { context: request.context } : {}) });
  }
  // 只有这台发出过、还没过期的选路凭据才算数；凭据无效时也不写说明，不让别处凭空往任务记录里写一行。
  const committed = deps.commit(request.decisionId);
  if (committed && request.note) {
    const { sessionId, ...note } = request.note;
    void deps.writeNote(sessionId, note).catch(() => deps.warn('model group note for a remotely created task was not written'));
  }
  return { committed };
}
