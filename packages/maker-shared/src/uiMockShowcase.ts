import type { RichAnswerKind } from "./richAnswer";
import type { UiMockProject, UiMockTask } from "./uiMock";

/** Synthetic, bilingual project for repeatable full-client screenshots. No real user data. */
type Locale = "zh" | "en";
type Node = {
  id: string;
  kind: RichAnswerKind;
  parent?: string;
  props: Record<string, unknown>;
};
const phrase = (locale: Locale, zh: string, en: string) =>
  locale === "zh" ? zh : en;
const answer = (summary: string, nodes: Node[]) =>
  `${summary}\n\n\`\`\`cindy-ui\n${nodes
    .map((node, index) =>
      JSON.stringify({
        seq: index + 1,
        ...(index === 0 ? { version: 1 } : {}),
        op: "create",
        ...node,
      }),
    )
    .join("\n")}\n\`\`\``;

const feedback = [
  { zh: "新手引导", en: "Onboarding", count: 86 },
  { zh: "探索节奏", en: "Exploration", count: 64 },
  { zh: "操作手感", en: "Controls", count: 52 },
  { zh: "画面表现", en: "Visuals", count: 38 },
] as const;
const completion = [48, 56, 63, 72] as const;
const feedbackTotal = feedback.reduce((total, item) => total + item.count, 0);

function feedbackAnswer(locale: Locale): string {
  const t = (zh: string, en: string) => phrase(locale, zh, en);
  return answer(
    t(
      "先把开场十分钟做好，再扩充地图。",
      "Make the first ten minutes shine before expanding the map.",
    ),
    [
      { id: "report", kind: "stack", props: { style: { gap: 16 } } },
      {
        id: "eyebrow",
        kind: "text",
        parent: "report",
        props: {
          text: "ORBIT GARDEN / PLAYTEST 04",
          style: {
            fontFamily: "monospace",
            fontSize: 11,
            letterSpacing: 1.2,
            color: "secondary",
          },
        },
      },
      {
        id: "heading",
        kind: "heading",
        parent: "report",
        props: {
          text: t("让开场十分钟，更好玩", "A better first ten minutes"),
          style: { fontSize: 24, fontWeight: 600, lineHeight: 1.25 },
        },
      },
      {
        id: "metrics",
        kind: "grid",
        parent: "report",
        props: { columns: 3, mobileColumns: 3, style: { gap: 12 } },
      },
      {
        id: "feedback",
        kind: "stat",
        parent: "metrics",
        props: { label: t("试玩反馈", "Responses"), value: feedbackTotal },
      },
      {
        id: "completion",
        kind: "stat",
        parent: "metrics",
        props: {
          label: t("引导完成率", "Completion"),
          value: completion.at(-1),
          suffix: "%",
        },
      },
      {
        id: "improvement",
        kind: "stat",
        parent: "metrics",
        props: {
          label: t("较首轮提升", "Point gain"),
          prefix: "+",
          value: completion[3] - completion[0],
        },
      },
      {
        id: "trend",
        kind: "chart",
        parent: "report",
        props: {
          label: t(
            "每一次迭代，都让玩家多走一步",
            "More players make it through with each build",
          ),
          variant: "line",
          data: completion.map((value, index) => ({
            label: `0${index + 1}`,
            value,
          })),
          height: 160,
          yMin: 40,
          yMax: 80,
          ticks: 3,
          showValues: true,
          showPoints: true,
          showGrid: true,
          strokeWidth: 2.5,
          pointRadius: 3,
        },
      },
      { id: "rule", kind: "divider", parent: "report", props: {} },
      {
        id: "next",
        kind: "text",
        parent: "report",
        props: {
          text: t(
            "下一步 · 缩短教学，提前开放自由探索。",
            "Next · Less tutorial. More room to explore.",
          ),
          style: { fontWeight: 600, fontSize: 15 },
        },
      },
      {
        id: "evidence",
        kind: "text",
        parent: "report",
        props: {
          text: t(
            "86 条反馈指向新手引导，是最集中的改进机会。",
            "Onboarding leads with 86 mentions: the clearest place to start.",
          ),
          style: { color: "secondary", fontSize: 13 },
        },
      },
      {
        id: "source",
        kind: "text",
        parent: "report",
        props: {
          text: t(
            "示例数据 · 完整分析见 reports/playtest.md",
            "Synthetic data · Full analysis in reports/playtest.md",
          ),
          style: { color: "tertiary", fontSize: 11 },
        },
      },
    ],
  );
}

function planAnswer(locale: Locale): string {
  const t = (zh: string, en: string) => phrase(locale, zh, en);
  return answer(
    t(
      "先做一轮小而完整的改进。拖动人数、调整范围，就能比较计划。",
      "Keep the next iteration focused. Adjust the team and scope to compare plans.",
    ),
    [
      { id: "plan", kind: "stack", props: { style: { gap: 16 } } },
      {
        id: "eyebrow",
        kind: "text",
        parent: "plan",
        props: {
          text: "ORBIT GARDEN / NEXT BUILD",
          style: {
            fontFamily: "monospace",
            fontSize: 11,
            letterSpacing: 1.2,
            color: "secondary",
          },
        },
      },
      {
        id: "heading",
        kind: "heading",
        parent: "plan",
        props: {
          text: t("下一轮试玩，怎么排？", "Shape the next playtest"),
          style: { fontSize: 24, fontWeight: 600 },
        },
      },
      {
        id: "team",
        kind: "range",
        parent: "plan",
        props: {
          label: t("投入人数", "People on this build"),
          min: 1,
          max: 4,
          step: 1,
          default: 2,
          suffix: t("人", " people"),
        },
      },
      {
        id: "exploration",
        kind: "check",
        parent: "plan",
        props: {
          label: t(
            "提前开放自由探索 · +12 小时",
            "Open exploration earlier · +12 hours",
          ),
          default: true,
        },
      },
      {
        id: "haptics",
        kind: "check",
        parent: "plan",
        props: {
          label: t(
            "增加手柄反馈 · +12 小时",
            "Add controller feedback · +12 hours",
          ),
          default: false,
        },
      },
      { id: "rule", kind: "divider", parent: "plan", props: {} },
      {
        id: "estimate",
        kind: "grid",
        parent: "plan",
        props: { columns: 2, mobileColumns: 2, style: { gap: 24 } },
      },
      {
        id: "hours",
        kind: "stat",
        parent: "estimate",
        props: {
          label: t("预计工作量", "Estimated effort"),
          value: {
            op: "add",
            args: [
              24,
              { op: "if", args: [{ ref: "exploration" }, 12, 0] },
              { op: "if", args: [{ ref: "haptics" }, 12, 0] },
            ],
          },
          suffix: t(" 小时", " h"),
        },
      },
      {
        id: "days",
        kind: "stat",
        parent: "estimate",
        props: {
          label: t("预计制作时间", "Build time"),
          value: {
            op: "div",
            args: [{ ref: "hours" }, { op: "mul", args: [{ ref: "team" }, 6] }],
          },
          suffix: t(" 天", " days"),
        },
      },
      {
        id: "scope",
        kind: "text",
        parent: "plan",
        props: {
          text: t(
            "基础范围：重写引导、整理反馈、回归验证。",
            "Core scope: tutorial rewrite, feedback triage, and regression checks.",
          ),
          style: { fontSize: 13, color: "secondary" },
        },
      },
      {
        id: "note",
        kind: "text",
        parent: "plan",
        props: {
          text: t(
            "每人每天按 6 小时估算；不含外部等待。调整只用于比较，不会启动任务。",
            "Assumes 6 focused hours per person per day; excludes external waits. Controls compare plans only.",
          ),
          style: { fontSize: 11, color: "tertiary" },
        },
      },
    ],
  );
}

function project(locale: Locale): UiMockProject {
  const t = (zh: string, en: string) => phrase(locale, zh, en);
  return {
    name: `orbit-garden-${locale}`,
    files: {
      "README.md": t(
        "# 星间花园 / Orbit Garden\n\n一款关于探索、种植与小小发现的虚构独立游戏。\n\n这套合成项目用于 Cindy 开发测试和官网界面展示，不是真实用户或产品的成绩。\n\n## 本轮目标\n\n把开场十分钟做好：缩短教学、提前开放探索、保留玩家自己发现的乐趣。\n\n- reports/playtest.md：试玩复盘\n- data/feedback.csv：240 条反馈的主题汇总\n- data/completion.csv：四轮引导完成率\n- plans/next-build.md：下一轮制作计划\n",
        "# Orbit Garden\n\nA fictional indie game about exploring, growing, and small discoveries.\n\nSynthetic project for Cindy development and website screenshots, not real customer or product results.\n\n## This build\n\nMake the first ten minutes shine: a shorter tutorial, earlier exploration, and room for discovery.\n\n- reports/playtest.md: playtest findings\n- data/feedback.csv: topic counts from 240 synthetic responses\n- data/completion.csv: completion across four builds\n- plans/next-build.md: the next iteration\n",
      ),
      "data/feedback.csv": `topic,responses\n${feedback.map((item) => `${item.en},${item.count}`).join("\n")}\n`,
      "data/completion.csv": `build,completion_percent\n${completion.map((value, index) => `0${index + 1},${value}`).join("\n")}\n`,
      "reports/playtest.md": t(
        `# 把开场十分钟做好\n\n> Orbit Garden · 第 04 轮试玩 · 合成演示数据\n\n## 已经变好的部分\n\n引导完成率从 48% 提升到 72%，提高了 24 个百分点。\n\n## 玩家还在意什么\n\n${feedback.map((item) => `- ${item.zh}：${item.count} 条`).join("\n")}\n\n共 ${feedbackTotal} 条反馈，每条只计入一个主要主题。\n\n## 下一步\n\n1. 把开场教学压缩为三个可操作的步骤。\n2. 提前开放第一片自由探索区域。\n3. 下一轮继续观察引导完成率，不急着扩充地图。\n`,
        `# Make the first ten minutes shine\n\n> Orbit Garden · Playtest 04 · Synthetic demo data\n\n## What improved\n\nTutorial completion rose from 48% to 72%, a gain of 24 percentage points.\n\n## What players still mention\n\n${feedback.map((item) => `- ${item.en}: ${item.count}`).join("\n")}\n\n${feedbackTotal} responses; each counted under one primary topic.\n\n## Next build\n\n1. Reduce the opening tutorial to three playable steps.\n2. Open the first free-exploration area earlier.\n3. Track completion again before expanding the map.\n`,
      ),
      "plans/next-build.md": t(
        "# 下一轮试玩\n\n合成估算；每人每天 6 小时，不含外部等待。\n\n| 范围 | 小时 |\n| --- | ---: |\n| 重写引导、整理反馈与回归验证 | 24 |\n| 提前开放自由探索（已选） | 12 |\n| 增加手柄反馈（备选） | 12 |\n\n当前方案：36 小时，2 人投入，预计 3 天。对话里的控件只比较方案，不启动工作。\n",
        "# Next playtest\n\nSynthetic estimate; 6 focused hours per person per day, excluding external waits.\n\n| Scope | Hours |\n| --- | ---: |\n| Tutorial rewrite, feedback triage, regression checks | 24 |\n| Earlier exploration (selected) | 12 |\n| Controller feedback (optional) | 12 |\n\nCurrent plan: 36 hours across 2 people, estimated at 3 days. Conversation controls compare plans without starting work.\n",
      ),
    },
  };
}

function tasks(locale: Locale): UiMockTask[] {
  const t = (zh: string, en: string) => phrase(locale, zh, en);
  const common = {
    project: `orbit-garden-${locale}`,
    effort: "high",
    status: "active",
    source: "desktop",
    pinned: true,
  } as const;
  return [
    {
      ...common,
      id: `ui-mock-showcase-feedback-${locale}`,
      title: t("星间花园 · 试玩复盘", "Orbit Garden · Playtest findings"),
      agentKind: "cc",
      model: "claude-sonnet-5-5",
      minutesAgo: 0,
      messages: [
        {
          role: "user",
          text: t(
            "看看这轮试玩反馈，下一版最值得改什么？",
            "Look through the playtest feedback. What should we improve next?",
          ),
        },
        { role: "assistant", text: feedbackAnswer(locale) },
      ],
    },
    {
      ...common,
      id: `ui-mock-showcase-plan-${locale}`,
      title: t("下一轮试玩 · 交互计划", "Next playtest · Interactive plan"),
      agentKind: "pi",
      model: "chatgpt/gpt-6.1-sol",
      minutesAgo: 2,
      messages: [
        {
          role: "user",
          text: t(
            "我们有两个人。帮我比较一下下一轮的制作范围。",
            "There are two of us. Help me compare the scope for our next build.",
          ),
        },
        { role: "assistant", text: planAnswer(locale) },
      ],
    },
    {
      ...common,
      id: `ui-mock-showcase-review-${locale}`,
      title: t("引导流程 · 代码审查", "Tutorial flow · Code review"),
      agentKind: "codex",
      model: "gpt-6.1-sol",
      minutesAgo: 8,
      messages: [
        {
          role: "user",
          text: t(
            "新引导准备好了，检查一下边界情况。",
            "The new tutorial is ready. Check the edge cases.",
          ),
        },
        {
          role: "assistant",
          text: t(
            "重点检查了跳过引导、重新进入和手柄操作三条路径。下一轮试玩时，先确认玩家跳过教学后仍能找到第一片花园。\n\n这是合成审查场景，不代表实际执行了测试。",
            "Reviewed the skip, re-entry, and controller paths in this demo scenario. In the next playtest, first check whether players who skip the tutorial can still find the first garden.\n\nSynthetic review scenario; no real tests were executed.",
          ),
        },
      ],
    },
    {
      ...common,
      id: `ui-mock-showcase-release-${locale}`,
      title: t("试玩邀请 · 中英双语", "Playtest invitation · Two languages"),
      agentKind: "pi",
      model: "chatgpt/gpt-6.1-sol",
      minutesAgo: 18,
      messages: [
        {
          role: "user",
          text: t(
            "写一段下一轮试玩邀请，轻松一点。",
            "Write a friendly invitation for the next playtest.",
          ),
        },
        {
          role: "assistant",
          text: t(
            "花园又长大了一点。\n\n这次，你能更早走出小径，种下第一颗种子。欢迎来逛十分钟，再告诉我们：哪个瞬间让你想继续玩？\n\n*合成演示文案，尚未发送。*",
            "The garden has grown a little.\n\nStep off the path sooner, plant your first seed, and see what turns up. Come spend ten minutes with us, then tell us: which moment made you want to keep playing?\n\n*Synthetic draft. Not sent.*",
          ),
        },
      ],
    },
  ];
}

export const UI_MOCK_SHOWCASE_PROJECTS: readonly UiMockProject[] = [
  "zh",
  "en",
].map((locale) => project(locale as Locale));
export const UI_MOCK_SHOWCASE_TASKS: readonly UiMockTask[] = [
  "zh",
  "en",
].flatMap((locale) => tasks(locale as Locale));
