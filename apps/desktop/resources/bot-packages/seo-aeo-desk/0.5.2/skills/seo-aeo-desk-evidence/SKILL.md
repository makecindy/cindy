---
name: seo-aeo-desk-evidence
description: 整理用户提供的关键词和问题：归一化、去重、按意图分组，指标缺失保持未知；不联网、不估算搜索量。
---

# 原创离线辅助检查

整理用户提供的关键词和问题：归一化、去重、按意图分组，指标缺失保持未知；不联网、不估算搜索量。

输入输出示例见 templates/input.json 与 templates/contract.md。用户要求对已提供数据做本地处理时，先检查脚本，再从stdin传JSON运行：

    python3 scripts/keyword_board.py < selected-input.json

脚本只用Python 3.10+标准库，不访问网络/Home，不写文件，不执行子进程。安装与打包不会执行它。成功exit0，输入结构/引用错误exit2；语义缺口在输出字段中保持可见。输入≤1MiB，最多10000条；所有示例都是合成数据。输出不是凭证、授权、测试或真实连接证明。
