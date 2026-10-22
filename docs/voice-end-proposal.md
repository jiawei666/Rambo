# 自然语言结束语音：待验证方案

日期：2026-10-19。状态：用户答“可以”，已确认参考 Grok 的模型语义判断、专用工具与宿主关闭 Live 方案，纳入 V07；尚未实现或验证。备用接入路径、媒体处理细节和验收用例仍是技术设计，不冒称用户逐项批准。

2026-10-20 静态调查更新：匹配本机 0.163.0 构建的源码已查到 WebRTC 复用 ChatGPT 认证及 Live→普通 Codex 回合交接路径；当前优先设计由普通回合调用宿主挂断工具，再由本应用释放媒体并停止 realtime。直接 WebSocket 音频分支另有 API Key 限制，不作为默认免额外 Key 方案。`realtime/stop` 不代替本机音轨/PeerConnection 清理，完整证据和限制见 [Voice 可行性调查](voice-feasibility.md)。本文未因更新而视为已完成运行验证。

## 目标与本次观察

用户实际试用当前 Codex 语音时，表达“退下”“退出语音”后，语音只口头回应，没有在当时关闭。该次后端可调用工具中没有结束语音接口。随后会话确实结束，但现有记录不能归因于后端成功执行挂断。

这一观察不证明 Codex App Server 无法停止实时会话；它说明当前客户端没有向当次模型调用开放相应动作。

## 推荐流程

参考 Grok 本机包已经找到的“模型语义判断 → 专用工具 → 挂断结果”路径，应用拥有最终音频生命周期。

1. 为 Bot 提供应用拥有的 `end_voice_session` 工具。此名称是我们拟定义的接口，不是声称 Codex 已有同名内置工具。
2. Bot 根据当前用户话语和上下文理解结束意图，自主调用；不要求固定短语，不通过匹配助手回复里的“再见”来触发。
3. 应用将调用绑定到当前语音会话，执行停止 Live，关闭该会话音频上传、播放与设备资源；仅在用户已启用唤醒监听时恢复本机唤醒检测。
4. 应用确认本地音频状态和实时会话关闭状态后记录结果；不能只把界面改成结束，连接却继续。
5. 结束语音与停止任务分开。如何处理既有任务沿产品规则，不能为挂断而直接杀掉 App Server 或中断全部任务。

可简短告别后挂断，也可立即结束；不能因为等待告别音频一直没有完成而无限延迟挂断。重复的结束请求按同一会话处理，避免旧工具请求关闭新通话。

## Codex 接入点与边界

- 官方 App Server 文档说明 `dynamicTools` 与 `item/tool/call` 可让客户端处理模型工具调用；它们是实验接口。
- 本次重新读取本机已有的协议生成物，`/tmp/grok-codex-0163-schema/ClientRequest.json` 及 `/tmp/codex-app-server-schema-voice/ClientRequest.ts` 均列出 `thread/realtime/stop`；对应参数包含 `threadId`，后者通知定义也列出 `thread/realtime/closed`。这些是本机已有协议快照，不是本次重新生成或完成实际语音测试。
- 先验证 Live 是否能直接使用宿主工具；若只能把请求委派给普通 Codex 回合，则由该回合调用宿主工具。不能将普通线程的动态工具能力直接当作 Live 模型已具备的能力。
- 若上述通路无法及时处理结束意图，再考虑由同一 Codex 后端单独进行语义控制判定并返回结构化结束动作；此为备选，不默认增加另一语音服务/API Key。
- 停止方法、通知、鉴权和音频收尾必须用最终打包版本实测。当前仅确认接口线索，不声称已经可靠打通。

来源：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 参考实现

- Grok Bot 官方帮助只描述手动挂断；但本次子 Agent 从用户指定本机包提取的静态代码，已由主 Agent 复读，明确包含自然语言结束规则、模型工具 `end_the_call` 注册与执行器返回 `hangUp: true`。可确认它有模型判断结束意图并发起挂断的静态设计；最终媒体关闭处理与线上运行可靠性仍未验证。详见 [本机静态证据](grok-voice-end-static.md)。这修正了此前仅依据公开帮助而得出的“内部未知”范围。[语音说明](https://prod.cursor.com/help/grok-bot/voice-chat)
- 已检查的 OpenMausBot 本地源码快照提供宿主 `end(callId)`、`POST /api/live/call/end` 和 `session.close`，但没有发现给 Live 模型注册的挂断工具或自然语言结束分类。不将局部源码检查泛化为所有版本绝无该能力。[Live 配置](https://github.com/milind-soni/OpenMausBot/blob/main/server/live-call.ts)、[控制器](https://github.com/milind-soni/OpenMausBot/blob/main/server/live-call-controller.ts)、[路由](https://github.com/milind-soni/OpenMausBot/blob/main/server/routes/live.ts)

用户本轮称“Open Manus”；本方案参考的是此前持续讨论的 OpenMausBot，并不将其和独立项目 OpenManus 当作同一项目。

## 实现时的验收

用户可自由表达结束意图后，Live 连接实际关闭、音频停止上传，且可再次唤醒。引用别人的“再见”、讨论“怎么结束语音”、仅要求取消某项任务，不应误挂断。任务仍在执行时也能结束语音；挂断不默认取消该任务。当前不运行测试或开始应用代码。


## 已确认的空闲结束补充

用户后续单独确认 V10：连续 5 分钟无人说话且 Bot 无执行中任务时结束 Live，恢复已启用的唤醒监听；设置可调整或关闭超时。该规则与模型理解用户结束意图的 V07 并行，不能用空闲计时替代语义挂断，也不能因任务期间用户没说话而提前关闭。尚待实现验证。
