<p align="center">
  <a href="https://github.com/jiawei666/Rambo/releases/latest">
    <img src="assets/branding/app-logo-source.png" width="168" height="168" alt="Rambo Logo" style="border-radius: 36px;" />
  </a>
</p>

<h1 align="center">Rambo</h1>

<p align="center">
  一台运行在自己电脑上的本地个人 AI Agent，支持 macOS 与 Windows。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/jiawei666/Rambo/releases/latest">下载</a> ·
  <a href="docs/product-decisions.md">产品决策</a> ·
  <a href="docs/technical-design.md">技术设计</a>
</p>

<p align="center">
  <a href="https://github.com/jiawei666/Rambo/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/jiawei666/Rambo?style=flat-square" /></a>
  <img alt="平台" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111111?style=flat-square" />
  <img alt="技术栈" src="https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848f?style=flat-square" />
  <img alt="运行时" src="https://img.shields.io/badge/runtime-Codex%20App%20Server-222222?style=flat-square" />
  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

---

## 为什么做 Rambo？

我想做一个真正长期运行在本机、有自己的记忆，也能按我的生活和工作节奏做事的 Personal Agent。**Rambo** 就是为此而做的个人项目。

Rambo 的界面与交互基于对 **Grok Bot** 桌面端的反编译和界面研究构建，底层 Agent 运行时使用 **Codex App Server**。它把一套熟悉的桌面应用体验、可长期保存的 Bot 记忆和本机工具能力放在同一个产品里。

> **项目状态：** Rambo 正在快速迭代。最新版本可以用于日常探索和试用，但还不是一个已经完成全量验收的成熟产品。详情见[项目状态](#项目状态)。

## 应用截图

### 连接应用

<p align="center">
  <a href="assets/screenshots/connected-apps.png">
    <img src="assets/screenshots/connected-apps.png" alt="Rambo 连接应用页面，展示 Gmail、QQ 邮箱、微信、日历和 GitHub" width="100%" />
  </a>
</p>

<p align="center"><sub>邮箱和本机服务只需连接一次，再按 Bot 独立分配访问权限。</sub></p>

### 每日计划与独立任务

<p align="center">
  <a href="assets/screenshots/life-manager-routines-light.png">
    <img src="assets/screenshots/life-manager-routines-light.png" alt="Rambo Bot 根据一句自然语言创建每日计划、应用巡检、午饭、健身和晚饭等多个独立任务" width="86%" />
  </a>
</p>

<p align="center"><sub>一句自然语言请求，就能生成当天安排、应用消息巡检，以及午饭、健身、晚饭和重要事项等多个独立任务。</sub></p>

<p align="center"><sub>截图中的账号标识已遮挡。</sub></p>

## 功能亮点

- **直接连接微信。** 在 macOS 和 Windows 上连接微信并读取聊天消息，两个平台均已实测稳定。
- **本机运行。** 支持 macOS 与 Windows，Bot、聊天、Routine、设置和记忆保存在自己的电脑上，使用独立的应用数据目录。
- **第三方 API 优先，同时支持 ChatGPT 登录。** 可以配置自己的 Responses 兼容第三方 API、Base URL 和 API Key，也可以直接登录 ChatGPT；API 凭证在本机加密保存，Rambo 始终使用自己的独立 Codex Home。
- **连接邮箱。** 支持 QQ 邮箱和 Gmail 的搜索、读取、附件、草稿、回复和发送。
- **浏览器自动化。** 授权 Bot 使用 CloakBrowser，通过共享持久 profile 执行网页自动化任务，并减少常见反爬机制干扰。
- **自主规划任务和提醒。** 可以用自然语言创建一次性或周期 Routine，查看执行历史，并处理暂停、恢复、立即运行和补跑。
- **多 Bot 群聊。** 多个 Bot 可以进入同一个群聊协作，同时保留各自的私聊、记忆、模型和权限配置。
- **逐 Bot 控制资源。** 在共享资源目录中管理 Skills、MCP、Apps 和 Plugins，每个 Bot 独立选择自己可以使用的能力。
- **语音对话。** 可以从当前 Bot 发起 Live 语音会话，转写进入聊天；结束后继续用文字对话。
- **处理本机文件。** 支持图片、PDF、文本、Markdown、CSV 和常见音视频预览；拖入文件只插入本机路径；Bot 回复可以引用工作区内外的本机文件。
- **丰富的聊天内容。** Markdown、代码高亮、数学公式、Mermaid 图、问题卡片、结构化结果卡、媒体和 MCP 嵌入共用同一套聊天界面。

## 功能介绍

### 直接连接微信

可以直接连接微信，并在 macOS 和 Windows 上读取聊天消息；两个系统的消息读取均已实测稳定。微信连接按 Bot 独立授权，不会自动暴露给所有助手。

### 本机 Personal Agent

Rambo 不是一个必须开在浏览器标签页里的云端工作台。它是一套支持 macOS 与 Windows 的原生桌面应用，自己管理 Agent 运行时，把产品数据保存在本机。它面向的是一个长期自用的个人助手，而不是又一个需要注册账号的 SaaS 产品。

### 模型接入

Rambo 把 Responses 兼容的第三方 API 作为一等模型来源。可以填写自己的 Base URL 和 API Key，在服务支持时从 `/models` 获取模型目录，也可以手动添加模型 ID；同时支持直接登录 ChatGPT。第三方服务的能力范围可能不同，不一定完整支持 Codex 的 Tool Calls、reasoning、MCP 或 Voice。

### 基于 Grok Bot 界面研究的复刻与扩展

已有页面、组件、样式和交互以对 Grok Bot 桌面端的反编译证据为依据，按已确定的产品范围复刻；Grok Bot 没有而 Rambo 需要的功能，则沿用同一套组件风格扩展。

Rambo 是独立项目，与 Grok、Google、OpenAI 以及所连接的服务没有隶属关系。

### 邮箱与其他连接应用

当前规划/实现中的连接包括：

- **Gmail**：新连接使用 Google 应用专用密码经 IMAP/SMTP 接入，并处理 Gmail 的本地化系统文件夹；已有本机 OAuth 凭证仅保留兼容读取。
- **QQ 邮箱**：搜索、读取、附件、草稿、回复和发送。
- **CloakBrowser**：为获授权 Bot 提供受管浏览器自动化，使用独立 Chromium 和共享持久 profile。
- **日历、GitHub 等 MCP 服务**：通过 MCP 和资源目录接入。

连接按 Bot 分配。一个 Bot 获得授权，不会自动把所有连接暴露给其他 Bot。

### 浏览器自动化

CloakBrowser 为获授权 Bot 提供受管浏览器，可执行网页导航、快照读取和交互操作。它使用独立 Chromium 和共享持久 profile；有访问权限的 Bot 会共享 Cookie、历史、扩展和标签页状态，因此只应授权可信 Bot。

CloakBrowser 可以减少常见反爬机制对任务的干扰，但不承诺绕过所有网站验证、验证码、登录或二次验证。网站拒绝执行时，Bot 会如实报告真实失败。

### 自主规划 Routine 和提醒

可以让 Bot 记住一件事、在之后执行任务，或按周期检查状态。Rambo 的 Routine 支持：

- 一次性任务和周期任务
- 一天内多个离散触发时刻
- 用自然语言创建、修改和暂停
- 立即运行、停止和查看执行历史
- 结果回到创建任务的 Bot
- 应用未运行时的补跑规则和去重

任务计划、触发记录和实际执行状态分开保存。创建了计划不等于未来已经成功执行。

### 多 Bot 群聊

群聊中的每个 Bot 都有自己的私聊上下文、模型、权限和资源开关。成员在同一个共享时间线中协作，实际执行内容仍然可以追溯到具体 Bot，而不是伪装成一个全局 Bot 的转述。

### Skills、MCP、Apps 和 Plugins 独立控制

Rambo 使用三层资源模型：

1. 发现本机可用的 Skills、MCP、Apps 和 Plugins。
2. 把需要的项目加入全局可选目录。
3. 每个 Bot 独立决定是否启用。

新建 Bot 时复制一次当时的共享默认值；创建之后，修改其他 Bot 或全局默认值不会悄悄改写这个 Bot 的配置。

### 语音对话

从当前 Bot 发起语音会话，实时转写会进入聊天。结束语音后，同一个 Bot 可以继续用文字处理后续任务。语音状态、转写和正式回复都围绕同一条 Bot 会话，而不是另开一个孤立页面。

### 聊天工作区与文件

聊天界面由悬浮的 Bot 标题、可滚动的消息区和底部输入框组成。文件可以在应用内预览、交给本机应用打开、在系统文件管理器中定位，也可以由 Bot 回复直接引用。

拖入输入框的文件只会插入本机绝对路径，不会自动上传或复制文件，也不会创建附件记录；附件处理仍走独立的附件流程。

## 架构

```text
┌─────────────────────────────────────────────┐
│ Rambo 桌面应用                              │
│  Electron + React + TypeScript              │
│                                             │
│  Bot · 聊天 · 群聊 · Routine · 记忆         │
│  连接应用 · 资源开关 · 文件                 │
└──────────────────────┬──────────────────────┘
                       │ stdio
┌──────────────────────▼──────────────────────┐
│ Codex App Server                            │
│  由 Rambo 启动和管理的独立子进程            │
└──────────────────────┬──────────────────────┘
                       │
              隔离的 Codex 配置、认证与工具资源
```

Rambo 的 macOS arm64 与 Windows x64 安装包分别内置一份经校验的 `codex-app-server` `0.165.0` 基线，因此干净安装无需先下载运行时即可启动。应用始终启动自己的 stdio 子进程，并把产品数据、聊天和运行时状态放在独立 Codex Home。检测到本机 Codex 配置时，可以复制受支持的配置和资源文件到这份独立副本。App Server 与应用版本分开，只有用户主动点击更新时才检查和切换版本。

## 安装

从 [GitHub Releases](https://github.com/jiawei666/Rambo/releases/latest) 下载最新的 macOS arm64 或 Windows x64 版本。

### macOS

1. 解压下载的 zip。
2. 把 `Rambo.app` 拖入“应用程序”文件夹。
3. 当前版本没有 Developer ID 签名，也没有公证，因此首次启动会被 macOS Gatekeeper 拦截。打开“系统设置 → 隐私与安全性”允许打开，或在 Finder 中按住 Control 点击应用并选择“打开”。
4. 打开应用并配置兼容的第三方 API，或直接登录 ChatGPT。内置运行时不需要机器上另外安装 Codex。

应用只有本地 ad-hoc 签名，不是无警告安装，也不包含 Developer ID 证书。

### Windows

1. 运行 NSIS 安装包，或解压免安装 ZIP。
2. Windows 构建当前没有代码签名，首次启动可能出现 SmartScreen 警告。确认安装包来自官方 Release 后，选择“更多信息 → 仍要运行”。
3. 打开应用并配置兼容的第三方 API，或直接登录 ChatGPT。内置运行时不需要机器上另外安装 Codex。

### 从源码开发

环境要求：

- Apple Silicon 上的 macOS，或 Windows 11 x64
- Node.js 和 npm
- 能安装 npm 依赖并准备首次运行时的网络环境

```sh
npm install
npm run dev
```

常用命令：

```sh
npm run build          # 构建 Electron 应用
npm run package:mac    # 生成未打包的 macOS 应用目录
npm run typecheck      # TypeScript 检查
npm run verify:fast    # 后端、验收、目录和台账检查
```

Rambo 使用独立的 Codex Home 保存自己的配置、认证、会话和状态。本机 Codex Home 不会被原地共享，只会把明确支持的配置与资源文件复制到 Rambo 的独立副本；Rambo 的会话也不会混入普通 Codex 历史列表。

## 项目状态

当前版本为 **v0.1.12**。验收目录包含 **159 条产品规则**、**291 个局部测试案例**、**163 个可执行案例**和 **128 个明确缺口**。

当前 Release 同时提供 macOS arm64 和 Windows x64。微信消息读取已在两个平台实测稳定；其他 Windows 专属流程仍需分别完成对应平台的验收证据。

最新版本的确定性检查和定向 Electron 用例通过，但这不等于所有产品规则都已完成验收。真实设备语音、外部账号、系统原生行为和部分完整端到端流程仍待复验。仓库把规则级状态和证据分开保存，避免把局部测试误报成完整产品验收。

详情见[全量验收矩阵](docs/acceptance-matrix.md)、[验收测试计划](docs/acceptance-test-plan.md)和[实施记录](docs/implementation-progress.md)。

## 文档

- [产品决策](docs/product-decisions.md)
- [技术设计](docs/technical-design.md)
- [全量验收矩阵](docs/acceptance-matrix.md)
- [验收测试计划](docs/acceptance-test-plan.md)
- [实施记录](docs/implementation-progress.md)
- [文件预览兼容性](docs/file-preview-compatibility.md)
- [品牌素材](docs/branding.md)

## 许可

本项目采用 [MIT License](LICENSE) 开源。

## 致谢

Rambo 的界面研究基于 Grok Bot 桌面端；Agent 运行时基于 Codex 和 Codex App Server。感谢 Electron、React、Vite、Mermaid、KaTeX 和本机媒体工具等项目为这个应用提供基础能力。
