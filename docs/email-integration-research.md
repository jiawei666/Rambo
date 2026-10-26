# QQ 邮箱与 Gmail 接入核对

日期：2026-10-20。状态：官方资料研究与设计输入，未接入用户邮箱、未编写连接代码或验证真实调用。产品要求见 T10；两家都必须验收，基础操作范围已由 Q34/T11 确认；实际接入与能力尚待验证。

## QQ 邮箱

- QQ 官方帮助明确在设置的账号与安全/安全设置中启用 POP3/IMAP/SMTP 服务并生成授权码，第三方客户端使用授权码而非登录密码。授权码状态受账号配置影响。
- 当前明确的通用路径是 IMAP 收取/读取与 SMTP 发送；个人邮箱和企业邮箱服务器不能混用。个人 IMAP/SMTP 主机/端口须以最终配置和真实账号联调证明，本次不把其他厂商指南当腾讯官方端口承诺。
- 腾讯 WorkBuddy 的 QQ 邮箱连接器说明支持收发、搜索、整理；其二维码授权不能被推定为任何第三方均可复用的开放 OAuth/MCP。
- IMAP 草稿、文件夹映射、标记等具体兼容性尚未用 QQ 实测。本次未找到 QQ 邮箱官方公开 MCP/通用 OAuth 接入证据，不等同于证明它们绝不存在。

来源：[QQ 邮箱授权码官方帮助](https://help.mail.qq.com/detail/106/985)、[腾讯 WorkBuddy QQ 邮箱连接器](https://cloud.tencent.com/document/product/1831/134525)。

## Gmail

- Google 官方桌面 quickstart 要求 Google Cloud 项目、启用 Gmail API、创建 Desktop app OAuth 2.0 Client ID，之后用户正常授权；可在本机保存并刷新令牌，不等于免授权。
- Gmail API 提供查询/读取消息、附件、草稿管理与发送；修改标签、垃圾箱等也有独立方法。所需 OAuth scope 取决于最终操作范围，具体配套条件按官方说明及自用场景落实。
- 本次没有证据证明独立 App Server 可直接继承当前 Codex Apps 的 Gmail 连接，也未确认 Google 官方 Gmail MCP；这些保留为技术验证，不能凭本会话存在工具就宣布 Rambo 已接入。

来源：[Gmail API 桌面 quickstart](https://developers.google.com/workspace/gmail/api/quickstart/python)、[Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Gmail API 方法](https://developers.google.com/workspace/gmail/api/reference/rest)。

## Rambo 接入设计边界

先核对已有 Codex 可复用资源是否真实可用；若需自行适配，可研究将上述协议/API 包装为应用可管理的本地 MCP/工具连接，沿用逐 Bot 分配。此为待验证技术路径，不改变 T07 的直连思路，也不默认引入 Composio。

凭据通过后续应用设置/服务授权处理，不在聊天索要或打印。当前仅确认服务和核对公开能力，未取得用户任意实际发信指令，也没有发送邮件。


## 语音与文字的共同执行入口

用户明确纠正并确认：邮件请求的自然语言理解与工具选择由 Codex Voice/底层 Codex 会话承担，文字和语音共用邮件工具。Rambo 负责接通连接、授权、工具和语音生命周期，不另实现一套邮件语音指令解析器。邮件范围选择仍是工具能力范围选择，不是分别开发两套输入通道的业务功能。

## 首版账号数量

Q36/T13 已确定同一服务只接一个账号：QQ 一个加 Gmail 一个。无需实现同服务多账号；已有逐 Bot 分配、两家基础操作与默认发件规则继续验收。


## 2026-10-26 更新：Gmail 采用应用专用密码

按用户后续明确选择，Gmail 新连接不再使用 Gmail API/OAuth，而使用 Google App Password 经 IMAP/SMTP 接入。Gmail API OAuth 研究结论仍保留为历史技术背景；现行产品规则见 T20/Q155。App Password 需要开启两步验证，部分 Google 账号因组织或高级安全策略不可用；它是可重复使用到撤销的专用密码，不是一次性验证码。Google 将此方法作为较不安全客户端的兼容方式，并推荐使用 Google 登录授权。

官方依据：[Google 应用专用密码](https://support.google.com/mail/answer/185833)、[Gmail IMAP/SMTP 客户端设置](https://support.google.com/mail/answer/78892)。模拟 Adapter 测试不能替代真实 Google 账号连接和邮件操作验收。
