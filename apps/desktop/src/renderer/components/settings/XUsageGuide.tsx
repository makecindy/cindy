/**
 * X 连接的「用法与风险」告知 —— X 卡内的常驻小节与首次绑定的确认门渲染的是
 * **同一个组件**,两处不各写一份文案:这份内容的价值全在准确,而复制两份必然漂移。
 *
 * 为什么 X 需要这一节, 而 Slack / Telegram 不需要:那两个是私密通道, 回复只有会话里
 * 的人能看到; **X 的回复是一条公开推文**。X 卡此前套用的是那两个渠道的文案口径
 * (「@提及 bot 即可派发任务」), 把这条性质差异整个漏掉了。
 *
 * 三组的取舍:
 *   - 「怎么用」只说清一件事:@ 一下, 任务就派到**这台设备**上执行, 结论以回帖发回。
 *     用户最需要建立的心智模型是「X 那头只是入口, 活是在我这台机器上干的」。
 *   - 「回帖是公开的」是本节存在的理由, 三层都要说:回复本身公开;**因此这个功能适合
 *     公开地找答案、解决问题, 不适合处理私事(有隐私暴露风险)**;以及 X 任务都落在默认
 *     工作目录、Agent 能读写其中文件而结论会公开回帖。中间那层是 Dash 明确要的产品
 *     表态 —— 光陈述「回复是公开的」还要用户自己推导该拿它干什么;第三层是用户判断
 *     「该不该把默认目录指到工作仓库」的唯一依据(均 2026-08-02 拍定)。
 *   - 「想撤回」把服务端已交付的能力告诉用户 —— 做了但没人知道等于没做。
 *
 * 刻意不写进来的(2026-08-02 Dash 拍定):每日任务上限、上溯链上文进 prompt 的细节,
 * 以及「必须是你自己打的 @」这条约束。**最后一条有已知代价**:服务端的 isDirectMention
 * 只认用户自己打的 @, 所以用户在我们的回帖下追问时(X 自动带的继承前缀)那条追问会被
 * 判否、收不到回应 —— 要接着聊每次都得重新 @ 一次, 而现在没有任何地方告诉他。取舍是
 * 「这一节要短到有人读」优先;若日后有人反馈「追问没反应」, 这就是原因。
 *
 * **文案里不能用方位指代**(「下面」/「below」/「아래」…)。本组件被两处渲染:卡内小节
 * 与首次绑定的确认门弹窗 —— 卡内「下面」指得到目录选择器, 弹窗里下方只有撤回那组和
 * 确认按钮, 方位指代会把用户指向不存在的控件, 而那正是他最需要去检查那个目录的时刻
 * (#1347 review 由 codex 指出)。修法选「与上下文无关的措辞」而不是给组件加 variant:
 * 一加 variant 就把本组件想消掉的「两处文案漂移」风险请了回来。
 *
 * 三条落在文案里、代码里看不出来的约定(由 xUsageGuideCopy 测试守着):
 *   - **bot handle `@askmycindy` 硬编码在四份 locale 的 usageBody 里。** 不走 binding:
 *     这一节在用户还没绑定时就要显示, 那时候没有 scopeName 可取。硬编码是安全的 ——
 *     cn 与 global 两份 endpoint manifest 的 xHookWsUrl 指向同一个 x-hook 服务, 也就是
 *     同一个 bot。改 handle 时四份都要改。
 *   - **`/删除` 只在 zh-CN 里提。** 服务端两个命令词都收, 但中文命令词对非中文用户
 *     是噪音, 少宣传一个不影响功能(Dash 2026-08-02)。
 */

import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 一组「标签 + 正文」。正文顶对齐、只向下伸展(见下方 clamp 说明)。 */
function GuideGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-12 font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
    </div>
  );
}

/**
 * 普通说明正文。
 *
 * **字号不得低于 12px。** DESIGN.md §3 的排版表把 Small(12px)定为「Smallest sans-serif
 * text」,并对 Micro Label(10–13px)写明「**Auxiliary / non-reading** labels only …
 * Never used for body text or anything the user reads sentence-by-sentence」。这两段是
 * 用法与撤回方式 —— 用户要逐句读、还要照着往 X 里打字的正文,不是辅助标签,所以走 Small
 * 而不是 Micro(初版误用 text-11,#1347 review 由 codex 指出 P2)。行高与本组件的风险
 * 组统一取 1.45,让三组正文只有一套度量。
 *
 * **刻意不加 line-clamp。** DESIGN.md 的说明/提示类槽位规则要求「顶对齐、槽高 = 行高 ×
 * 最大行数、折行只向下伸展」,它真正禁的是「固定小槽 + flex 垂直居中」那种会把超行文本
 * 上下双向外溢、压到相邻控件的写法 —— 这里是纯 flex 列、顶对齐、向下伸展,不会压到谁。
 * 而给一段风险告知加省略号截断,等于把我们必须告知的内容藏起来,方向完全反了;四语言里
 * 某种语言偶尔跑到三行,也比截断安全。文案本身按 ≤2 行写。
 *
 * **颜色沿用 --text-tertiary(本仓 settings 说明文字的既有 token,约 157 处在用),这里
 * 刻意没跟着风险组一起提到 --text-primary。** 两者的判据不同:风险组那两段叠在 warning
 * alpha 底上、且 U2 裁决把 text-secondary 的低对比明确限定在「二级信息」,所以必须换;
 * 而 text-tertiary 在 CINDY 两套主题里已经被整改到 AA(light #686B72 = 5.03、dark
 * #BFC1C4 = 7.38,cindy-*.ts 注明「整改: 非 U2 token AA」),default 主题那份值
 * (light #a3a3a3 = 2.39 / dark #737373 = 2.95)属**冻结的主题数据**,不是本组件能单方面
 * 决定的;只把这一节的说明文字提亮,会让它比 settings 里其它所有说明文字都重一档 ——
 * 那是视觉取舍而非规范缺陷,留给 Dash 判断。
 */
function GuideBody({ children }: { children: React.ReactNode }) {
  return <span className="text-12 leading-[1.45] text-[var(--text-tertiary)]">{children}</span>;
}

export function XUsageGuide() {
  const { t } = useTranslation();
  const k = (name: string) => `settings.remoteControl.hook.x.guide.${name}`;

  return (
    // select-text 是必须的, 不是顺手加的: 本组件也渲染进 ConfirmDialog, 而它的根节点
    // 带 select-none(confirm-dialog.tsx 的 Content), 于是弹窗里 `@askmycindy` 与
    // `/delete` 选不中、复制不了 —— 而这两个恰恰是用户要**打进 X** 的字符串。
    // DESIGN.md §14.1 的判据就是「用户会不会想复制它」: 会 → 可选。
    <div className="flex select-text flex-col gap-3">
      <GuideGroup label={t(k('usageLabel'))}>
        <GuideBody>{t(k('usageBody'))}</GuideBody>
      </GuideGroup>

      {/* 风险组:沿用仓内既有的 warning callout 形态(见 ModelPriceOverrideDialog 的
          价格冲突提示)—— 图标 mt-0.5 shrink-0 顶对齐, 文本自己折行向下伸展。

          **但文字色刻意不跟那份:这两段走 --text-primary, 不是 --text-secondary。**
          DESIGN.md §15.5 的 U2 裁决把 text-secondary 的低对比**明确限定在「二级信息」**
          并承认它低于正文 4.5:1(cindy-dark.ts 就把它标成「直映: 二级信息; U2 例外」)。
          而这两段是用户绑定后必须读清的公开回帖与私密仓库暴露风险, 不是二级信息;
          叠上 warning-bg-soft 的橙色 alpha 底之后更差。实测(见
          renderer/__tests__/xUsageGuideRiskContrast.test.ts, 有用例钉着):

            合成底             text-secondary   text-primary
            default light            3.96           12.64
            default dark             4.38            7.46
            CINDY   light            2.71            8.77
            CINDY   dark             2.09            7.09

          四种组合下 secondary 全部低于 4.5, primary 全部 ≥7。修法是在组件内换语义色 ——
          **不能去改全局 token**: §15.5 写明 text-secondary 的值「never darken
          unilaterally」, 要改需要新的用户裁决(#1347 review 由 codex 指出 P2)。 */}
      <GuideGroup label={t(k('riskLabel'))}>
        <div className="flex gap-2 rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" />
          <div className="flex flex-col gap-1.5">
            <span className="text-12 leading-[1.45] text-[var(--text-primary)]">
              {t(k('riskPublicBody'))}
            </span>
            <span className="text-12 leading-[1.45] text-[var(--text-primary)]">
              {t(k('riskWorkdirBody'))}
            </span>
          </div>
        </div>
      </GuideGroup>

      <GuideGroup label={t(k('withdrawLabel'))}>
        <GuideBody>{t(k('withdrawBody'))}</GuideBody>
      </GuideGroup>
    </div>
  );
}
