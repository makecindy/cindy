# 托管听写润色的提示词兼容

> **读取时机**：修改默认听写润色正文、请求构造或发布兼容检查之前
> **适用路径**：`packages/voice-input-core/src/DictationRefiner.ts`、`scripts/check-voice-refinement-compat.mjs`

默认听写保留自然口语，明确口述的标点、换行按意图转换，自动列表等排版偏好通过用户自定义整理要求表达。

Voice Server 对正式润色和预热的 system 消息按 UTF-8 计算 SHA-256。改一个字也会产生新指纹。修改内置正文时更新缓存版本，先将新指纹加入服务端的 dictation_refinement 清单并保留仍在使用的旧指纹；部署若覆盖了默认清单，也要追加。再让客户端 CI 运行 `pnpm exec vite-node scripts/check-voice-refinement-compat.mjs`，由两个正式区域的运行态清单确认指纹。服务端 main 合入只表示开发环境进入发布流程。
