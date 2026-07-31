/**
 * skillSource —— 由本地 skill 的 registry origin(+ server 归属信号)派生「来源」分类。
 *
 * 用户视角只关心一份本地 skill 是「从 SkillHub 安装下来的副本」还是「自己的」:
 *   - 'installed'            → 走 SkillHub 市场安装的版本            → 'skillhub'
 *   - 'published' / 'learned' / 'imported' / 无 origin → 自己开发/发布/学习/导入的本地版本 → 'local'
 * ('published' 的本地目录是作者自己的 dev 副本,不是从 hub 拉下来的,故归 'local'。)
 *
 * 历史遗留数据(v0.6 引入 origin 之前的 registry 记录)可能有 registry 记录但
 * origin 缺失,且 reconcile 只回填「我自己的」skill(见 SkillhubFeatureLayout),
 * 他人的历史安装会一直停在 origin=undefined。此时不能一律当 'local' —— 与详情页
 * deriveDetailActionState(lib/detailButtons.ts)一致地做保守推断:有 registry 记录
 * 且 server 明确判定不是我的(他人历史安装)才视作 'skillhub';我的 / 未知 / 纯本地
 * 一律 'local'。
 */

export type SkillSource = 'skillhub' | 'local';

/**
 * 收敛成两档来源,供首页来源徽标使用。
 * @param origin           registry 记录的本地来源(缺失 = 历史遗留 / 无)
 * @param hasRegistryEntry 该 skill 是否有 registry 记录(= 有过市场交互:安装或发布)
 * @param isMine           server 权威归属:true=我的 / false=他人 / null|undefined=未知
 */
export function deriveSkillSource(
  origin: 'installed' | 'published' | 'learned' | 'imported' | null | undefined,
  hasRegistryEntry: boolean,
  isMine: boolean | null | undefined,
): SkillSource {
  if (origin === 'installed') return 'skillhub';
  // published / learned / imported 都是本地侧产物
  if (origin === 'published' || origin === 'learned' || origin === 'imported') return 'local';
  // origin 缺失:仅当有 registry 记录且 server 明确说不是我的(他人历史安装)才算 skillhub。
  if (hasRegistryEntry && isMine === false) return 'skillhub';
  return 'local';
}
