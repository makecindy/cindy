import { REMOTE_RESOURCE_GET_CHANNEL } from "@cindy/device-link";
import { UI_MOCK_PR_CARD_IDS } from "@cindy/maker-shared/ui-mock";

/**
 * Card resources for the shared "PR 卡片各状态" mock task. The blocks are what a rich desktop host
 * sends for the GitHub plugin's PR card (asking with settings open, draft, following, merged),
 * generated from the plugin's HTML through the desktop projection, so the phone renders real data.
 */
const BLOCKS: Record<keyof typeof UI_MOCK_PR_CARD_IDS, unknown[]> = {
  "ask": [
    {
      "id": "text",
      "primitive": "markdown",
      "fallbackMarkdown": "要发 PR 吗？\ncindy\\-demo/web\n\nfix/login\\-width → main · 1 个提交 · 1 个文件\n\nPR 设置"
    },
    {
      "id": "actions",
      "primitive": "plugin-card-actions",
      "fallbackMarkdown": "",
      "data": {
        "pluginId": "cindy-github",
        "revision": "1",
        "mail": null,
        "legacyMail": false,
        "mailUpload": false,
        "form": null,
        "items": [
          {
            "id": "prui:settings",
            "label": "收起 PR 设置",
            "disabled": false
          },
          {
            "id": "pr:draft",
            "label": "发成草稿",
            "disabled": false
          },
          {
            "id": "pr:publish",
            "label": "发 PR",
            "disabled": false,
            "primary": true
          },
          {
            "id": "prset:rename",
            "label": "开启「发完自动改名」",
            "disabled": false,
            "toggle": {
              "on": false,
              "title": "发完自动改名",
              "hint": "任务标题改成 PR 号和标题"
            }
          },
          {
            "id": "prset:follow",
            "label": "关闭「发完自动跟进」",
            "disabled": false,
            "toggle": {
              "on": true,
              "title": "发完自动跟进",
              "hint": "后台修 CI 和 review 意见，需要你时再通知"
            }
          }
        ]
      }
    }
  ],
  "draft": [
    {
      "id": "text",
      "primitive": "markdown",
      "fallbackMarkdown": "\\#42 登录页表单随窗口收缩\ncindy\\-demo/web · 草稿\n\nfix/login\\-width → main · 1 个提交 · 1 个文件"
    },
    {
      "id": "actions",
      "primitive": "plugin-card-actions",
      "fallbackMarkdown": "",
      "data": {
        "pluginId": "cindy-github",
        "revision": "1",
        "mail": null,
        "legacyMail": false,
        "mailUpload": false,
        "form": null,
        "items": [
          {
            "id": "link:0",
            "label": "#42 登录页表单随窗口收缩",
            "url": "https://github.com/cindy-demo/web/pull/42",
            "disabled": false
          },
          {
            "id": "prui:settings",
            "label": "PR 设置",
            "disabled": false
          },
          {
            "id": "pr:ready",
            "label": "转为正式 PR",
            "disabled": false,
            "primary": true
          }
        ]
      }
    }
  ],
  "following": [
    {
      "id": "text",
      "primitive": "markdown",
      "fallbackMarkdown": "\\#42 登录页表单随窗口收缩\ncindy\\-demo/web"
    },
    {
      "id": "actions",
      "primitive": "plugin-card-actions",
      "fallbackMarkdown": "",
      "data": {
        "pluginId": "cindy-github",
        "revision": "1",
        "mail": null,
        "legacyMail": false,
        "mailUpload": false,
        "form": null,
        "items": [
          {
            "id": "link:0",
            "label": "#42 登录页表单随窗口收缩",
            "url": "https://github.com/cindy-demo/web/pull/42",
            "disabled": false
          },
          {
            "id": "prui:settings",
            "label": "PR 设置",
            "disabled": false
          },
          {
            "id": "pr:stop",
            "label": "停止",
            "disabled": false
          }
        ],
        "live": "跟进中",
        "prStatus": [
          {
            "key": "cindy-demo/web#42",
            "fallback": [
              "CI 通过",
              "没有待处理意见",
              "可以合并"
            ],
            "status": {
              "ok": true,
              "owner": "cindy-demo",
              "repo": "web",
              "prNumber": 42,
              "status": "open",
              "title": "",
              "htmlUrl": "",
              "branch": "",
              "unresolvedCount": 0,
              "checks": {
                "total": 4,
                "passed": 4,
                "failed": 0,
                "pending": 0,
                "skipped": 0
              },
              "mergeState": "CLEAN",
              "reviewDecision": "APPROVED"
            }
          }
        ]
      }
    }
  ],
  "merged": [
    {
      "id": "text",
      "primitive": "markdown",
      "fallbackMarkdown": "\\#42 登录页表单随窗口收缩\ncindy\\-demo/web · 已合并 · 跟进已结束\n\nfix/login\\-width → main · 1 个提交 · 1 个文件"
    },
    {
      "id": "actions",
      "primitive": "plugin-card-actions",
      "fallbackMarkdown": "",
      "data": {
        "pluginId": "cindy-github",
        "revision": "1",
        "mail": null,
        "legacyMail": false,
        "mailUpload": false,
        "form": null,
        "items": [
          {
            "id": "link:0",
            "label": "#42 登录页表单随窗口收缩",
            "url": "https://github.com/cindy-demo/web/pull/42",
            "disabled": false
          }
        ]
      }
    }
  ]
};

export function prCardVisualFixture(channel: string, args: unknown[]): unknown {
  const request = args[0] as { ref?: { collectionId: string; kind: string; id: string } } | undefined;
  if (channel !== REMOTE_RESOURCE_GET_CHANNEL || request?.ref?.collectionId !== "plugin-results") return undefined;
  let callId: unknown;
  try { callId = (JSON.parse(request.ref.id) as unknown[])[1]; } catch { return undefined; }
  const state = (Object.keys(UI_MOCK_PR_CARD_IDS) as Array<keyof typeof UI_MOCK_PR_CARD_IDS>)
    .find((key) => UI_MOCK_PR_CARD_IDS[key] === callId);
  if (!state) return undefined;
  return { ref: request.ref, revision: "1", display: { title: "GitHub" }, actions: [], links: [], blocks: BLOCKS[state] };
}
