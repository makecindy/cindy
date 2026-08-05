// @vitest-environment jsdom
/**
 * sessionsStoreAutoTitlePreview.test.ts
 * ---------------------------------------------------------------------------
 * 自动起名的「即时标题预览」是**条件**更新,判定归 sessionsStore(它持有列表缓存):
 *   - 标题仍是「尚未起名」哨兵 → 乐观写入,不等 IPC 往返 + DB 广播;
 *   - 已起名 / 用户改过名 / fork 与合成占位 → 一律不动(覆写资格只有 main 能判);
 *   - 缓存里没有这一行 → 不动,交给权威广播回填。
 *
 * 发起方(makerChatStore)只 emit,不读会话行 —— 见 makerChatStoreAutoName.test.ts。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

const list = vi.fn();
vi.mock('@/lib/sessionService', () => ({
  list: (...args: unknown[]) => list(...args),
}));

import { emitAutoTitlePreview, emitAutoTitlePreviewCleared } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';

const SESSION_ID = 's-preview';

function session(over: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    title: DEFAULT_DRAFT_SESSION_TITLE,
    agentKind: 'cc',
    status: 'active',
    workingDir: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...over,
  } as Session;
}

/** 把一行灌进 active 桶,让 findById 命中。 */
async function seed(row: Session): Promise<void> {
  list.mockResolvedValue([row]);
  await sessionsStore.ensureByFilter('active');
}

function currentTitle(): string | undefined {
  return sessionsStore.findById(SESSION_ID)?.title;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionsStore.reset();
});

describe('sessionsStore — 自动起名的即时标题预览', () => {
  it('标题仍是哨兵 → 乐观写入', async () => {
    await seed(session());

    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('用户已手动改过名 → 不动,否则会把他的标题在 UI 上顶掉', async () => {
    await seed(session({ title: '我自己起的名字' }));

    emitAutoTitlePreview(SESSION_ID, '这条消息不该改标题');

    expect(currentTitle()).toBe('我自己起的名字');
  });

  it('fork 占位 → 不动(能否覆写由 main 的归属表裁决)', async () => {
    await seed(session({ title: '[Fork] 源会话标题' }));

    emitAutoTitlePreview(SESSION_ID, '第一句话');

    expect(currentTitle()).toBe('[Fork] 源会话标题');
  });

  it('纯附件写下的合成占位 → 不动,等用户真正打字后由 main 换掉', async () => {
    await seed(session({ title: '设计稿-v3.png' }));

    emitAutoTitlePreview(SESSION_ID, '这个报错怎么修');

    expect(currentTitle()).toBe('设计稿-v3.png');
  });

  it('缓存里没有这一行 → 不写入,交给权威广播回填', () => {
    // 桶未加载:findById 拿不到,预览静默跳过(不应凭空造出一行)。
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    expect(sessionsStore.findById(SESSION_ID)).toBeNull();
  });

  it('空标题不触发预览(emit 侧已挡掉)', async () => {
    await seed(session());

    emitAutoTitlePreview(SESSION_ID, '');

    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });
});

describe('sessionsStore — 预览必须活过全量刷新', () => {
  it('新建会话触发的 forceRefreshAll 不会把预览冲回哨兵', async () => {
    // 真实时序:createSession → 预览 → sessions:created push → forceRefreshAll,
    // 而那次重拉从 DB 拿回的行**仍带哨兵**(权威标题要等 auto-title 落库)。
    // 只写缓存会被冲掉 —— 标题先显示用户那句话、又退回「未命名对话」(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    expect(currentTitle()).toBe('帮我排查登录失败');

    list.mockResolvedValue([session()]); // DB 侧仍是哨兵
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('桶未加载时先登记,首次 fetch 也能叠加上', async () => {
    // createSession 早于列表加载完成时,findById 拿不到行,但预览不能因此丢掉。
    emitAutoTitlePreview(SESSION_ID, '第一句话');

    await seed(session());

    expect(currentTitle()).toBe('第一句话');
  });

  it('权威标题落地后预览让位并回收,不再顶着真实标题', async () => {
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '占位标题');

    // main 写入智能标题 → sessions:patched 回流。
    sessionsStore.patchLocal(SESSION_ID, { title: '登录失败排查' });
    expect(currentTitle()).toBe('登录失败排查');

    // 回收后再刷新也不该把预览翻出来盖回去。
    list.mockResolvedValue([session({ title: '登录失败排查' })]);
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('登录失败排查');
  });

  it('起名失败 → 撤回预览,标题退回哨兵(不再永久顶着库里不存在的标题)', async () => {
    // 叠加层的失效条件是「权威标题落地」。起名 IPC 失败时那个条件永远不成立,
    // 没有撤回路径的话会话就永久显示首条消息、重启后又变回兜底文案(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    expect(currentTitle()).toBe('帮我排查登录失败');

    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('撤回后连叠加层一起回收:后续全量刷新不会把预览翻出来', async () => {
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    emitAutoTitlePreviewCleared(SESSION_ID);

    list.mockResolvedValue([session()]); // DB 侧仍是哨兵
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('迟到的撤回不许冲掉已经回流的权威标题', async () => {
    // 「写库成功但响应丢了」的时序:main 已广播权威标题,撤回才到。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    sessionsStore.patchLocal(SESSION_ID, { title: '登录失败排查' });

    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe('登录失败排查');
  });

  it('权威标题与预览逐字相同后再撤回 → 不许把已落库的标题打回哨兵', async () => {
    // 最常见的时序:main 写的占位与预览本来就一样(两端共用 normalizeAutoTitle)。
    // 若 patchLocal 在「同值」时保留叠加层,缓存里那个串就分不出是乐观值还是权威值,
    // 随后的失败撤回会把**已经落库**的标题打回哨兵、界面与 DB 不一致(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    // main 写完占位 → sessions:patched 回流,值与预览逐字相同。
    sessionsStore.patchLocal(SESSION_ID, { title: '帮我排查登录失败' });

    // 之后智能标题那步失败(或响应丢了)→ 撤回到达,但权威值已经落库。
    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe('帮我排查登录失败');

    // 且叠加层已回收:后续刷新按 DB 值走,不会再被撤回或预览影响。
    list.mockResolvedValue([session({ title: '帮我排查登录失败' })]);
    await sessionsStore.forceRefreshAll();
    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('没有登记过预览时撤回是 no-op(不把用户手动改的名打回哨兵)', async () => {
    await seed(session({ title: '我自己起的名字' }));

    emitAutoTitlePreviewCleared(SESSION_ID);

    expect(currentTitle()).toBe('我自己起的名字');
  });

  it('权威标题晚于在飞的 list 请求写入 → 旧快照不许把它冲回哨兵', async () => {
    // 真实时序:sessions:created push → forceRefreshAll 起飞(DB 快照里还是哨兵)
    // → main 写完占位、sessions:patched 落进缓存 → 那个更早的请求才回来。
    // 没有版本化 override 的话,整桶覆盖会把权威标题冲掉,界面退到「未命名对话」
    // 直到下一次刷新;乐观预览此刻已按「权威值到达即回收」的规则让位(review P1)。
    await seed(session());

    let releaseStale: (rows: Session[]) => void = () => {};
    list.mockImplementationOnce(() => new Promise<Session[]>((resolve) => {
      releaseStale = resolve;
    }));
    const staleRefresh = sessionsStore.forceRefreshAll();

    // 权威标题在旧请求回来之前到达。注意 forceRefresh 已经把桶 drop 了(见其实现),
    // 此刻缓存里根本没有这一行 —— patchLocal 无处可合并,唯一能救回它的就是 override。
    // 这也是「解除在飞请求的认领」救不了场的原因:桶是空的,必须让那个请求提交,
    // 再由 override 把标题补回去。
    expect(sessionsStore.findById(SESSION_ID)).toBeNull();
    sessionsStore.patchLocal(SESSION_ID, { title: '帮我排查登录失败' });

    // 旧请求带着 pre-write 快照回来。
    releaseStale([session()]);
    await staleRefresh;

    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('新请求发起于标题写入之后 → override 不再插手,DB 值说了算', async () => {
    // override 只对「发起早于本次写入」的请求生效,否则用户之后在别处改的名会被顶回来。
    await seed(session());
    sessionsStore.patchLocal(SESSION_ID, { title: '帮我排查登录失败' });

    list.mockResolvedValue([session({ title: '别处改的新名字' })]);
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('别处改的新名字');
  });

  it('乐观值不许经 override 层洗成「权威标题」把叠加层误回收', async () => {
    // 时序:一个桶的刷新先起飞(快照里是哨兵),会话同时还在另一个桶的缓存里 → 预览
    // 登记 + 乐观写入 → 那个更早的请求回来。若乐观值也登记了权威 override,它会被
    // override 层重放成非哨兵标题,applyAutoTitlePreviews 便把自己写上去的值当成权威
    // 标题、回收叠加层;之后又一次(仍返回哨兵的)刷新就再没人保护标题(review P1)。
    list.mockResolvedValue([session()]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('all');

    let releaseStale: (rows: Session[]) => void = () => {};
    list.mockImplementationOnce(() => new Promise<Session[]>((resolve) => {
      releaseStale = resolve;
    }));
    const staleRefresh = sessionsStore.forceRefresh('active');

    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    expect(currentTitle()).toBe('帮我排查登录失败');

    releaseStale([session()]); // 旧请求带回 DB 里的哨兵
    await staleRefresh;
    expect(currentTitle()).toBe('帮我排查登录失败');

    // 关键:叠加层必须还在。main 仍未落库时的下一次刷新还要靠它。
    list.mockResolvedValue([session()]);
    await sessionsStore.forceRefreshAll();
    expect(currentTitle()).toBe('帮我排查登录失败');
  });

  it('用户手动把标题改成字面量哨兵 → 也算权威写入,预览必须让位', async () => {
    // main 侧专门有 manuallyRenamed 记号支持这种同值改名,所以它是合法的用户标题。
    // 回收判据若排除哨兵值,刷新时会先重放权威值、紧接着又被陈旧预览盖回第一句话,
    // 用户的标题根本显示不出来(review P1)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');

    // 用户改名成 "New Maker" → 经 sessions:patched 回流。
    sessionsStore.patchLocal(SESSION_ID, { title: DEFAULT_DRAFT_SESSION_TITLE });
    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);

    // 关键:叠加层已回收,后续刷新不许把第一句话盖回来。
    list.mockResolvedValue([session({ title: DEFAULT_DRAFT_SESSION_TITLE })]);
    await sessionsStore.forceRefreshAll();
    expect(currentTitle()).toBe(DEFAULT_DRAFT_SESSION_TITLE);
  });

  it('权威标题恰好等于预览时,后续刷新同样不残留叠加', async () => {
    // 常见路径:main 写的占位与预览逐字相同(两端共用 normalizeAutoTitle)。
    await seed(session());
    emitAutoTitlePreview(SESSION_ID, '帮我排查登录失败');
    sessionsStore.patchLocal(SESSION_ID, { title: '帮我排查登录失败' });

    list.mockResolvedValue([session({ title: '帮我排查登录失败' })]);
    await sessionsStore.forceRefreshAll();
    // 再改名(模拟用户手动重命名)后刷新,预览不得复活。
    list.mockResolvedValue([session({ title: '我自己起的名字' })]);
    await sessionsStore.forceRefreshAll();

    expect(currentTitle()).toBe('我自己起的名字');
  });
});
