# Grok Bot 自然语言挂断静态证据

日期：2026-10-19。来源：用户指定的 `/Applications/Grok Bot.app/Contents/Resources/app.asar`，成员 `dist/electron-main/main-app.cjs`。子 Agent 提取，主 Agent 复读 `/tmp/grokbot-end-call-evidence.txt`。以下偏移为子 Agent 报告的成员内偏移，非 ASAR 整体偏移。

## 观察

- 成员偏移约 798218：工具名变量对应 `end_the_call`（此项为子 Agent 报告；主 Agent 复读的精简文件未包含变量定义）。
- 偏移 804160：`endTheCall()` 返回工具描述。含义是根据用户告别或结束意图挂断；普通停顿、工作途中“ok”、取消工作含义的“stop”不应挂断；不能在用户仍有请求时调用；要求先说完告别，因为调用后线路立即断开。
- 偏移 838389：模型函数工具注册片段：`{type:"function",name:So,description:qr.endTheCall(),parameters:{type:"object",properties:{}}}`。
- 偏移 839929：执行器片段：`execute(){return Promise.resolve({hangUp:!0})}`。

## 能说明什么

静态包支持“模型根据自然语言判断 → 调用专用结束工具 → 返回挂断标记”的设计，直接对应用户想要的语义结束体验。不需要把描述中的示例说法实现成固定词表。

尚未追到宿主如何消费 `hangUp` 以及如何关闭全部媒体资源；没有运行时证明模型每次都正确调用。不能将静态设计说成已经完整实测。

主 Agent 同时尝试 REA 仅分析该成员（2000 节点上限、10 秒单源超时），提供者超时，未得到可引用的完整语义图。返回的部分证据 ID 为 `ev_92b651093ea495c7683864a6e6668b8039fd13f9f6ba405ac4732da39f476254`；本结论依赖上述直接代码片段复读，而非声称 REA 已完成整个调用链分析。
