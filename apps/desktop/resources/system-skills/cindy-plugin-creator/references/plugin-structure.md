## 1. 目录结构(最小可用)

```
my-ghost/
├── ghost.json    ← 身份卡(必须,zip 根部)
├── main.js       ← 电子脑:后台逻辑入口(声明了 tools/cindy 时必须)
├── assets/
│   └── icon.png  ← 建议:插件图标(声明 icon 字段时必须存在;scaffold 会生成占位图,请替换成自己的)
├── locales/      ← 可选:宿主驱动的清单文案翻译(声明 locales 时英文必须存在)
│   ├── en.json
│   ├── zh-CN.json
│   ├── ja.json
│   └── ko.json
├── node/
│   └── worker.cjs ← 可选:随包 Node/stdio MCP 入口(声明 node 时必须,见 §4.12)
├── panel.html    ← 面板界面(声明了 panel.html 时必须)
├── panel.css
├── panel.js
├── main-view.html ← 一级主视图(声明了 mainView.html 时必须,见 §4.20)
└── settings.html ← 自定义设置区(声明了 settingsHtml 时必须,见 §4.8)
```

想看**真实完整范例**,浏览官方插件源码仓
`github.com/makecindy/cindy-official-plugins`:仓库根下每个**含 ghost.json 的
一级目录**(cindy-art、cindy-github、cindy-web-search……)都是一个已上架插件的
全部源码,各类能力(聊天卡片/
面板/网络/设置页)都有现成写法可对照;`.tests`、`docs` 等无 ghost.json 的
目录是仓库自身的基础设施,不是插件。需要理解宿主侧能力实现(某项能力的代发
细节、校验器行为)时可参考主仓 `github.com/makecindy/cindy`(插件基座在
`apps/desktop/src/main/cindy-brain/`),但**API 契约一律以本手册为准**——
线上 main 分支可能领先或落后用户当前安装的主机版本,照 main 写码可能装进
旧版就不工作。
