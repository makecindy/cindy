---
name: video-editor-evidence
description: 检查原创剪辑计划的时间线/素材引用和权利声明，输出连续帧区间；不处理媒体或渲染。
---

# 原创离线辅助检查

检查原创剪辑计划的时间线/素材引用和权利声明，输出连续帧区间；不处理媒体或渲染。

输入输出示例见 templates/input.json 与 templates/contract.md。用户要求对已提供数据做本地处理时，先检查脚本，再从stdin传JSON运行：

    python3 scripts/timeline_check.py < selected-input.json

脚本只用Python 3.10+标准库，不访问网络/Home，不写文件，不执行子进程。安装与打包不会执行它。成功exit0，输入结构/引用错误exit2；语义缺口在输出字段中保持可见。输入≤1MiB，最多10000条；所有示例都是合成数据。输出不是凭证、授权、测试或真实连接证明。
