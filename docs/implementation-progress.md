# 实施进度

## 2026-10-31 · Q215 微信媒体临时文件与定时清理

- 微信图片、语音和视频不再由动态 Tool 返回 `data:` URL 或 base64。`WechatMediaContentProcessor` 将内存解密/转码后的媒体写入 `<userData>/composer-attachments/wechat-media-<epoch-ms>-<8hex>.<ext>`，目录 `0700`、文件 `0600`；Tool 只返回 `local_path`、`expires_in_days: 7`、处理后的 MIME/文件名。视频另返回原视频路径和最多 12 张 `frame_paths`。
- `cleanupComposerAttachments` 将 `wechat-media-*` 纳入既有清理规则：未引用 7 天、已引用 30 天删除，当前草稿占用跳过，启动时和每 24 小时检查，不跟随符号链接；图片、常见语音/视频扩展名均纳入目标集合，其他文件不删除。
- Agent 提示改为读取 `local_path`：图片调用 `view_image({ path: local_path })`，视频按 `frame_paths` 逐帧读取；语音优先使用微信已有 `transcription`，没有可靠转写时明确说明无法识别，不能凭路径猜测内容。没有临时目录时图片/语音直接失败，不退回 inline base64。
- 真实 `macOS WeChat 4.2.0` 正式 Connection、Bot Grant、构建后的 Worker 和生产 `wechat_media` Tool 路径通过：图片 1360×677 PNG（568,979 字节），语音 3.62 秒、24 kHz、16-bit 单声道 WAV（173,804 字节）；两项均落在 `composer-attachments/wechat-media-*`，权限 `600`，Tool 输出不存在 `data:image`/`data:audio`/`data:video`。重复测试文件已按精确路径清理。
- 验证通过：`npm run build`；`npm run typecheck`；微信媒体、微信 Tool、附件清理和 Host 定向测试 **140/140**。当前开发实例已重启并加载新构建。
- 证据边界：内置 `view_image` 仍会把图片字节以内联 data URL 写入 Codex 会话 JSONL，因此不能宣称完整会话历史已不含媒体；语音没有内置本地转写器，只有微信 `transcription` 可作为可靠文本。仅缩略图/完全缺失、断网、旧资源句柄失效、视频真实样本、WXGF、其他图片容器和 Windows 链路仍待独立验收。

## 2026-10-31 · CloakBrowser 官方 Logo 与连接应用推荐区

- 修复真实消息发送时的 `failed to load configuration: invalid transport in mcp_servers.cloakbrowser`：App Server 通过 `command` 或 `url` 判断 MCP transport，单独的 `{ enabled: false }` 会在 `thread/start` 前被拒绝。Host 现在为未安装、未授权和撤销后的 CloakBrowser 注入合法禁用配置：本机没有同名 Codex 配置时使用带回环 URL 的禁用占位；已有同名配置时只注入 `enabled: false`，保留其原 transport，避免 stdio 与 URL 合并冲突。
- 新增真实 `codex-app-server 0.165.0` 解析回归，同时覆盖“没有基础配置”和“已有同名 stdio 配置”两条路径；此前错误形状已在同版本二进制上稳定复现用户看到的 `invalid transport` 文本，而不是只依赖 FakeRuntime 断言。
- 验证通过：`npm run typecheck`；`npm run test:catalog:sync`；`npm run test:plan`；`npm run test:catalog`（157 条规则 / 277 个案例）；`npm run test:acceptance` **21/21**；`npm run build`；Host 后端 **123/123**；CloakBrowser 后端 **6/6**；连接应用 Electron **1/1**；`git diff --check`。
- CloakBrowser 卡片和连接弹窗使用其官方 GitHub 仓库 `CloakHQ/CloakBrowser` 的 `images/avatar.png` 图形，并已移除原始黑色方底；本地资源为透明背景 500×500 RGBA PNG，SHA-256 为 `1753262f7f96653fce12bbc04e0405095925683d7b44490f72b38c9383976135`。四角 Alpha 为 0，界面继续按 40×40 直接显示，不使用 `CB` 文字占位、Chrome 图标或 GitHub 平台 Logo。
- 连接应用首页“推荐”区调整为微信、Gmail、QQ 邮箱和 CloakBrowser 四项；日历与 GitHub 保留在“所有应用”。搜索和分类筛选仍按真实 Provider 结果显示。
- CloakBrowser 介绍改为“可让 Agent 自动化执行的浏览器，减少常见反爬机制对任务流程的干扰。”，连接弹窗继续明确不承诺绕过所有反爬、验证码、登录或二次验证。
- 真实 Electron 用例同时断言推荐区四张卡片、所有应用两张卡片、CloakBrowser 自然尺寸 500、四角透明与中心不透明、卡片和弹窗介绍文案、六项品牌 Logo 的透明无框容器，以及四个可连接按钮在明暗主题下的对比度。
- 验证通过：`npm run typecheck`；`npm run test:catalog`；`npm run test:acceptance` **21/21**；`npm run build`；连接市场 Electron **1/1**；CloakBrowser、Host、Runtime 与平台进程定向后端 **150/150**；`git diff --check`。验收目录为 **157 条规则 / 157 个完整场景 / 277 个局部案例 / 151 implemented / 126 gaps**。
- 证据边界：本轮只完成连接市场分组、官方 Logo 和定向 Electron 验收；真实 CloakBrowser 安装、共享登录态、完整微信向导 UI、安装版应用与 P02 逐项视觉对照仍未执行。

## 2026-10-30 · Q208 双平台发版 Skill 与独立 App Server 校验

- `rambo-release` Skill 从 macOS 单平台发布改为默认双平台：macOS ARM64 与 Windows x64 分别在匹配原生构建机执行 `npm run release:package -- <target>`，各自生成安装包、SHA-256 和 release metadata；两个平台合并后必须通过 `npm run release:verify -- darwin-arm64,win32-x64` 才能进入 tag/Release。
- 发布脚本现在直接验证包内 `runtime/codex/0.165.0`：只允许一个固定版本，核对 `codex-package.json`、`rambo-runtime.json`、官方归档 SHA-256、入口路径，并读取 Mach-O/PE 头确认真实架构。macOS ARM64 必须是 `aarch64-apple-darwin`/arm64，Windows x64 必须是 `x86_64-pc-windows-msvc`/x64。
- 修复 `scripts/prepare-runtime.mjs` 的一个现有缺口：复用旧运行时目录时原先可能只保留 `codex-package.json` 的目标信息，`rambo-runtime.json` 缺少 `target`；现在会补齐并校验，避免发版只靠外部 manifest 猜测平台。
- 新增 Windows NSIS 固定产物名 `Rambo-v<version>-Windows-<arch>.exe`，Windows CI 改为运行双平台发版脚本的 Windows 分支并上传 NSIS 与 release metadata。正式 README/Skill 仍明确 Windows CI 不等于 Windows 真机产品验收。
- 验证通过：`npm run typecheck`；发版工具后端测试 **3/3**；`npm run test:catalog`；`npm run package:mac`；使用现有 macOS 候选包执行 `package-release.mjs darwin-arm64 --skip-build`，实际确认包内 App Server 为 `0.165.0 / aarch64-apple-darwin / arm64` 并生成 zip、SHA-256 和 metadata；双平台校验在缺少 Windows 安装包时按预期失败并阻止发布。
- 证据边界：本机是 macOS ARM64，只实际构建并校验了 macOS 包；Windows NSIS 构建路径、PE x64 校验和双平台合并需要 Windows x64 构建机或 Windows CI 实际执行。当前没有 Windows 真机安装、启动、登录、Bot/Routine、托盘、音频、微信扫描或 NSIS 卸载证据，不能宣称 Windows 已完整可用。

## 2026-10-30 · Q207 来源切换统一刷新全局模型与失效 Bot

- `setModelSource`、ChatGPT 登录完成和 `setCodexHomeSyncMode('follow')` 现在复用同一套模型目录同步：读取当前来源的真实模型列表，自动选择一个有效默认模型，写回全局模型池，并把模型已失效的历史 Bot 统一切到该默认模型。覆盖手动 API → ChatGPT、ChatGPT 登录完成、手动 API → 持续跟随本机，以及切回手动 API。
- 独立配置中选择尚未登录的 ChatGPT 时，不再只剩“不可用”状态：来源选项可直接进入登录流程，当前来源卡也提供明确的“登录 ChatGPT”按钮；授权完成后自动同步全局模型池、默认模型和失效 Bot，并就地显示实际刷新结果。
- 修复旧数据或残缺手动 API 配置被误显示为“已配置”的问题：不再把一个未进入已保存模型池的 `manualModelId` 临时伪造成可用模型；空的手动模型目录会回退到当前来源的全局模型池，仍不完整时点击“手动配置 API”只打开配置表单，不再反复调用主进程并报错。
- 全局模型池、默认模型和失效 Bot 的模型更新在 Store 单一事务中提交；目录读取或运行时切换失败时恢复原来源和原运行时配置，不在失败后留下 API 模型池搭配本机运行时的半完成状态。
- 手动 API 已勾选模型池改为独立持久化，不再被本机/ChatGPT 目录覆盖；切回手动 API 时恢复原模型列表和默认模型。`ModelSourceState.models` 明确表示已保存的手动 API 模型池，当前来源目录继续由 `models()` 返回。
- 切换来源的常驻说明和结果反馈明确提示会真实统一刷新；结果包含新默认模型、全局模型数量和实际刷新的历史 Bot 数量/名称。ChatGPT 尚未登录时先完成来源切换，登录完成后自动执行同一目录同步。
- 验证通过：`npm run typecheck`；Model Source + Store 定向后端 **57/57**；`npx electron-vite build`；相关 Electron **4/4**，其中新增用例覆盖“独立 API → 选择 ChatGPT 登录 → 授权完成 → 全局默认模型与历史 Bot 统一刷新”，扩展用例继续覆盖 API → ChatGPT、API → 持续跟随本机及权限保持；`npm run test:catalog:sync`、`npm run test:plan`、`npm run test:catalog`、`npm run test:acceptance` **21/21**；`git diff --check`。
- 补充验证：Model Source + 账号设置定向后端 **14/14**，覆盖不存在已保存模型池时状态为不可切换、空手动目录回退 `defaultBotModels`；重建 Electron 后相关模型配置流程 **4/4** 通过。
- 证据边界：真实 Electron 使用隔离 profile、mock App Server 与本机 HTTP 模型目录夹具；未执行真实 ChatGPT 外部授权回调、真实第三方模型目录、安装版或完整 A09 旅程，不能据此宣称整条规则或发布验收通过。

## 2026-10-30 · P10 macOS/Windows 平台抽象与双平台基础兼容

- 新增 P10/Q206，明确最终产品 macOS 与 Windows 都完整可用，平台差异统一通过共享契约和主进程适配层处理；当前实际产品验收仍只在 macOS，Windows 真机与 ARM64 不能由源码、CI 或交叉编译推导通过。
- 新增 `src/shared/platform.ts` 与 `src/main/platform/{paths,fs,process,archive,runtime-target,desktop-shell}.ts`。统一处理路径大小写与包含判断、私有目录/文件 ACL、Windows 原子替换重试、命令和 `PATH`/`PATHEXT` 解析、`.cmd/.bat` 的 `cmd.exe` 转义、原生 `.exe` 直接启动、`taskkill.exe` 进程树终止、Windows 自带 `tar.exe`、四个运行时目标、窗口外壳、应用菜单和托盘模式。
- Windows 裸命令现在先从 `cwd`、`PATH`、`PATHEXT` 解析；`.cmd/.bat` 采用与 cross-spawn 一致的转义，`node_modules/.bin` shim 使用双层转义；`run_with_secret` 不再让 shell 拼接用户参数。子进程环境补齐 `USERPROFILE`、`HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`TMP`、`ComSpec` 和 `PATHEXT`。
- 归档安全校验同时拒绝 POSIX 绝对路径、Windows 绝对路径和盘符相对路径（如 `C:foo`）；`scripts/platform-target.mjs` 与运行时准备脚本共用相同判定。
- 登录启动、托盘、菜单、文件管理器文案、路径脱敏和微信连接器均接入平台抽象；微信继续遵守 Q201：macOS 使用受管副本重签，Windows 使用 `Weixin.exe` 内存扫描，平台不匹配直接失败。
- 验证通过：`npm run typecheck`；平台定向测试 **40/40**；微信/凭证/Bot 数据定向测试 **30/30**；Host **120/120**；`npm run build`；`npm run test:catalog`。GitHub `rust-v0.165.0` 的 darwin-arm64、darwin-x64、win32-x64、win32-arm64 四个运行时 SHA-256 与 `config/runtime-targets.json` 一致。
- 证据边界：当时 `.github/workflows/windows-build.yml` 只配置 Windows x64 类型检查、平台单测和 unpacked 打包；后续 Q208 已改为构建并上传带 Windows 专用 App Server 的 NSIS 候选，但仍未在 GitHub Actions 实际运行，也不包含 Windows 真机 UI、通知、登录启动、音频、微信或 NSIS 安装/卸载验收。Windows ARM64 脚本存在但未验证；不能把本轮写成 Windows 已完整可用。

## 2026-10-30 · Q207 模型区视觉整理与失效模型统一刷新

- 手动 API 的模型选择区改为全宽分区面板：标题与已选计数、获取按钮、候选标签、自定义模型输入、反馈状态和已选摘要分层展示；标签使用主题化圆形勾选，桌面、暗色和窄窗口不再挤在表单左半列。
- 保存新的手动 API 模型池前，界面会明确提示将统一刷新多少个历史 Bot、目标默认模型和 Bot 名称摘要，不使用“是否刷新”确认框。
- 保存成功后仅把模型已不在新池内的 Bot 切到新默认模型，包括归档 Bot；仍有效的 Bot、全部 Bot 权限及其他数据保持不变。Store 方法在单个事务内完成选择性刷新，主进程在来源配置与运行时切换成功后调用。
- 验证通过：`npm run typecheck`；Store 定向测试 **48/48**；`npx electron-vite build`；新增真实 Electron “保存新模型池会提示并自动统一刷新失效模型的历史 Bot” **1/1**；相关模型配置 Electron **3/3**；`npm run test:catalog:sync`、`npm run test:plan`、`npm run test:catalog`；`git diff --check`。验收目录为 **156 条规则 / 156 个完整场景 / 272 个局部案例 / 146 implemented / 126 gaps**。

## 2026-10-30 · Q205 模型标签多选与全局默认配置

- 独立配置来源收敛为“ChatGPT 登录 / 手动配置 API”；本机 Codex 配置副本只通过顶层“持续跟随本机”使用，切回持续跟随即可恢复本机配置，不再在独立配置内重复提供本机来源。
- 手动 API 表单不再单独填写模型 ID，只填写服务名称、Base URL 和 API Key。`/models` 返回结果先展示为候选模型标签；只有勾选标签才进入全局模型池，取消勾选会移出。接口失败或目录为空时，可通过输入框和“添加模型 ID”生成自定义标签，再勾选入池。
- 未勾选手动 API 模型时保存按钮禁用；全局默认模型只能从模型池中选择，后端同时校验默认模型属于已保存模型池。账号状态判定也要求默认模型存在于池内，避免旧数据或缺失模型被显示为可用来源。
- “新建 Bot 初值”统一改名为“全局默认配置”，展示模型池、默认模型和默认权限。新建 Bot 复制当时的默认模型与权限，已有 Bot 保持独立；手动 API 来源保存后，应用级 `models()` 直接返回持久化模型池，不再每次请求远端 `/models`。
- 验证通过：`npm run typecheck`；Model Source、账号设置与 Store 定向后端 **61/61**；`npm run test:catalog:sync`、`npm run test:plan`、`npm run test:catalog`；验收结构 **21/21**；`npx electron-vite build`；相关真实 Electron **5/5**，覆盖全局默认配置自动保存、模型配置 Tab 分层、手动 API 候选标签/自定义 ID/切回持续跟随、401 保留来源和全新用户内置运行时手动模型配置。验收目录为 **155 条规则 / 155 个完整场景 / 269 个局部案例 / 144 implemented / 125 gaps**。
- 证据边界：真实 Electron 使用隔离 profile 和本机 HTTP fixture，未使用真实第三方 API Key、真实供应商分页或非标准 `/models` 目录；未打包、未安装、未部署。完整 `npm run build` 仍受并行改动中的原生媒体脚本错误影响，本轮以 `npx electron-vite build` 验证 Electron 代码构建；`change-checks` 选中的 Host 全量测试当前也被并行平台文件拆分阻断在 `platform/process` 模块解析，失败发生在测试加载阶段，未用于本轮模型配置结论。

## 2026-10-30 · Q204 手动 API 模型目录与“模型配置”Tab

- 手动 API 的模型 ID 输入旁新增“获取模型列表”按钮，调用 `GET <Base URL>/models` 并携带 `Authorization: Bearer <API Key>`。新输入的 Key 优先；复用已保存 Key 时要求 Base URL 与已保存值一致，避免把旧 Key 发往新主机。结果按 OpenAI `data` 数组归一化、去重并限制数量，仍保留手动模型 ID 输入作为兼容路径。
- 手动 API 成为当前来源后，应用级 `models()` 同样读取该服务的 `/models`，不再调用 Codex `model/list`。保存来源和运行时重建后会刷新“新建 Bot 模型”选项，已有 Bot 的模型与权限不被改写。
- 系统设置移除独立“新建 Bot 初值”Tab，原“账号”Tab 更名为“模型配置”；同一页依次包含 Codex 运行时、配置模式、当前来源与连接测试、手动 API 配置、新建 Bot 初值。
- 验证通过：`npm run typecheck`；Model Source 定向测试 **6/6**；验收结构 **21/21**；`npm run build`；模型配置与手动 API 模型目录相关 Electron **3/3**；全新用户内置运行时、手动 API 拉取模型目录与更新 **2/2**；`git diff --check`。验收目录为 **155 条规则 / 155 个完整场景 / 269 个局部案例 / 144 implemented / 125 gaps**。证据边界：模型目录使用本机 HTTP fixture，尚未用真实第三方 API Key、真实供应商分页或非标准模型目录服务验收。

## 2026-10-30 · Q203 任务执行期间账号操作稳定禁用

- 账号页“测试连接”“登录 ChatGPT”等按钮闪动的直接原因是：按钮先进入局部 `busy`，主进程随后因活动任务拒绝，局部错误又被账号轮询覆盖或落到页面底部。现在由宿主统一计算 `hasPendingWork`，覆盖启动中/执行中的 turn、私聊与群聊派发、未确认操作和 Live 会话，并在 Snapshot 中暴露分项计数供界面稳定判断。
- 主进程对所有会改变运行时、来源、登录态或连接状态的入口使用同一门禁：更新 App Server、重启运行时、代理保存、切换到持续跟随、来源切换、ChatGPT 登录、手动 API 保存、连接测试和测试后的重启重试。绕过 UI 直接调用 IPC 同样会被拒绝。
- 账号页在存在未结束工作时提前禁用上述控件，并在运行时、配置模式、来源、登录和手动 API 区域持续显示就地原因；任务结束后按真实状态恢复。账号读取错误、配置错误和登录操作错误分开保存，账号轮询不再清掉登录反馈。
- 手动 API 保存改为原子流程：先统一校验宿主门禁，再持久化配置并重启运行时；任一步失败都会恢复原设置、来源和配置，不留下“凭证已保存但来源未切换”的半完成状态。
- 修复验收 App Server 夹具的重启恢复建模：持久化 thread/turn 历史，旧进程遗留的 `inProgress` 在进程重启时转为 `interrupted`，并补上真实 `startedAt`；`thread/turns/list` 按请求的 `sortDirection` 返回。这样恢复核对不会因旧→新顺序或缺失时间而永久锁住操作。
- 新增真实 Electron 用例覆盖任务执行中稳定禁用、就地原因、直接 IPC 拒绝、手动 API 状态不变、来源保持本机配置和任务结束恢复；前置用例会等待隐藏问候与活动 turn 闭环，避免把串行测试残留误判为产品状态。
- 验证通过：`node scripts/change-checks.mjs --run` 的 TypeScript、Host **119/119**、验收流程 **21/21**、构建和相关真实 Electron **51 passed / 1 skipped**；单独串行运行 `private-chat` 与 `runtime-startup` 为 **42 passed / 1 skipped**。验收目录为 **155 条规则 / 155 个完整场景 / 268 个局部案例 / 143 implemented / 125 gaps**。
- 证据边界：本轮使用隔离 profile、mock App Server 和真实 Electron UI 验证交互与主进程门禁；未重新执行真实 ChatGPT 外部登录回调、真实外部模型来源切换或安装版验收。跳过项仍是依赖外部真实模型行为的一次性 Routine smoke，不代表 A09 整条规则或全量发布完成。

## 2026-10-30 · Live 通话音量增益与限幅

- Live 远端音频不再只依赖 `HTMLAudioElement` 的默认 `1.0` 音量。通话开始时创建交互式 Web Audio 播放上下文，远端音轨经 `2.0` 固定增益（约 `+6.0 dB`）和动态压缩限幅后送到 macOS 当前输出设备，避免简单放大造成持续削波。
- 输入麦克风的回声消除、降噪和 AGC 不变，其他提示音也不受影响；系统输出音量和设备选择仍是最终响度边界。Web Audio 无法启动时回退到当前媒体元素直接播放，结束时统一断开播放源、关闭上下文并释放回退元素。
- 新增播放链单元测试，核对远端流、增益、限幅参数和 `source → gain → limiter → destination` 顺序；V14 同步补充真实通话听感、系统音量控制、设备断开与合盖验收条件。
- 证据边界：本轮只有播放图构建和参数测试，尚未用真实账号、耳机/扬声器完成 Live 听感、最大系统音量、长时间通话破音和设备切换验证，不能宣称 V14 整条规则通过。

## 2026-10-30 · Q201 微信连接按平台分流

- 用户最终确认“Windows 就走 Windows 那套，苹果就走重签这套”。微信连接器已拆成平台 facade、macOS 受管副本重签适配器、Windows 进程内存扫描适配器和公共 SQLCipher 数据库校验；`options.backend` 与当前系统不匹配时直接失败，不做跨平台兜底。
- macOS 生产路径固定为创建临时微信副本、保留原 entitlements 并加入 `get-task-allow` 后重签，再通过一次管理员授权启动副本和 Frida `CCCrypt` 捕获每个数据库的 raw AES key。密钥只在内存中匹配，验证完成后清理临时副本并恢复原微信；旧重签路径保留为正式 macOS 路径。
- Windows 不复制、不重签、不修改微信。新增 Rust 扫描器枚举 `Weixin.exe`，仅读取已提交且可读写页面，按 2 MB 分块并保留 99 字节重叠，扫描 `x'<64位hex key><32位hex salt>'`；TypeScript 侧优先按 salt 匹配，再用数据库首页 HMAC 验证 raw key。账号根目录支持 `%APPDATA%\Tencent\xwechat\config\*.ini` 中的 `MyDocument:` 或绝对路径；用户在选择器中返回账号目录、`db_storage` 或其子目录时，会向上归一化到同一个 `xwechat_files` 账号根。
- 当前验证通过：`tsc --noEmit`；微信连接器定向测试 `17/17`（含 Windows 多账号 `db_storage` 选择、超时解析和完整 capture 超时诊断）；微信相关后端合并测试 `214/214`；验收结构测试 `21/21`；Windows 扫描器 Rust 单元测试 `3/3`；`x86_64-pc-windows-msvc` 交叉 `cargo check`；`git diff --check`。Windows 扫描器尚无真实 Windows 微信环境，macOS 受管副本真实读取仍需按当前微信版本复验。
- 证据边界：Windows 源码接入、交叉编译检查和合成 SQLCipher 夹具不等于 Windows 真机可用；PC 协议发送、服务器接受、消息入库与收件人送达均未验证。

## 2026-10-29 · ChatGPT 登录空提示与完成态同步修复

- 干净环境中点击“登录 ChatGPT”后只出现“登录流程已启动，完成后重新打开此页面”的直接原因有两层：旧验收运行时对 `account/login/start` 返回空对象，Rambo 又把空结果当成成功；同时登录完成后的账号状态只更新了设置页局部，顶层侧栏仍保留“配置 Codex”。
- Host 现在要求 App Server 返回有效 HTTPS `authUrl`，否则明确提示“没有返回有效的 ChatGPT 登录地址，请重试或先更新 App Server”，不再显示虚假成功。主进程打开系统浏览器失败时仍把 URL 返回 renderer，账号页继续保留“重新打开登录页面”链接，而不是把登录状态一并丢掉。
- 登录后会显示“等待授权…”，每 1.5 秒读取一次账号，最多等待 10 分钟；授权完成后自动刷新账号卡、来源状态和侧栏主入口。账号读取增加代次校验，较早请求的旧结果不能覆盖较新的登录成功状态。
- 真实内置 `0.165.0` 在一次性空 Codex Home 中直接调用 RPC，确认返回 ChatGPT 类型、`loginId` 和 `https://auth.openai.com/...` 登录地址；未在诊断输出中保存完整一次性 URL。Host 回归覆盖有效 URL 与缺失 URL；真实 Electron 回归覆盖可重开链接、等待态、模拟授权完成、账号卡自动更新和侧栏切换到“创建 Bot”。
- 最终发布验证：`node scripts/change-checks.mjs --run` 通过 TypeScript、相关后端 **201/201**、验收流程 **21/21**、Electron 构建和相关真实 Electron **53 passed / 1 skipped**；`npm run verify:fast` 通过类型检查、后端 **372/372**、验收流程 **21/21** 和台账 **18/18**，目录为 **155 条规则 / 267 个案例 / 142 implemented / 125 gaps**。唯一跳过项仍是依赖外部真实模型行为的一次性 Routine。
- `v0.1.8` 候选应用约 **757M**，Bundle ID 为 `local.rambo.desktop`，内置 `codex-app-server 0.165.0`，ad-hoc 签名且 `codesign --verify --deep --strict` 通过，`spctl` 按未公证应用预期拒绝；候选资源测试 **1/1**、打包版 Electron **3/3** 通过，其中直接点击候选包登录入口得到真实 `auth.openai.com` 可重开地址。新增干净登录测试 Skill 已在最终候选包上真实执行 `start`、`status` 和 `cleanup`，确认版本 `0.1.8`、内置运行时 `0.165.0` 并清理隔离环境。
- Release zip 为 `Rambo-v0.1.8-macOS-arm64.zip`，大小 **293381374** 字节，SHA-256 为 `9974f4a14d220a127cddda3bbcd3b1aa1406feddaa97144d72c9daef2268df72`。同一构建已安装到 `/Applications/Rambo.app`，复核版本 `0.1.8`、Bundle ID `local.rambo.desktop` 和 ad-hoc 签名一致；应用数据目录未清理或覆盖。
- 证据边界：Electron 用例使用本机验收 App Server 夹具模拟授权完成，尚未在真实外部浏览器完成 `auth.openai.com` 登录回调，也未在安装版单独制造系统浏览器打开失败或执行真实模型回合；“重新打开登录页面”依赖 Electron 既有外链处理。以上是本次针对性发布证据，不代表 P08 全量验收通过。

## 2026-10-29 · Q199 App Server 内置与独立手动更新

- Rambo 安装包现在内置官方 macOS ARM64 `codex-app-server` `0.165.0`，固定归档 SHA-256 为 `db80061560c75c440efe11d347f5bebcf78aa895b40e38ca47623d8a37b41cd7`；`package:mac` 会先运行 `runtime:prepare`，再把 `runtime/codex` 复制到应用 `Contents/Resources`，最后通过 `scripts/sign-mac.mjs` 对候选应用执行 ad-hoc 重签和严格校验。干净安装直接使用内置版本，不再在首次启动时下载。
- App Server 与 Rambo 版本生命周期解耦：用户通过“账号 → Codex 运行时 → 更新 App Server”手动检查官方最新发布并安装到 `<userData>/runtime/codex/<version>`，目录带 `updateChannel: "manual"`；后续应用包即使带更高内置基线也不自动覆盖该用户选择。只有用户再次点击更新才切换。
- 更新按钮显示真实字节进度；下载后校验 SHA-256、归档路径、manifest、入口和可执行权限，然后重启 App Server 并完成 `initialize`。有执行中任务时拒绝更新，下载完成到重启前再次检查任务；更新失败保留原运行时，不清理任务、排队项、Routine 或用户数据。
- 已重新执行 `npm run package:mac`，生成约 **757M** 的 `dist/mac-arm64/Rambo.app`；Bundle ID 为 `local.rambo.desktop`，包内仅保留 `runtime/codex/0.165.0`，入口为 arm64 Mach-O。`codesign --verify --deep --strict` 通过，签名为 ad-hoc；候选包资源测试 **1/1**，打包版真实 Electron **2/2**，确认空配置首次启动直接连接内置运行时且不再显示下载步骤。
- 独立更新真实 Electron 用例 **3/3**：新用户从内置 `0.165.0` 点击“更新 App Server”，经慢速本机 HTTP 归档显示真实进度并切换到单独安装的 `0.166.0`；运行时来源显示“单独更新”，侧栏在模型仍未配置时继续引导“配置 Codex”。同时通过 Runtime 定向单测 **12/12**、相关后端 **200/200**、`npm run typecheck`、验收结构 **21/21**、目录 **155 条规则 / 155 个完整场景 / 265 个局部案例** 和 `git diff --check`。
- 已直接核对 GitHub Releases API：当前 `releases/latest` 为 `rust-v0.165.0`，macOS ARM64 App Server 资产名、SHA-256 和下载地址与固定基线一致。证据边界：更新按钮流程仍使用本机夹具归档，未通过安装版按钮完成真实 GitHub 更新；真实模型回合、Voice/Computer Use 同版本组件、应用升级后保留手动版本的真实安装旅程和最终发布验收尚未完成。

## 2026-10-29 · Q198 侧栏空态引导与顶部创建入口

- 侧栏只有没有任何可见 Bot/群聊会话时显示独立空态引导：未配置时引导“配置 Codex”，配置与来源就绪时引导创建第一个 Bot；引导不再作为常驻会话行，也不常驻挤占已有会话列表。
- 已有可见会话时，空态引导隐藏，“创建 Bot”恢复为顶部工具栏“+”入口；配置尚未就绪时该入口仍打开账号配置页，不进入无法完成的创建流程。
- 空态改为品牌头像、状态徽标、说明和轻量胶囊操作组成的准备面板；紧凑侧栏保留可点击图标与无障碍名称。真实 Electron 已验证创建首条 Bot 后入口在同一状态更新中迁移到顶部、已有会话重启后仍保留顶部入口，且不重复显示。
- 连接测试重试时不再先清空已有结果，按钮文案保持“测试连接”并以行内进度提示真实测试中状态；真实 Electron 已验证测试期间结果仍在、可访问名称不变、按钮宽度和来源卡高度不变化，避免快速完成时文字和结果区域连续闪动。

## 2026-10-29 · Q197 配置模式与模型来源分层

- 账号页改为固定顺序：“Codex 运行时（状态、下载、Home、代理）→ 当前配置模式 → 当前模型来源卡 → 来源卡底部连接测试”。顶层模式只有“持续跟随本机 / 独立配置”；没有检测到本机 Codex 时，持续跟随入口保留但禁用，有效模式自动落到独立配置。
- 持续跟随只使用本机 Codex 配置副本，并隐藏独立来源选择、手动 API 表单和旧通用账号卡。独立配置内才出现本机副本、ChatGPT 登录和手动 API 三个来源；任一来源可用时只显示当前来源卡和“更换配置”，全部不可用时才显示“登录 ChatGPT / 配置 API”。
- 账号身份绑定当前来源：ChatGPT 登录作为当前来源时显示账号状态，本机副本仅在检测到可用登录态时显示，手动 API 不展示 ChatGPT 账号卡。手动 API 保存后直接成为当前来源并收起表单；连接测试只作用于当前来源，失败保留来源且不自动切换。
- Host 的本机/ChatGPT 连接测试使用隔离、只读、ephemeral、无 Skills/MCP 的临时 turn，并支持超时参数；测试完成、失败、超时和 turn 不匹配都会清理临时 thread。三个来源统一使用最小真实请求测连通性。
- 当前验证：`npm run typecheck`；定向账号/模型/运行时/Host 后端 **134/134**；变更门禁相关后端 **200/200**；`npm run test:catalog:sync`、`npm run test:plan`、`npm run test:catalog` 和验收流程 **19/19**；真实 Electron `runtime-startup`、`private-chat`、`group-chat`、`avatar-picker`、`media-preview` 合并 **49 passed / 1 skipped**；`git diff --check`。验收目录为 **155 条规则 / 155 个完整场景 / 265 个局部案例**，新增 `A09-ACCOUNT-SETTINGS-01` 覆盖账号页真实 Electron 分层。
- 证据边界：全新用户下载使用本机慢速 mock 归档和真实 Electron UI，不访问真实 GitHub；真实 ChatGPT 登录回调、真实本机/ChatGPT 模型回合、已有 Bot/群聊/Routine 跨来源切换、执行中切换失败回滚和安装版仍未完整验收。跳过的 Electron 用例是依赖外部真实模型行为的一次性 Routine smoke，不能据此宣称 A09 或全量发布通过。

## 2026-10-29 · Q196 独立运行时与 Codex Home 复制

- Rambo 运行时已与安装包和本机 Codex 切割：只解析 Rambo 自己的缓存、包内资源或经校验下载的官方 `codex-app-server` 包，入口必须由 manifest 指向 `bin/codex-app-server`；启动固定使用 `--listen stdio:// --session-source app-server`，不再使用本机 `bin/codex` 或 daemon。
- 新增 `RuntimeHomeManager`：独立 `codex-home`，白名单复制 `config.toml`、文件 `auth.json`、`skills`、`plugins`、`rules`、`AGENTS.md`、`managed_config.toml`、`mcp-auth.json`，不复制会话、归档、SQLite 状态库、日志和缓存；持续跟随只单向从本机复制到 Rambo，支持“保持独立”、去抖、原子替换、失败保留旧副本和 owned thread 迁移。
- 账号页已接入运行时状态、真实下载进度、Codex Home 只读路径、本机 Codex 检测、持续跟随/保持独立、最近同步和错误提示；代理仍在“账号 → Codex 运行时”内，填写后自动保存，没有“保存代理”按钮。账号状态按来源展示：ChatGPT 登录始终显示；本机配置副本只有检测到登录态时显示；手动 API 不显示 ChatGPT 账号状态。
- 修复本机 Codex 后出现时可能覆盖 Rambo 独立配置的边界：若 Rambo 先形成独立登录/配置、尚无首次同步记录，本机 Codex 随后出现时自动切为“保持独立”、标记需要用户选择并保持 pending，只有明确选择“持续跟随本机”后才复制。
- 手动 API 的非敏感配置现在写入 Rambo 自己的 `codex-home/config.toml`：顶层 `model` 使用填写的模型 ID，并维护 `model_provider` 和 `[model_providers.rambo_manual]`；写入前保留基础配置副本，切回本机配置时恢复。原本没有 `config.toml` 时记录“原文件不存在”并在切回时删除临时配置，不留下空文件或空备份。API Key 仍只保存在加密凭证库并通过 `RAMBO_MANUAL_API_KEY` 注入子进程；ChatGPT 登录或手动 API 生效时禁止“持续跟随本机”，避免下一次同步覆盖独立配置。
- 账号页只在当前来源真实可用时标记“当前生效”；本机配置副本尚无可用登录态时标记“尚未可用”，不把空配置伪装成已生效。模型来源切换现在先检查活动轮次，再修改同步模式和来源；失败时同时恢复原来源与持续跟随模式。
- 当前定向验证：`npm run typecheck`；Runtime/RuntimeHome/ModelSource/CodexConfig 合并测试 **27/27**；`npm run build`；`runtime-startup` 真实隔离 Electron **3/3**；账号设置与手动 API 成功/401 真实 Electron **3/3**；验收流程 **19/19**；`git diff --check`。全新用户用例使用本机慢速 HTTP mock 归档，验证下载进度、SHA-256 校验、解包、启动，以及下载完成后的 ChatGPT 登录入口、手动 API 保存/连接测试/启用/切回；未访问真实 GitHub。
- 本轮收口回归：`private-chat` 真实 Electron **37 passed / 1 skipped**、`group-chat` **6/6**、`avatar-picker` **2/2**、`media-preview` **1/1**、`runtime-startup` **3/3**；变更门禁 `npm run typecheck`、相关后端 **193/193**、验收目录与流程 **19/19** 均通过。一次性 Routine 清理用例补齐第三次来源私聊 turn 交接，头像等待动画修复后连续运行稳定；`private-chat` 跳过项仍是依赖外部真实模型行为的 Routine smoke。
- 验收目录已同步为 **155 条规则 / 155 个完整场景 / 264 个局部案例**，并新增 `A03-RUNTIME-HOME-01` 覆盖“本机 Codex 后出现不静默覆盖”、`A09-CODEX-CONFIG-01` 覆盖手动 API 文件写回与无原文件清理。证据边界：真实 GitHub 下载、真实 ChatGPT 登录回调、真实手动 API 完整模型对话、执行中来源切换的 Electron 回滚、Voice 独立组件、Computer Use 分发和安装版仍待验证。

## 2026-10-29 · Q195 新安装侧栏主入口按 Codex 配置状态切换

- 左侧栏会话列表上方新增唯一主入口：运行时、模型初值或当前模型来源所需账号/API 配置未完成时显示“配置 Codex”，点击打开系统设置“账号”Tab；账号检查期间显示“正在检查配置”；配置完成后切换为“创建 Bot”，点击打开现有创建 Bot 弹窗。
- 运行时下载完成、账号登录态读取、模型来源切换和运行时重启后会重新读取账号状态；手动 API 以已保存的 Base URL、模型 ID 和加密 API Key 判定为可用，不要求 ChatGPT 登录。
- 顶部原有“创建 Bot”快捷按钮由该主入口取代，避免未配置时仍能直接打开创建弹窗；窄侧栏保留图标和无障碍名称，会话列表、搜索、新建群聊及设置入口不变。
- 验证使用真实 Electron UI 和本地 mock 运行时归档，不触发真实 GitHub 下载。覆盖未配置/下载中/下载完成后“配置 Codex”、已有本机登录时“创建 Bot”、配置入口定位账号页和窄侧栏可操作性。
- 验证边界：真实 ChatGPT 登录回调、真实手动 API 对话完成后的入口切换、真实 GitHub 下载、四种 profile 组合和安装版视觉仍未完成，不能据此宣称 A08 整条规则通过。

## 2026-10-29 · Q193/Q194 运行时移入账号、代理自动保存与平滑下载进度

- “Codex 运行时”完整区块从“常规”迁入“账号”，顺序为运行时、账号状态、模型来源、手动 API 和连接测试；“常规”只保留登录时启动与共享“关于我”。未配置运行时的首次启动自动定位改为“账号 → Codex 运行时”。
- 代理地址移除“保存代理”按钮，改为停止输入 650ms、离开输入框或回车后自动保存；清空同样自动保存。保存期间显示等待、进行中、完成或失败状态，原有格式校验、执行中拒绝、运行时重启和失败回滚边界不变。
- 下载进度改用主题化填充层和 `transform: scaleX()`，真实字节更新每约 100ms 一次，视觉过渡为 180ms；无总大小时使用不定量动画，`prefers-reduced-motion` 下停用动画。仍以真实已下载字节和百分比为数据源。
- 验收模式增加离线保护：`RAMBO_ACCEPTANCE_RUN` 未显式提供本地归档 URL 时禁止隐式回退 GitHub 下载。运行时 UI 用例使用本机临时 HTTP mock 归档，不触发真实网络下载。
- 当前定向验证：`npm run typecheck`；Runtime 后端 **13/13**；`npm run build`；`runtime-startup` 真实 Electron **3/3**；账号/常规分工及运行时重建相关真实 Electron **3/3**；验收目录 **155 条规则 / 155 个完整场景 / 262 个局部案例**；验收结构 **19/19**。证据边界：真实 GitHub 下载、真实 ChatGPT 登录回调、真实手动 API 对话、安装版真实代理对话和完整 A02/A03/A07/A08/A09 仍未验证；本轮下载验收明确是 mock 来源、真实 Electron UI。

## 2026-10-29 · Q192 全新用户运行时下载与账号配置

- 用户确认全新用户场景：没有 App Server 时先下载并显示真实进度；下载完成后可选择 ChatGPT 登录或手动 API Key。规则已写入 Q192、A02/A03/A08 与验收矩阵；Q196 后续把“已有 App Server 时直接复用登录态”修订为复制到 Rambo 独立 Codex Home。
- Runtime 状态新增下载阶段、已下载字节和可选总字节。真实下载每约 100ms 及完成时更新状态；设置页显示原生进度条、百分比和文件大小，缺少 `Content-Length` 时显示不定量进度与已下载量，完成后清除进度并进入 App Server 初始化。
- 验收模式新增仅由 `RAMBO_ACCEPTANCE_RUN` 启用的本地归档 URL/SHA-256 覆盖，真实 Electron 用例通过慢速本机 HTTP 下载、SHA-256 校验、解包和夹具 App Server 启动验证整条链路，不依赖 GitHub 网络。
- 全新用户 Electron 用例验证：无欢迎页、当时自动进入常规设置（后续 Q193 已改为账号）、下载进度可见、运行时就绪、账号页显示“登录 ChatGPT”和“手动配置 API”并可展开 Key 表单。已有本机 Codex Home 的真实 Electron 用例验证白名单 `auth.json` 副本和无需重登；手动 API 保存、加密凭证与 Responses fixture 测试继续覆盖 Key 路径。
- 当前定向验证：`npm run typecheck`；Runtime 后端 **12/12**；相关真实 Electron（本机运行时复用、未配置首次启动、全新用户下载、手动 API）**4/4**；验收目录同步为 **155 条规则 / 155 个完整场景 / 262 个局部案例**。证据边界：尚未用真实 GitHub 下载、真实 ChatGPT 登录回调、真实手动 API 对话或安装版完成该首次旅程，不能据此宣称 A02/A03/A08/A09 整条规则或全量发布通过。

## 2026-10-27 · 账号设置、模型来源与首次启动入口

- 系统设置拆出独立“账号”Tab，集中承载账号状态、ChatGPT 登录、模型来源和连接测试；当时常规继续保留启动、关于我和 Codex 运行时（后续 Q193 已将运行时移入账号）。账号 Tab 提供“本机 Codex 配置 / ChatGPT 登录 / 手动配置 API”三选一，并明确同一时间只有一个应用级来源生效，不静默改写已有 Bot 的模型与权限。
- 手动 API 支持服务名称、Base URL、模型 ID 和 API Key。API Key 写入现有应用本地 AES-256-GCM 凭证库，不进入 Snapshot、设置快照、日志或 React 持久状态；Codex 子进程使用独立 `rambo_manual` Responses provider。非敏感 provider 配置写入 Rambo 自己的 `codex-home/config.toml`，API Key 只经子进程环境注入，不修改原生 `~/.codex/config.toml`；后续 Q196 已把配置副本和持续跟随边界补齐。
- 连接测试发送真实最小 `POST <Base URL>/responses` 请求并显示首响应延迟；保存并测试成功不会自动启用来源，需用户再点击“切换为当前来源”。HTTP 401、超时或无效配置显示失败，不提供启用入口；切换运行时失败会恢复原来源。
- 账号在线状态读取超时时，如果本机 `auth.json` 仍有认证，界面显示“检测到本机登录 / 本机认证存在，在线状态暂不可用”并保留原始错误，不把在线超时误报成未登录，也不在完全无本机认证时虚构成功。
- 未新增欢迎页、首次使用向导或独立首次配置路由。当时隔离 Electron 验证：未配置运行时首次启动自动进入“常规 → Codex 运行时”，点击返回后 reload 不重复弹出；一次性状态通过 `initialSetupPrompted` 持久化（后续 Q193 已将定位改为“账号 → Codex 运行时”）。四种配置组合、真正重启应用后的触发边界、其他入口的“去配置”提示和安装版仍待验收。
- 本轮最新定向验证：`npm run typecheck`；`runtime-startup` 真实 Electron **2/2**；账号 Tab、手动 API 成功与 HTTP 401 三条真实 Electron 用例 **3/3**；后端相关目标 **197/197**；`npm run test:catalog` **148 条规则、148 个完整场景、233 个局部案例**；`npm run test:acceptance` **19/19**；`git diff --check`。隔离窗口视觉复核确认常规/账号分工正确、760px 下 Tab 与三选一没有重叠或横向溢出。
- 证据边界：手动 API 的 Save/Test 与加密凭证已有隔离 Responses fixture 证据；`local` 和 `chatgpt` 的独立副本/登录态及两路真实模型回合尚未验证（后续 Q196 已取消共享登录态）。未承诺第三方 API 完整支持 Tool Calls、reasoning、MCP 或全部 Codex 能力；已有 Bot、群聊、Routine 在切换来源后的真实运行、失败运行时回滚和安装版均未完成完整验收，因此不能宣称 A09 或全量发布已通过。

## 2026-10-27 · Q168 会话置顶与 Q169 聊天时间显示

- 用户最终撤回 Google/Grok 的拖拽手势，改为只通过右键菜单“置顶/取消置顶”；顶部投放区和会话行拖拽置顶均已移除，不提供任意位置自由排序。侧栏统一混排；置顶项优先，多个置顶按最近置顶时间倒序，其余按创建时间倒序，不再因最后消息或聊天更新时间重排。
- 右键置顶使用持久化状态；侧栏通过整行微底色和左侧细强调线区分置顶项，不使用 pin 图标。归档不隐式清除置顶，恢复后继续按保存状态排序。
- Store schema 升至 25，为 `bots` 与 `group_chats` 增加 `pinnedAt`，并补齐旧数据库迁移。无默认 Bot 的旧群聊表重建也保留新旧 `pinnedAt`，避免升级时静默丢失置顶。
- 聊天气泡新增悬停时间：默认不可见、绝对定位，不改变气泡尺寸；首条消息、跨自然日、同一自然日间隔达到 15 分钟时插入居中轻量时间分隔。
- 当前定向验证：`npm run typecheck`；后端合并测试 **147/147**；验收结构 **19/19**；真实 Electron 右键置顶/重启持久化、顶部投放区不存在、气泡悬停与关键时间分隔组合回归 **3/3**；群聊成员阶段覆盖定向 **1/1**。
- 无图标置顶样式调整后，再次运行 `npm run typecheck` 与真实 Electron 右键菜单、置顶排序/取消、重启持久化 **2/2**；断言置顶行存在 `data-pinned="true"` 且名称区没有 SVG 图标。
- 完整私聊+群聊文件串行回归未跑完：前序用例累积后曾出现“群聊上翻后阶段迁移”滚动偏移和“系统设置保存新建 Bot 初值”模型选项时序失败。两条单独重跑通过，相关 6 条组合回归随后 **6/6** 通过；但完整文件仍受跨用例状态影响，不能登记为全量通过。证据边界：上述结果证明本批数据、排序纯函数和定向真实交互，不替代 B07/G13/S01 的完整视觉验收、完整回归或真实安装版长聊天复验。

## 2026-10-27 · Q166 恢复阶段气泡并修复新消息后的位置

- 用户推翻 Q165 的运行行阶段文字方案，恢复同一轮 `commentary` / `partial_answer` 与 `final_answer` 复用同一聊天气泡并覆盖旧内容；运行行只显示真实活动。
- 新问题修复：第二条用户消息到达后不提前建空气泡；下一条阶段或最终回复真正到达时，如果旧阶段气泡位于最新用户消息之前，先删除旧气泡，再在最新消息下方新建并继续覆盖。群聊按成员与成员轮次隔离并复用同一规则。
- 用户原本跟随最新消息时，迁移后继续显示最新内容；用户已上翻时不强制拉回底部。停止、失败或断开时只更新仍位于最新用户消息之后的阶段状态，旧位置气泡保持原样。
- 群聊上翻保护增加高度补偿：删除视口上方旧阶段气泡时按高度差修正 `scrollTop`，避免浏览器高度夹紧造成视觉跳底。
- 恢复 `StageAwareMessageContent` 与约 160ms 阶段切换动画；删除 `stageText` / `stageCleared` 瞬态协议与渲染缓存。后端测试已覆盖同轮覆盖、流式增量、steer 后迁移、群聊隔离和断开状态。
- 当前验证：`npm run typecheck`、`npm run build`、验收结构 **19/19**、后端 Store/Host **141/141**、私聊与群聊真实 Electron **35 通过 / 1 跳过**；滚动迁移定向连续 **3/3**。跳过项为依赖外部真实模型的 Routine 用例，未计入通过。
- 证据边界：以上覆盖本轮阶段气泡迁移、滚动位置和运行行活动展示，不替代 B11/G12/S01 的完整规则验收或全量发布验收；正式 App 替换结果在交付时另行核对。

## 2026-10-27 · Q165 阶段性回复改为运行行临时文字（已被 Q166 取代）

- 私聊与群聊的 `commentary` / `partial_answer` 不再写入 `messages` 或 `group_messages`，只作为当前运行行的瞬态文字。私聊显示阶段原文，群聊显示最近更新成员的“Bot 名称 · 阶段文字”；多个成员并行时不拼接长文本。
- 运行行不再让阶段文字永久压住后续活动：阶段文字与“正在思考/正在搜索网页/正在运行命令/正在调用工具”等真实活动按最新更新时间交替展示；阶段先于 `activeTurns` 同步到达时仍可显示，但下一轮会排除上一轮 stage。
- 运行行沿用既有扫光动画，文字保持单行，超宽以省略号截断。只有 `final_answer` 或兼容的无 phase 助手完成消息持久化为正式聊天回复；最终回复开始流式输出时即清除阶段文字。停止、失败、断开或整轮结束时清除阶段状态，不再补造“已停止/未完成”阶段气泡；运行时断开同步通知渲染层删除瞬态缓存。
- 删除原先按 `turnId` / `itemId` 复用气泡的 `StageAwareMessageContent` 与约 160ms 阶段切换动画。群聊阶段缓存额外绑定成员当前活跃 turn，避免下一轮开始时短暂显示上一轮旧阶段。
- 该项目当时更新了 Q165、P02/B11/G12/S01、验收矩阵、规则计划、目录与 UI 基准；定向验证为 `npm run typecheck`、Host **101/101**、目录同步/校验/验收结构 **19/19**、真实 Electron **2/2**。该行为随后由 Q166 取代，历史结果只保留，不作为当前版本通过依据。

## 2026-10-27 · Electron 用例窗口隔离

- 用户截图中的三个输入框和重复侧栏不是单页面 DOM 错排，而是多个 Electron 验收窗口以小幅偏移叠在同一位置；截图尺寸正好是单个 `1100×760` 窗口的 2x 捕获。生产页面仍只有一个聊天输入框，选中的 Bot 为 Routine Smoke。
- Playwright 配置现在在测试命令启动时获取跨进程验收锁，第二个并发命令会在创建窗口前明确失败；同一命令内的配置加载和 worker 不重复抢占。夹具同时记录 PID，可回收已退出进程留下的陈旧锁，并在每次 Electron 启动时断言只有一个 `BrowserWindow`。
- 验证通过：验收锁单测 **3/3**、类型检查、目录结构、以及 `private-chat` 确定性串联回归 **7/7**。已用两个并发 Playwright 命令复现第二个命令被锁拒绝且未开窗。
- 证据边界：目录漂移已由 F05/F06/F07 的案例迁移和新增补齐，`npm run test:catalog` 为 **146 条规则、231 个案例、114 个可执行案例**，`npm run test:acceptance` 为 **19/19**。真实模型 Routine 用例本次仍因回合未结束跳过，不能据此判定该规则通过。

## 2026-10-28 · F07 输入框附件区与剪贴板图片粘贴

- 拖入、文件选择和粘贴图片现在进入独立附件区；图片显示经受限 `rambo-asset` 授权读取的缩略图，普通文件显示名称与绝对路径，同一路径去重并可单独移除。草稿正文不再因附件被插入路径。
- 发送时正文在前，附件绝对路径按添加顺序逐行在后；无正文时可只发送路径。成功清空正文和附件，失败恢复。剪贴板图片若没有原文件路径，写入 `<userData>/composer-attachments` 的应用管理临时文件并发送其绝对路径，不创建 F01/F02 附件、长期资料或副本库记录。
- 粘贴逻辑按 Grok Bot 0.77.0 静态代码的优先级实现：先处理剪贴板文件，再识别 `text/plain` 中的图片 data URL，普通文字粘贴仍由 textarea 默认处理。证据与边界记录在 `docs/ui-baseline.md` 和 `reference/grok-ui/0.77.0/`。
- 粘贴临时图片新增清理机制：仅处理 `<userData>/composer-attachments` 下应用生成的 `pasted-image-*` 栅格图片，不跟随符号链接。未被 `messages.text` 或 `group_messages.text` 引用时生成 7 天后删除，已引用时生成 30 天后删除；当前 Composer 草稿通过 IPC 上报占用并跳过，移除附件或切换聊天后释放。主进程启动时执行一次，之后每 24 小时用 Node.js `setInterval` 检查；退出或睡眠期间不运行，下次启动补做。删除后历史消息路径保留但图片可能失效。
- 验证通过：类型检查；附件共享逻辑与清理模块单测 **5/5**；Store 全套 **43/43**（含私聊和群聊引用判断）；构建；隔离 Electron 的拖入附件、剪贴板 PNG、普通文字粘贴、文件选择、群聊附件与禁用态、发送失败恢复、引用保留、草稿移除、聊天切换和重启启动清理定向用例 **5/5**；验收目录 **148 条规则、237 个案例、118 个已实现案例**，结构测试 **19/19**。发送成功后的真实用户消息已回读，普通文字粘贴使用系统剪贴板实际触发；发送失败用例确认超长正文被拒绝后，原始正文（含首尾空白）和附件均恢复。
- 证据边界：尚未完成真实 Finder 菜单拖放和文件面板人工操作、跨真实自然日等待，以及 F01/F02 附件目录的全量差异；不能据此判定 F07 整条规则或完整产品验收通过。

## 2026-10-27 · F07 本机附件拖入或选择只插入路径

- 聊天输入框接收 Finder 文件拖入，或通过回形针入口打开本机文件选择器多选文件后，只在当前草稿的光标或选区插入原文件绝对路径；多文件逐行、重复路径去重，不自动发送。
- 该入口不上传、不复制、不读取文件内容，也不创建附件记录；附件、长期资料和副本仍按 F01/F02 的独立上载流程处理。
- 隔离 Electron 已用真实拖放事件和替换的系统文件选择器验证双文件路径、拖入高亮、光标插入、空草稿、去重、取消/失败不改草稿、群聊、禁用态和原文件字节不变；真实 Finder 拖放/文件面板、重启回读与附件目录全量差异仍待完整验收。
- 准备将本批改动构建为 `v0.1.5` 并替换本机 `/Applications/Rambo.app`；未创建 Git 提交、tag 或 GitHub Release。

## 2026-10-26：Gmail IMAP 本地化文件夹兼容修复

- 真实 Gmail 账号登录和 SMTP 验证成功，但 `mail_search` 报 `Command failed`。只读诊断确认账号把系统文件夹显示为 `[Gmail]/所有邮件` 与 `[Gmail]/草稿`，而 Adapter 写死英文 `[Gmail]/All Mail` / `[Gmail]/Drafts`，实际服务器返回 `[NONEXISTENT] Unknown Mailbox`。
- Gmail Adapter 现通过 IMAP `LIST` 的 `\All` / `\Drafts` 特殊用途解析邮箱路径，并仅在服务器未声明特殊用途时回退到英文默认路径；搜索、正文读取、附件下载和草稿保存共用该解析逻辑。
- 验证通过：`npm run typecheck`；Gmail/QQ Adapter、邮件工具和运行时定向后端测试 **12/12**；真实 Electron Gmail 应用专用密码表单与取消流程 **1/1**；`git diff --check`。
- 真实账号只读验证：已用现有加密凭证连接 `imap.gmail.com:993`，自动解析到 `[Gmail]/所有邮件`，成功读取 6,828 封邮件的计数与最近 5 封摘要；未发送邮件、未保存草稿、未修改服务器状态。未提交秘密，也未把邮箱正文写入证据。
- 证据边界：自动用例覆盖文件夹特殊用途选择与英文回退，不连接真实 Google；真实账号联调只证明当前账号的列表与读取路径，尚未逐项验证附件、草稿、回复、发送及撤销应用专用密码后的恢复行为。

## 2026-10-26：微信密钥分轮补抓和品牌图标

- 微信连接向导在一条本机捕获控制通道中管理多轮操作。用户结束一轮后，系统逐库校验 SQLCipher key；若有聊天数据库缺项，UI 显示匹配覆盖与缺项，并给出“继续补抓密钥”。继续时复用同一微信副本、Frida 附加和管理员授权进程；完整覆盖后才结束进程并验证会话/聊天读取。取消仍走显式清理。
- 新增合成协议集成用例：首轮覆盖 contact/session，下一轮覆盖 message/media，校验最终 4 个聊天数据库均有匹配，并断言管理员捕获命令只启动一次。微信图标已替换为 Simple Icons 的 WeChat 矢量标记，使用微信品牌绿底；本地渲染预览确认方形比例和标记居中。
- 验证通过：`npm run typecheck`；`node --test tests/backend/wechat-connector-wizard.test.mjs` **9/9**；`npm run test:acceptance` **16/16**；`npm run test:catalog` 覆盖 **142** 条规则与 **224** 个测试案例；`npm run build`。
- 证据边界：分轮测试使用本机临时 SQLCipher fixture 和模拟 TCP 捕获进程，不执行真实 Frida 注入或系统管理员授权；尚未用真实微信数据库、Electron 连接 UI 完成本机端到端复验。全局变更树中的非微信后端、全套 Electron E2E 和发布验收未在本轮重跑。

## 2026-10-26：Bot 管理全局与本 Bot 资源、凭证并写系统提醒

- 当前 Bot 在唯一私聊可通过 `rambo_resources` 管理全局可选目录、新建 Bot 默认开关和自己的资源开关；本地 Skill 文件夹导入会复制到 Rambo 管理的共享技能库，直连 MCP 支持显式 stdio/http 定义和秘密字段加密存储。两者加入全局目录时已有 Bot 默认关闭，不替其他 Bot 打开。
- `rambo_credentials` 支持 QQ 邮箱授权码与 Gmail 应用专用密码的连接新建、更新和验证；凭证正文使用应用本地 AES-256-GCM 加密写入独立 SQLite，不进入产品主 Store、聊天、系统提醒、快照或工具结果。每次成功资源或凭证写入都会在当前 Bot 唯一私聊追加一条真实持久化的 `role=system` 提醒。
- Skill 导入后会立即失效资源发现缓存并解析 `SKILL.md` frontmatter 的 `name`/`description`；Host 启动 thread 前统一注册 `<profile>/skill-library` 为 Codex extra root，再按全局目录和当前 Bot 开关生成 `skills.config`。
- 定向验证通过：`npm run typecheck`；Host 与资源发现 **98/98**；资源工具、凭证工具、Skill 库、直连 MCP、加密凭证 **17/17**；合并资源域后端回归 **115/115**；验收结构 **16/16**；`npm run build`；真实 Electron 验证系统设置导入后列表立即出现、直连 MCP 表单、秘密不回显、明暗主题和 760px 窄窗口 **1/1**，以及 Bot 私聊 Tool 导入并开启当前 Bot、两条持久化系统提醒和其他 Bot 未启用 **1/1**。
- 证据边界：未让真实 Codex 自主选择并执行导入 Skill 的脚本，未启动真实 MCP Server 完成握手/调用，未用真实 QQ/Gmail 账号验证，也未完成日志/导出全量扫描。主动建议全局变更前的用户同意目前由模型指令约束，尚无宿主确认状态机证据。

## 2026-10-26：Bot 新回复系统通知

- Bot 设置新增“新回复提醒”，默认开启并自动保存。普通私聊仅在 Bot 的 `complete`、`failed`、`interrupted` 终态回复时准备通知，`commentary` 阶段、空内容、群聊、Routine 隐藏执行聊天、归档 Bot/聊天和通知关闭的 Bot 不提醒。
- 当前窗口有焦点且正在查看同一私聊时抑制系统弹窗，查看其他 Bot、设置、任务页或窗口在后台时仍提醒；主进程同时读取 Electron 窗口的真实可见性与焦点，不只依赖渲染层缓存。点击通知会显示窗口并切到对应 Bot。
- 普通提醒等到 turn 终态再判定，避免 `item/completed` 先到、随后 turn 失败时误报完成。失败即使没有最终助手文本也会按同一焦点与逐 Bot 开关提醒；同一 turn 以通知键去重，完成或中断的普通通知要求最后一条非 `commentary` 回复有内容。Routine 隐藏结果回交期间抑制普通回复和失败通知，回交结束后统一按 R09 发出一次 Routine 通知。
- Routine 成功默认只保留应用内结果与历史；仅单条 Routine 开启成功通知后提醒。失败、中断和 `needs_user` 提醒，按 run ID 去重。
- 验证：`node --test tests/backend/recent-message-preview.test.mjs tests/backend/routine-scheduler.test.mjs tests/backend/host.test.mjs` **111/111**，`node --test tests/backend/store.test.mjs tests/backend/store-recent-messages.test.mjs` **42/42**，`npm run build` 通过，目标文件 `git diff --check` 通过。
- 证据边界：以上为规则、Host 生命周期、SQLite 持久化和构建证据。尚未在真实 macOS 上观察系统通知投递、通知点击切 Bot、通知中心分组，以及前台同私聊/其他 Bot/后台三类焦点场景；未完成打包应用验收。群聊目前没有未读模型，本轮系统提醒仅覆盖 Bot 私聊，不能宣称群聊红点与提醒一致。

## 2026-10-26：微信连接手动结束捕获与验证 loading

- 微信密钥捕获钩子就绪后，连接弹窗提供“我已完成操作，开始验证”；点击后通过专用 IPC 请求停止捕获，随后继续 SQLCipher 密钥校验、会话/聊天读取和连接保存。
- 捕获结束、密钥验证与聊天读取期间，原弹窗持续展示阶段和 loading；捕获未就绪时不可提前结束，运行中点弹窗外或按 Escape 不会关闭，显式“取消连接”仍可取消。
- 本轮 `npm run typecheck` 与 `npm run build` 均通过；未运行测试，也未复做真机连接。新按钮、验证进度和误关拦截仍需 Electron/真实微信操作验收。

## 2026-10-26：确认本机 Codex 二进制与独立进程边界

- 用户澄清 A01/Q79 选择的是 Rambo 管理自己的 App Server 子进程，并未禁止复用本机同一 Codex 二进制。已把 A02/A05 和运行时验收定义修正为：普通 `bin/codex` 不是被产品规则禁止的入口，能否使用取决于是否满足 A04 会话来源隔离。
- 后续修订：Q196 已改为 Rambo 独立下载/管理运行时并复制独立 Codex Home，不再复用本机二进制、认证或配置；上面是本轮历史判断，不适用于当前实现。
- 本机 app-server-daemon 0.164.0 清单为 `variant: codex`、`entrypoint: bin/codex`；`codex app-server --listen stdio://` 支持独立 stdio 启动，但不接受 `--session-source app-server`。用该二进制、空临时 `CODEX_HOME` 和 Rambo 当前 `initialize` 参数做了真实子进程协议握手，返回 `initialize` 成功并正常停止；没有创建 thread、调用模型或触及日常凭据。对应 `rust-v0.164.0` 源码调用时固定传入 `SessionSource::VSCode`，而 VSCode 属于默认交互来源。因此用这个入口启动自己的进程是可行的，但在当前 A04 下会让 Rambo 线程可能出现在普通 Codex 历史列表。
- 已记录独立 `CODEX_HOME` 作为待研究方向，但它会改变 A03；认证可能使用与 home 路径相关的 Keychain 身份，不能假定只 symlink 配置和认证文件即可安全共享。本轮没有改运行时启动代码，也没有把本机 0.164 二进制复制进 Rambo 缓存。
- 决策依据和边界写入 Q145、A02/A05、技术设计与验收计划。验收 catalog 同步后，`npm run test:catalog` 为 141/141 规则映射，`npm run test:acceptance` 为 16/16，`node --test tests/backend/runtime.test.mjs` 为 7/7，`git diff --check` 通过。尚未将该入口接入真实 Rambo 启动器，也未并行验证 Rambo 与原生 Codex 的历史列表；本轮没有修改 TypeScript 源码，因此未执行构建/类型检查。

## 2026-10-25：微信 Connector、全局资源配置与 Bot 初值复制实现

- 微信 Connector 已接入统一 Connection/Grant：Bot 可按时间范围查询本机聊天消息、搜索内容和列出会话；工具结果保留稳定身份、边界和覆盖诊断。仅向获授权的 Bot 暴露只读聊天查询。
- 2026-10-26 范围调整与代码同步：微信首版只保留会话、聊天消息、搜索及聊天内媒体；朋友圈查询、Worker 接口、Agent Tool、Connector 能力和连接必需数据库校验均已移除。最近一次真实诊断确认会话数据库解密并返回 100 条，但旧流程在 `sns_query_failed` 后中止；底层 SQLite 原因没有保留，本轮不再排查朋友圈。当前代码尚未用真实微信复跑，聊天消息与媒体的本机验证按 [独立微信链路用例](../tests/manual/wechat-live/CASE.md) 执行；本轮类型检查和 Electron 构建通过。
- 微信正文解析覆盖文字、引用、链接、卡片、表情和系统提示等结构。媒体从微信本机缓存读取，在内存解密或转换，通过短期资源句柄交付；不联网补取，也不写入 Rambo 持久媒体缓存。微信密钥向导实现了 4.1.x 环境检查、受管副本重签、Frida 捕获和 SQLCipher 数据库密钥验证，并在成功后使用应用本地 AES-256-GCM 加密保存。
- 系统设置增加 Skills、MCP、Apps、Plugins 全局目录 Tab：可选目录默认展示，发现目录可搜索且默认收起；目录成员变化同步到所有 Bot 的可见范围。创建 Bot 时复制资源开关、模型和权限初值，之后各 Bot 的开关、模型与权限独立保存。Playwright 使用受管的 Chrome Extension MCP 配置；用户点击验证后，Rambo 等待用户选择 Chrome 标签，只做一次只读快照，持久化的只有检查时间。
- 定向验证通过：`npm run typecheck`、`npm run build`；Host、Runtime、Store、资源目录、连接凭证、邮件 Adapter、Playwright 验证器及微信相关后端 **224/224**；`npm run test:catalog`（146 条规则、224 个局部案例映射完整）、`npm run test:acceptance` **16/16**；真实 Electron 全局初值、资源目录、应用市场和重启回读流程 **5/5**。模型 readiness 回归确认全局初值错误不阻止已有 Bot，但 Bot 自身模型/权限无效时会阻止该 Bot 开始新轮次；授权 Bot 新创建的私聊、群聊成员和 Routine 执行线程都会注册微信工具，未授权 Bot 不注册。
- 证据边界：后端微信数据库使用合成 SQLCipher/WAL；没有对本机微信 4.1.15 执行密钥捕获或读取真实数据库，也没有完成动态 Agent Tool 真机调用。当前 Codex App Server 的 `ThreadResumeParams` 没有 `dynamicTools` 字段，因此已有 thread 不能通过 resume 更新工具目录；Host 每次调用仍校验实时 Grant，但授予或撤销后，旧 thread 的模型可见工具表不会自动更新。Chrome 扩展已在本机检查为已安装并启用，但没有通过真实 MCP 进程执行标签授权和快照；验证器以假 MCP 协议、Electron 业务界面用例通过。完整发布验收尚未执行。

## 2026-10-25：R17 多时刻计划与 O04 重启恢复闭环

- R17：一条每日 Routine 持久化多个有序、去重的 `HH:mm`，创建、更新、调度和列表展示保持同一份计划；每个计划时刻单独抢占 occurrence 并生成运行记录，旧 interval/未知周期 fail-closed。已确认“每 30 分钟”由离散时刻表达或拒绝，不创建多条任务。
- O04：普通 turn 重启后核对并中断，已排队消息持久化后继续派发，派发结果不明的消息停放；Routine 仅在可确认安全时自动恢复一次。不确定的 Routine 运行进入 `needs_user` 并暂停计划。任务页“已检查，恢复计划”会将旧记录保留为 `interrupted`、保存不确定原因，再恢复后续计划；Bot 不能绕过用户处理。
- 定向验证通过：`npm run typecheck`；Host、Scheduler、Store 三个后端测试文件 **141/141**；`npm run test:catalog`（146 条规则、223 个案例、映射完整）；`npm run test:acceptance` **16/16**；`npm run build`；R17 真实 Electron 关窗多时刻用例 **1/1**；`git diff --check`。
- O04 后端恢复证据使用 Host/SQLite 重建和 FakeRuntime；尚未在真实 App Server/macOS 上强制终止进程，也未核对连接器外部副作用回执。新“已检查，恢复计划”按钮尚无独立 Electron 点击验收；R17 的真实 macOS 睡眠/唤醒对账仍未覆盖。完整发布验收未执行。
- 同步了 R17/O04 的验收矩阵、计划、目录和研究结论；修正了因当前测试重命名而失配的 B06/S02/T19 目录映射，并单列 R17 系统唤醒缺口。未提交 Git。

## 2026-10-25：文档与验收定义同步最新 Bot 配置、资源目录和微信边界

- 以 Q113/Q114/Q118 为现行规则，统一说明：模型、权限以及 Skills/MCP/Apps/Plugins 开关在新 Bot 创建时从全局初值复制，之后完全独立；唯一私聊、该 Bot 的群聊成员执行和 Routine 都使用 Bot 自身值。四类本机资源的全局可选目录成员继续实时同步为各 Bot 的可见范围；账号型 Connector 仍由独立 Connection/Grant 控制。
- 以 Q112/Q119/Q140 为现行规则，统一说明：微信只由已授权 Bot 按需查询本机既有记录，Rambo 不维护读取游标；Routine 首版只有定时触发，没有 Webhook、被动事件、Trigger Source、事件补收或自动唤醒。T04/R10 保留稳定编号，但旧 Webhook 首版范围已由 Q140 覆盖。
- 本轮只同步产品决策、技术设计、验收矩阵、规则计划、catalog 与可读测试计划；未修改业务代码、测试实现或真实验收结果。catalog 中所有规则仍按未验收或既有局部证据如实记录，不能据此声称微信、Electron 或完整发布已通过。
- 下方旧进度条目保留当时实施事实；其中“会话覆盖、空值继承、群聊/Routine 使用全局值”和 Webhook 相关内容均属于 Q114/Q140 之前的历史状态，不代表当前产品规则。

## 2026-10-25：Live 结束委派提示与 V3 工具边界

- 用户确认采用加强 Live 委派提示、继续保留 Host 语义兜底的方案。`realtimeStartInstructions` 与 `prompt` 现在要求结束请求必须委派给当前 thread 的普通 Codex，并在委派文本中明确写出调用 `rambo_voice.end_current_voice_session`、参数为空对象，避免只传递“结束语音”的模糊文本。
- 核对本机 `codex-cli 0.164.0` 实验 schema：V3 `ThreadRealtimeStartParams` 没有 `tools`/`dynamicTools`；V3 `delegation.created` 只有文本；`HandoffRequested` 会在同一 thread 启动普通 turn。真实会话 `5340e353-5aee-4c65-8365-92e04c741652` 已证明提醒和第二次结束请求分别由同 thread 的普通 Codex 调用 `rambo_routines.create_routine`、`rambo_voice.end_current_voice_session`，thread ID 全程不变。Delegation 与 handoff 不是两种并行机制或两次 thread 创建。
- Host 继续在用户 Realtime 转写完成和收到 `handoff_request` 时运行隔离、只读、无工具的语义判定；同一用户转写 item 去重，只有明确高置信度结束才停止 Live。这样加强主路径的同时，保留 Live 未委派时的安全兜底。
- 定向验证：`node --test tests/backend/host.test.mjs` **74/74** 通过，`npm run typecheck` 通过；新增断言确认 `realtimeStartInstructions` 与 `prompt` 都包含完整工具名、`version` 为 `v3`，且请求未发送 `tools`/`dynamicTools`。`node --test tests/acceptance/catalog-integrity.test.mjs` 为 **10/11**；先报出的既有 catalog 漂移是 `B13-HOST-01` 仍引用已改名的旧 Host 测试，继续扫描还发现 `T02-STORE-01` 和 `B13-HOST-04` 的旧测试名。本轮未修改这些非语音路径，不能报告验收目录完整通过。
- 尚未做加强提示后的真实 Live 音频复验；因此只能说提示和 Host 兜底已经接通并有定向测试，不能声称第一次结束请求的漏委派已经解决，也不能据此通过 V07。

## 2026-10-25：收敛 Bot 设置、系统设置与 Routine 自主规划（历史实现状态）

- 当时模型与权限实现为应用全局和 Bot 唯一私聊会话覆盖两级；该语义已由 Q114 修订为新建 Bot 复制初值后完全独立，现状与剩余改造见本条之后的文档同步记录，不能作为当前规则。
- 系统设置集中展示全局模型、权限和全部 Routine；连接应用保留侧栏独立入口。侧栏底部改为左侧应用头像、右侧连接应用，并移除 Codex 运行时状态标识。Bot 设置保留当前 Bot 的只读“定时任务”Tab。
- Bot 和系统设置移除了页尾保存按钮；自动保存仍在等待、进行中、失败时给出状态，成功反馈短暂显示后收起。全局模型下拉箭头向内收并增加右侧留白，避免贴边和视觉错位。
- Routine 支持 `chat`、`script`、`hybrid`，列表显示“对话执行”“脚本执行”“判断 + 脚本”。Host 每轮向模型注入 `rambo.current-time`（绝对时间、用户本地时间、日期和时区，同一 thread 后续轮次刷新，Live 启动也注入）；提示词要求 Bot 据此解释相对时间、直接填写可从上下文推断的参数、按任务性质自主选择执行方式，并在创建回合只报告计划，不提前计算未来结果。Host 创建 Routine 时使用系统时区，不再走固定默认。
- 一次性 Routine 在成功、失败或中断后，于结果交回来源 Bot 私聊后自动清理活动定义；错过任务保留到用户手动立即运行，执行后再清理。运行历史、聊天结果与产物保留，不需要新增平行的删除 Tool，也不追加系统清理回执。
- 定向验证通过：`npm run typecheck`、`npm run build`；Host、Scheduler、Runtime、Store 后端 **122/122**，验收结构 **16/16**，Connector、邮件与 Voice 相关后端 **32/32**；真实 Electron 全局/会话配置与 Routine 管理流程 **2/2**；`git diff --check`。真实 Electron 已覆盖自动保存反馈及收起、模型下拉箭头几何、系统设置 Routine 分组、Bot 只读清单、执行方式标签和重启回读。
- 新增真实模型 smoke 已接入隔离 profile：要求模型把“2 分钟后”换算为一次性计划，选择脚本执行，并避免在创建回合算出 `5×6`。本轮三次运行均确认 thread 创建、`turn/start` 成功、runtime `ready`，但模型 turn 在 60 秒内持续 `running`，没有 assistant 消息或 Routine；用例按受阻/skipped 记录，不谎报通过或失败。该 smoke 在端点恢复后会继续严格执行任务类型、脚本模板和不提前报结果断言。

## 2026-10-24：Q104 Bot 设置查看自己的定时任务

- Bot 设置恢复“定时任务”Tab，只读展示当前 Bot 的任务名称、计划、执行内容、状态、下次执行时间和最近运行结果；任务按 Bot 过滤，不显示运行控制按钮。系统设置继续展示全部任务并提供暂停、恢复、立即运行和停止。
- 未增加任务信息到聊天上下文；该入口直接读取当前应用快照，与系统设置共享同一份 Store 数据。
- 定向验证通过：`npm run typecheck`、目录同步/计划/目录（126 条规则、126 个完整场景、197 个局部案例）、验收结构 **16/16**、相关后端 **143/143**、Electron 构建，以及完整 `tests/e2e/private-chat.spec.mjs` 串行流程 **22/22**。真实 Electron 已核对新建 Bot 的任务空状态、A/B 两个 Bot 在各自设置中仅看到自己的任务且没有控制按钮，并在同一 profile 集中重启后回读系统设置分组与 Bot 设置隔离。

## 2026-10-24：Q100 固定 Gmail OAuth 配置并精简授权入口

- Gmail OAuth Client ID 固定从应用内常量读取，不再读取环境变量或用户保存配置；移除 OAuth Client ID/Secret 保存 IPC 与 UI 修改入口。旧 profile 中如有客户端配置文件也不会覆盖内置 Client ID。
- Gmail 连接弹窗收敛为一句授权提示和“前往 Google 授权”按钮；等待时提供取消操作。桌面 OAuth 仍使用系统浏览器、本机 loopback 回调与 PKCE，固定 Client Secret 仅用于 Google token endpoint 的授权码交换与刷新，不进入授权 URL。
- 日历图标换为 macOS「日历」App 的原生 AppIcon，导出为保留透明通道的 256×256 PNG；40×40 卡片与弹窗展示规则不变。
- 本轮 Gmail OAuth 用例验证固定 Client ID、无配置修改 API、精简授权弹窗、PKCE 与取消不留连接；没有打开 Google 登录页或访问真实邮箱。
- 定向检查通过：`npm run typecheck`；目录 126 条规则/197 个案例；验收结构 **16/16**；Host、凭证、Gmail OAuth/Adapter 后端 **73/73**；Electron 构建与市场/Gmail 用例 **2/2**；`git diff --check`。

## 2026-10-26：Q153 Gmail OAuth 凭据改为表单填写

- 删除源码内真实 Google OAuth Client ID/Secret 常量；Gmail 连接不再依赖 ENV、构建注入、全局配置或旧配置覆盖。
- Gmail 连接弹窗新增 OAuth Client ID、OAuth Client Secret、连接名称和可展开获取引导；未填完整时不能发起授权，Client Secret 使用密码框且不回显。
- OAuth 配置随每个 Gmail Connection 和用户 token 一起使用应用本地 AES-256-GCM 加密写入独立 SQLite；产品主 Store 只保存 `db:` 不透明引用，Adapter 刷新令牌时使用该连接自己的 Client ID/Secret。该方案不读取 `safeStorage` 或 Keychain，也不需要开发者证书签名。
- 定向验证通过：`npm run typecheck`；连接器/资源/Host/Store 后端 **174/174**；验收结构 **16/16**；台账 **18/18**；目录同步 **142 条规则、142 个完整场景、224 个局部案例**。真实 Electron 的 Gmail 表单、连接市场、通知准入、设置保存、确定性 Routine 清理/多时刻/停止及在完整流程中的集中重启区块通过；完整文件的真实模型 Routine 用例没有创建 Routine，停在外部模型行为结果，随后 Playwright 跳过了部分本地用例；关窗后台退出用例在独立运行时没有发现 App Server，未计入本轮通过。
- 本轮没有使用真实 Google OAuth 客户端登录、授权或访问邮箱，真实 Gmail 端到端仍待验证；打包后的凭证目录权限、普通数据库重启回读与通知中心展示仍未做真实用户验收。
- `npm run package:mac` 的 electron-builder 阶段不主动使用开发者证书、不公证、不启用 hardened runtime，但它复制的本机 Electron 仍可能带 Apple Development 预签名；因此构建后必须先由发版脚本执行 ad-hoc 重封，再作为本机或下载包使用。实际重建后 `codesign --verify --deep --strict` 通过，输出为 `Signature=adhoc`、`TeamIdentifier=not set`、无 Authority；这不是 Developer ID 或开发证书签名，也不会让 Gatekeeper 信任应用。通知不依赖该签名步骤。
- 重封后的真实 `.app` 已在隔离 acceptance profile 启动，默认页面可用，登录启动偏好可保存、刷新并关闭；启动与这条界面流程没有触发 Keychain。Gmail 成功授权后的凭证落库仍需用户自己的 OAuth 客户端与 Google 授权，本机没有虚构该外部结果。

## 2026-10-24：Q98 调整侧栏底部入口

- 左侧栏底部改为左侧应用头像（打开系统设置）、右侧连接应用；移除 Codex 运行状态标识，主菜单栏状态保持。
- 定向验证通过：`npm run typecheck`、`npm run build`、目录同步/计划/目录/验收结构（125 条规则、196 个案例、16/16）、侧栏与全局/会话配置 Electron 用例 **1/1**、`node --check` 和 `git diff --check`。真实 Electron 用例核对头像在左、连接应用在右、紧凑模式仍横向排列，且底部没有 Codex 状态标识。

## 2026-10-24：Q97 收敛模型与权限为全局级和会话级

- 系统设置提供唯一的应用全局模型和权限；Bot 设置“会话配置”只提供该 Bot 唯一私聊的模型/权限覆盖，空值继承全局。群聊与 Routine 使用全局配置，旧 Bot 默认字段和群聊会话覆盖不再影响有效配置；移除 Bot 默认配置及“应用到全部聊天”层级。
- 普通变更自动保存并从后续轮次生效，正在执行的轮次保持启动快照。Bot 自管理工具只能修改当前 Bot 私聊覆盖，不能修改全局配置或其他 Bot。
- 定向验证通过：`npm run typecheck`、`npm run build`、目录同步/计划/目录/验收结构（125 条规则、196 个案例、16/16）、Host/Store 后端 **89/89**、私聊 Electron **3/3**、群聊 Electron **3/3** 及 `git diff --check`。群聊和 Routine 采用全局配置、私聊覆盖自动保存/重启回读均有定向代码与 Electron 证据；真实 App Server 的实际模型路由仍待单独验收。


## 2026-10-24：Q96 首轮连接市场与 Gmail OAuth 配置入口（OAuth 已由 Q99/Q100 修订）

- 目录只保留 Gmail、QQ 邮箱、日历和 GitHub；仅前两项可连接，日历与 GitHub显示“即将推出”。四项均使用官方 Logo 直接以 40×40 尺寸显示，容器背景透明且没有边框、圆角底或阴影；连接按钮适配明暗主题且不带加号。
- 首轮实现因应用内没有 Client ID 而显示一次性配置入口；Client ID 是 Rambo OAuth 应用标识，不能由本机回调替代。Q99 已将用户提供的 Desktop Client ID 预置到应用，Q100 再固定配置并精简授权弹窗；Q105 根据真实 token endpoint 结果补齐固定 Client Secret，仅用于 token 交换与刷新。
- 首轮定向用例只启动并取消本机回调挑战，没有打开 Google 登录页或执行真实邮箱授权。
- 定向验证：`npm run typecheck`、连接器/Host/Store 后端测试 **110/110**、`npm run test:catalog`、`npm run test:acceptance` **16/16**、市场与 Gmail OAuth Electron 用例 **2/2**、`git diff --check` 通过。Electron 用例使用隔离 profile 和假 OAuth ID，只启动并取消本机回调挑战；未登录 Google、未接入真实邮箱。

## 2026-10-24：Q95 Bot 头像眼睛改为透明镂空

- Bot 头像均通过共享的 `AgentRobotAvatar` SVG 源头绘制；在脸部 SVG 上增加亮度遮罩，用动态眼型轮廓从脸部挖空，容器背景透出作为眼睛颜色。眼型、输入态、眨眼、表情、眼睛跟随和头部运动共用同一套变形参数，眼洞随动画同步。
- 该源头统一覆盖侧栏、聊天与群聊消息、群组合头像、运行行、提及候选、Routine 列表、新建/设置预览和眼型选择器。菜单栏图标使用独立资源，原本已将眼睛做成透明镂空。
- `UPSTREAM.md` 标注了需在同步上游时保留的本地 SVG 遮罩改动；B14 与 Q95 的规则级验收已加入所有头像位置、背景透出及动态镂空对齐要求。
- `node --check`、生产构建、头像 Electron 用例 **2/2**、目录验证（124 条规则、194 个案例全部映射）、验收结构 **16/16**、`git diff --check` 通过。Electron 用例使用自动创建并清理的隔离 profile，覆盖创建/设置头像、当前眼型、鼠标跟随与暗色黑色头像；没有做全头像位置的像素级视觉对照，B14 仍待完整验收。
- `npm run typecheck` 报 3 个现有 `App.tsx` 错误，均为 Gmail OAuth Client Secret 状态变量未定义；本轮未改该文件。

## 2026-10-24：Q93 Live 状态并入运行行并修复挂断残留

- 只读核对会话 `0a998957-8ed6-484b-ad52-01ef1c3529a9`：语音转写已写入聊天记录，取快递一次性任务已创建并在北京时间 11:04 执行。
- 根因是 Bot 主动挂断时 Host 先移除活动语音会话，随后等待 `thread/realtime/stop`；`thread/realtime/closed` 因会话查找失败被忽略，而 Renderer 只收到 `stopping`。另一个缺陷是 stop RPC 报错时工具仍返回成功。
- 删除独立语音面板，将连接中、聆听中、结束中和错误态放入既有 Agent 运行行。Host 现在发出挂断终态；停止失败向 Bot 返回失败、保留可重试会话并让 UI 显示错误，不会永久停在结束中。
- 回归证据：Host 全套 52/52；新 Electron 状态行用例 1/1；Electron 构建成功；验收结构 16/16；目录验证 124 条规则、194 个案例全部映射；`git diff --check` 通过。
- `npm run typecheck` 仍报告工作区系统设置区域的类型问题（`App.tsx` 系统设置 props、保存状态组件及回调类型），与本轮语音代码区域无关；本轮语音改动没有新增类型诊断。真实麦克风 Live、语义挂断和监听恢复仍按 V07 待实机验收。

## 2026-10-24：Gmail OAuth 本机配置与运行时接入

- 历史实现曾支持保存/修改 OAuth Client ID、Client Secret 和环境变量覆盖；这些入口已按 Q100 移除。当前固定使用应用内 Desktop Client ID 与 Client Secret，忽略旧配置与环境变量；Secret 只出现在发往 Google token endpoint 的表单中，不进入授权 URL、渲染层或日志。
- Gmail 运行时启动时创建桌面 OAuth 服务，将 Gmail API Adapter 注册到统一 MailRuntime；令牌刷新后沿原凭证引用加密回写。用户不能修改 OAuth 客户端配置。
- 定向证据：类型检查通过；连接凭证后端测试 6/6；真实 Electron 私聊与连接市场流程 19/19。E2E 使用隔离 profile 和假 OAuth 值，只启动并取消 loopback 授权挑战，没有打开 Google 登录页或建立 Gmail 连接。
- 仍未执行真实 Google/QQ 账号联调，也未读取或发送真实邮件；T10/T11 不能据此标记通过。T17 的 thread 工具 schema 暴露差距继续按原记录保留。

## 2026-10-24：连接应用市场按 Grok Bot 0.75.0 静态结构对齐

- 依据 [UI 基准中的市场静态分析](ui-baseline.md#2026-10-24-连接应用市场)，将首页改为“推荐”和“所有应用”分组；Gmail、QQ 邮箱列入推荐，其余 Provider 保留在目录。搜索与 Provider 分类筛选继续可用，前五个分类直接显示，其余放入“更多”，已连接状态可单独筛选。
- 应用条目改为两列紧凑列表，使用 40px 图标、无重边框的 16px 圆角底、轻悬停底色和右侧连接/管理操作。Bot Grant 摘要保留在条目中，具体授权、断开与重连从“管理”弹窗操作；不可用 Provider 显示“即将推出”。
- `node scripts/change-checks.mjs` 命中类型检查、验收结构、相关后端和 Electron 流程。按本轮 renderer 与 UI 文档实际改动执行：`npm run typecheck` 通过，`npm run test:catalog` 通过（122 条规则均映射），`tests/e2e/private-chat.spec.mjs` 19/19 通过，`git diff --check` 通过；未运行不相关的群聊/头像 Electron 文件及全部套件。
- Electron 流程仅使用隔离 profile 与假 OAuth 值；Gmail 流程只检查加密保存并启动、取消本机回调挑战，没有打开 Google 登录页、连接邮箱或访问真实邮件。静态参考不是 0.75.0 运行时截图，P02 的同窗口像素对照仍待完成。

## 2026-10-23：Connector Core 邮件接入

- 已接入统一 `rambo_mail` 宿主动态工具，提供 `mail_search`、`mail_read`、`mail_get_attachment`、`mail_create_draft`、`mail_reply` 和 `mail_send`；每次调用必须携带 `connection_id`，结果回传实际 Provider 与账号。QQ 与 Gmail 的协议差异只在 Adapter，Host 统一校验连接状态和逐 Bot Grant，不按 Provider 写业务分支。
- Gmail 已实现桌面 OAuth + 本机 loopback 回调 + PKCE/state、应用本地 AES-256-GCM 凭证加密、同一凭证引用刷新令牌、Gmail REST API 映射与 401 单次刷新重试。QQ 已实现 IMAP/SMTP 授权码验证、搜索/读取/附件/草稿/回复/发送。两家均未执行真实账号联调，不能声称 T10/T11 已通过。
- 修复了 Gmail 回复发送未携带 `threadId` 的问题；Gmail 回复保留 `In-Reply-To`、`References` 与线程 ID。QQ 回复保留原邮件 Message-ID/References。
- 修复 Host 在 `thread/resume` 非法提交 `dynamicTools` 的真实协议错误。按 schema，动态工具只能在新建 thread 时注册；当前私聊首轮固定包含 `rambo_mail`，Grant 变化只改变目录与调用时校验且不重建 thread。
- T17 仍有规格落差：未 Grant 时目录为空且调用被拒绝，但 `rambo_mail` schema 可能仍在首轮已注册的 thread 中；这不满足“撤销后连只读工具也不暴露”的字面要求，需后续重建/隔离执行上下文处理或由用户确认修订，不能以模拟调用通过代替验收。
- 定向验证：`npm run typecheck` 通过；Connector、Gmail、QQ、Host、Store 相关后端测试 99/99；验收目录与规则测试 16/16；真实 Electron `tests/e2e/private-chat.spec.mjs` 17/17。以上邮箱结果仍为进程内或模拟协议证据，未打开 Google 登录、未使用 QQ 授权码、未发送真实邮件。
- 上述进度记录的是 2026-10-23 当时状态；Gmail OAuth 固定 Client ID 与精简授权窗口按 Q99/Q100 执行。

## 2026-10-23：Q89 用户与 Bot 新气泡统一入场（阶段动画由 Q165 删除、Q166 恢复）

- 把原仅用于用户发送气泡的约 220ms 淡入、轻微上移和缩放恢复提升为私聊、群聊共用的新消息入场：用户消息和 Bot 新气泡都会播放，历史加载、重新打开、流式 token、状态更新不会重播。
- 当时 Bot 同轮阶段内容替换继续使用独立约 160ms 的动画，不与气泡首次入场叠加；系统提示、运行行和错误提示不套用气泡动画。减少动态效果设置下统一禁用。该阶段替换动画曾由 Q165 删除，现按 Q166 恢复。
- 当时定向验证通过：`npm run typecheck`、`npm run build`；真实 Electron 私聊“用户和 Bot 气泡统一平滑入场”1/1、群聊“用户和 Bot 气泡统一平滑入场”断言 1/1。当前历史重开不重播仍按 S01 缺口保留。

## 2026-10-23：Q88 在 Loading 中展示真实 Turn 启动阶段

- 用户消息已持久化并发布后，Host 在发起真实 `turn/start` 前设置本轮准备状态，运行行显示“正在读消息”；收到 `turn/start` 成功响应或 `turn/started` 后清除并切换到“正在思考”或后续真实活动。失败、中断、完成、运行时断开均收口，旧轮次清理不会误清后续状态。
- 群聊成员运行态新增 `starting` 阶段：成员先表示正在接收本轮消息，拿到启动响应后才按任务模式进入“正在判断”或“正在工作”，不再从点击发送起就谎称已经开始判断。
- 该状态完全独立于发送握手：输入框仍在用户消息提交后立即清空，`Host.send()` 也不等待 `turn/start`。Loading 只补充真实生命周期反馈，不用来确认消息是否发送成功。
- 文档已新增 Q88，并同步 B11、S01、验收矩阵、可读测试计划、规则计划与 UI 基准。
- 定向验证：`npm run typecheck`、`npm run build`、`node --test tests/backend/host.test.mjs`（41/41）、其余相关后端（59/59）、目录同步/计划/目录/验收结构（16/16）通过；真实 Electron 群聊 3/3，私聊“阶段回复/运行行”和“发送即清空”2/2 通过。完整私聊文件串行执行到第 18 项时，该重启回读用例自身因依赖前序用例累积的数据而未命中 `E2E Pilot`；这不属于本轮改动路径，本轮未把它登记为通过。仍不声明 B11/S01 整体通过。

## 2026-10-23：Q81/Q82 模型入口收起、运行头像动效与发送交互

- 私聊和群聊输入框移除模型下拉及相关浮层；模型与权限统一在 Bot 设置“模型与权限”页管理。保存当前私聊覆盖后继续停留在当前 Tab，不再跳回“基础资料”。已有群聊成员模型/权限覆盖数据保留，仍参与后续轮次的配置解析。
- Loading 运行行中的 Bot 头像改为自动播放动效，`followOnHover={false}` 保证鼠标经过时不改变姿态；左侧会话栏运行头像继续保留悬停跟随。私聊和群聊入口共用这一参数。
- 输入框优化了边框层次、圆角、内边距、阴影、聚焦光圈、文字排版和发送/语音/停止按钮的悬停、按下和禁用反馈。私聊 Placeholder 动态为 `发消息给 <当前 Bot 名称>`，群聊保持 `发送群聊消息…`。
- 按 Q82 删除 Portal 飞行克隆、发送前全量消息扫描和 16ms 气泡定位轮询。输入框在提交时立即清空；真实用户消息到达后仅在消息区添加约 220ms 的淡入与轻微上浮标记，动画结束即移除标记。减少动态效果设置下禁用该动画。
- 单聊 `Host.send()` 不再等待 `turn/start` 回包：真实用户消息持久化并发布后即返回；提交前错误仍拒绝发送并恢复原文，提交后启动失败通过 `error` 事件显示。群聊在用户消息发布后立即返回，成员回复在后台启动，群聊忙碌状态持续到本轮成员处理完成。
- 用户消息保留稳定 `data-message-id`；`@` 成员补全插入时同步更新 `draftRef`，确保选择成员后立即按 Enter 发送时读取新草稿。
- 定向验证通过：`npm run typecheck`、`npm run build`、`git diff --check`；`tests/backend/host.test.mjs` **41/41**，其中新增用例直接证明单聊和群聊均在 `turn/start` 回包前返回且用户消息已落库；真实 Electron `private-chat`、`group-chat` 两个文件 **19/19**；`test:catalog:sync`、`test:plan`、`test:catalog`、`test:acceptance` 通过（117 条规则、177 个案例，16 项验收结构测试）。这证明 Q82 的定向交互与发送时序，不证明整体规则通过。提交前失败恢复原文、提交后启动失败提示仍缺真实 Electron 失败注入；当前运行行仍在 `.transcript-scroll` 外的悬浮 dock，尚未满足内容流位置，也未执行完整 Electron 套件、真实 App Server 长任务接管、真实 macOS 菜单栏/Dock 目测或发布验收，因此不声明 B06、B11、S01 整体通过。

## 2026-10-23：Q77 暗色模式黑色头像色块

- 系统暗色主题下，`black` 头像沿用既有反色显示为白色；颜色选择器中的黑色色块同步为白色，切回浅色主题仍显示黑色。
- 持久化颜色标识保持 `black`，没有迁移已有 Bot 数据；头像墨色与色块展示变量分开，避免头像被二次反转为黑色实心圆。
- 已增加真实 Electron 暗色主题断言，覆盖新建与设置页的色块、头像墨色、反色滤镜和颜色标识；实际截图复核头像及眼睛候选均正常显示为白色圆脸。

## 2026-10-23：Q76 群聊 @ 成员补全

- 群聊输入框键入 `@` 后，按光标前的未完成查询过滤当前未归档成员，并加入 `@everyone`；候选以靠近输入框左侧的紧凑浮层展示头像、名称和短职责。
- 支持方向键循环选择、`Enter`/`Tab` 插入、`Escape` 关闭和鼠标点选；选中只替换当前查询，保留其他文字与光标后内容，并在候选打开时阻止 Enter 误发送。
- 补全文本使用后端现有 `@成员名` 路由格式，含空格名称按最长成员名匹配；纯函数单测及实际 Electron 键盘、Escape、鼠标点选和成员路由场景已补充。
- 用户明确暂缓创建 Bot／群聊后的首条主动消息，本轮没有修改 B04/G01 或相关创建路径。

## 2026-10-23：Q75 聊天框空白可滚动与滚动条淡入淡出

- 聊天 transcript 改为覆盖整个聊天框视觉区域，输入框继续作为悬浮层；输入框与最后一条消息之间的空白不再属于不滚动的占位层，鼠标放在该空白处滚轮可滚动消息。
- 用户复验指出原生滚动条即使加延迟和背景过渡，实际仍是延迟后瞬间显隐。聊天区域因此改为自绘滚动条：隐藏原生聊天滚动条，thumb 位置与高度跟随 transcript，透明度通过普通 DOM 的 CSS transition 连续变化，私聊和群聊共用。
- 隐藏的运行行保留固定占位并取消鼠标命中，使空白区滚轮落到 transcript，同时保持运行行出现和退出时底部锚点不跳动。
- 新增真实 Electron 回归：构造长消息，将鼠标放在输入框上方空白，发送真实滚轮事件并要求 transcript 向上移动；进入和离开聊天区域时逐帧采样自绘滚动条透明度，要求出现 `0 < opacity < 1` 的中间状态，再分别稳定到 1 和 0。
- 定向验证通过：`消息流显示阶段回复`、`输入框上方空白可将滚轮交给聊天消息区`、`npm run typecheck`、目录同步与 16 项验收结构测试。未构建、未执行完整 Electron 或发布验收。

## 2026-10-23：Q74 移除 Dock 运行气泡

- 删除系统指示器对 Dock badge 的更新：Bot 运行期间菜单栏 Tray 继续播放 working 帧，Dock 图标不再出现红色“·”气泡；侧栏未读数字徽标、应用内通知记录和系统通知规则不变。
- 相关产品决策、验收矩阵、规则计划和 UI 基准已同步；状态机测试改为断言运行/停止时只切换菜单栏动画，不再注入或期待 Dock 角标。
- 本轮待执行 `node scripts/change-checks.mjs` 后选出的相关检查；未做真实 macOS Dock 目测，因此不能据此声明 B11 整体通过。

## 2026-10-23：Q72 阶段性回复替换（经 Q165 后由 Q166 恢复并修订）

- 当时私聊和群聊的助手文本按轮次 `turnId` 更新同一条持久化消息；后续 commentary/partial_answer 阶段及 final_answer 替换当前内容。旧阶段不再留下独立历史/搜索行；群聊实时同步阶段更新。群聊判断最终返回内部不回复标记时，会移除该临时气泡。
- 当时阶段/item 切换时内容约 160ms 淡入并轻微上移；同一 item 的流式增量不触发重播，尊重系统减少动态效果。停止、失败或运行时中断时，将保留气泡的状态更新为“已停止”或“未完成”。Q165 曾撤销该行为，Q166 恢复气泡覆盖并增加“旧气泡位于最新用户消息前时，下一条助手内容到达后删除并重建”的位置规则。
- 本轮 `npm run typecheck`、`npm run build` 与 `git diff --check` 通过；未运行后端/Electron 测试或真实聊天 UI，因此动画实际观感和 App Server 多阶段事件仍待运行验收，B11/P02 不据此标为通过。

## 2026-10-23：Q71 聊天正文与结构化展示

- 私聊和群聊共用 `MessageContentView`。普通消息支持 Markdown 标题、段落、列表、引用、链接、图片、表格、脚注、任务清单、数学公式；代码块提供高亮、行号和复制；Mermaid 支持流程、时序、ER、甘特、饼图、时间线、桑基、C4 等语法。
- 增加 `rambo_chat_ui.ask_question` 与 `rambo_chat_ui.show_content` 动态工具。结构化展示支持选项/多选/自定义回答、天气/购物/表单/审批/连接器/邮件/日历卡片、图像/文件/音视频预览、语音行、MCP iframe 和柱状/折线/饼图/数据表。
- 卡片数据通过 SQLite `contentJson` 持久化，数据库 schema 当前为 21。未回答卡片在重启后恢复；多张卡可并存并分别操作；自由文字输入关联最新待答卡，回答一张只关闭该卡。交互 Tool 只开放于用户面对的 Bot 对话，Routine 执行会话仍由原 Bot 决定是否展示。
- 验证状态：本轮完成后 `npm run typecheck` 与 `npm run build` 均通过，`git diff --check` 通过；未执行后端或 Electron 测试，也未做 Grok 截图级运行对照，因此真实 App Server 工具调用和聊天内视觉效果仍待运行验收。

## 2026-10-23：Q70 全局定时任务按 Bot 分组

- 全局“全部定时任务”页已按 Bot 分组并默认展开；组头展示头像、名称和任务数，组内任务卡不再重复显示 Bot 名称，任务计划、执行内容、状态和运行记录继续显示。Bot 详情页保持按当前 Bot 过滤。
- B12 的规则场景、可读验收计划、目录和 Electron 断言已同步。对应的 `Bot 设置显示自己的任务且左侧总览在重启后保留全部归属` Electron 场景通过（1/1）；它提供分组与回读的局部证据，不代表 B12 整体通过。

## 2026-10-23：单聊/群聊统一动态运行行与群消息身份

- 按 B11/G12/Q68 将单聊与群聊运行态统一为同一组件：左侧显示 Bot 头像组、右侧显示最新活动驱动的统一文字，不再显示三点。单聊一个头像；群聊显示本轮仍参与判断、思考或执行的成员，最多展示最近 3 个并在左侧头像组右侧显示 `+N`，悬停可查看其余成员名称。普通消息判断阶段显示全部参与者“正在判断”，活动更新后显示思考、搜索、处理文件、运行命令等统一状态；成员逐个完成退场，全部结束整条隐藏。
- Host 新增进程内 `groupRuntimes` 状态并通过 snapshot/事件同步渲染层。普通消息和 `@everyone` 记录全部活跃参与者，`@成员` 只记录指定成员；成员活动按各自群会话归属，避免状态串到其他 Bot。运行时断开时清理并通知全部群运行态。
- 群聊 Bot 气泡左侧显示实际发言者头像，右侧保留名称与内容；头像与名称读取 Bot 当前资料，Bot 删除后旧消息固定显示占位头像和“已删除的 Bot”，不再回退历史 `senderName`。
- 当前代码仍把 `AgentRunningRow` 放在 `.chat-bottom-dock`，该 dock 位于 `.transcript-scroll` 外，固定在输入区上方。因此“运行态出现和退出时底部锚点不移动”虽已有真实 Electron 断言，但只证明当前 dock 的行为，不满足 B11 要求的“运行行留在聊天 transcript 内”，仍是明确实现缺口。
- 本轮文档修改前最近一次代码基线曾记录：类型检查通过，后端 **101/101**，验收目录与脚本 **16/16**，Electron **17/17（约 37.1 秒、约 4 次启动）**。Routine 最终结果通过真实 `item/completed` 写入 SQLite 并驱动原私聊预览；手动运行一次性任务会清空原计划，避免随后又被标为错过。该结果早于本轮决策与验收文档同步，不能视为当前文档版本的重新验证。Host/Electron 已覆盖参与者、最新活动、逐个退场、全员结束、群消息头像与作者名；运行行 transcript 内位置、四成员以上并行视觉、`+N`、改名换头像、删除态和资料变更前后证据仍保留为 B11/G12 缺口，不能据此通过 B11/G12 或发布验收。
- `R16` 已于 2026-10-25 实现后端终态清理：一次性 Routine 的成功、失败或中断结果交回 Bot 私聊后删除活动定义，错过任务保留到用户立即运行并完成后再清理；`routineRuns`、来源聊天消息与成果不随定义删除。Host/Store/Scheduler 已覆盖成功、失败、错过后手跑和跨 Bot 隔离；定向 Electron 已回归成功、失败交接后 UI 清理，错过项保留、手动完成后清理，以及成功/失败 run 仍保留。中断的独立 UI 注入、完整历史页和成果文件入口仍未覆盖，不能据此声明 R16 整体通过。

## 2026-10-25：Routine 自主规划、执行方式与一次性清理

- `RoutineDefinition.execution` 新增 `chat | script | hybrid` 与可选脚本模板；旧数据默认 `chat`，`script/hybrid` 必须带模板。Store 已验证创建、更新、重开持久化和旧数据兼容。
- Host 的 Routine 工具和系统提示已开放执行方式，要求 Bot 优先从对话和已有上下文推断标题、内容、计划、时间与执行类型；只有安全或不可逆操作存在实质歧义时才追问。Bot 独立提出的新自动化建议仍按 R12 先征求同意。
- 2026-10-25 本机真实会话 `53f6756c-4b16-4c58-9e85-2a12d72985e8` 已证明模型能自主创建一次性 Routine，但首轮把“2 分钟后”原样作为 `HH:mm` 提交而失败，相同任务也选择了 `chat`。据此补充提示：相对时间先按当前时间和用户时区换算，创建回合只登记任务且不提前执行未来结果；执行方式仍由模型根据任务性质自主判断，没有把特定计算写成硬规则。Tool 返回的触发时间改为用户时区可读文本，避免把 UTC ISO 字符串原样带给模型和界面。
- `script/hybrid` 仍进入独立 Codex 回合，并由现有权限、审批和审计约束；执行上下文携带模板与模式说明，不新增任意 shell 旁路。
- 一次性任务定义只在结果交接成功后的 dispatcher 阶段清理，交接失败时保留以便重试；清理发布状态变更，不追加并行系统回执，周期任务和其他 Bot 的定义不受影响。
- 系统设置与 Bot 设置的任务卡均显示执行方式标签。真实 Electron 定向流程已验证 `script` 任务在两处都显示“脚本执行”，默认 `chat` 显示“对话执行”，并覆盖全局模型/权限保存、按 Bot 分组任务、重开保留归属、一次性成功/失败/错过后手跑清理。
- 系统设置全局模型下拉框增加右侧留白并内收箭头；模型与权限页的自动保存成功提示改为短暂显示后收起，长期页面不再常驻“更改会自动保存”。Host 新增断言证明 Routine 执行回合使用应用全局模型与权限，忽略 Bot 旧默认值和私聊覆盖；一次性 Routine 的成功、失败、中断都在结果交回后清理，错过任务保留到手动完成。
- 本轮最终定向验证通过：`npm run typecheck`、`npm run build`、Host/Scheduler/Runtime/Store **122/122**；真实 Electron 的全局模型/权限自动保存、Bot 会话覆盖、保存反馈、下拉箭头留白与 Routine 系统/Bot 双入口分组流程 **2/2**。后续补齐当前时间上下文后，Host **71/71**、验收目录 **128 条规则/199 个案例**及验收结构 **16/16** 通过。这些结果证明提示词、真实时间/时区数据、Tool 输出、UI 和持久化边界已经接通；真实模型在新提示下是否稳定完成相对时间换算、选择 `script` 并避免提前执行未来结果仍需新的真实对话 smoke。

## 2026-10-22：Grok 式动态运行态、侧栏最后一句话与移除 COT

- 按 Q66/P02/B11 已实现聊天内 Grok 式动态运行行：当时为三个青色动态圆点和左到右扫光活动文字，按最新活动切换中文状态；聊天运行行不显示头像、Bot 名称或秒数。该运行行已由 2026-10-23 的 B11/G12/Q68 头像组实现取代。运行 Bot 的左侧会话栏头像使用呼吸/轻微形变动效。Grok Bot 0.72.0 的三点与扫光 CSS 参数已提取，当前 0.75.0 的 `GrokBotMark` 为 30/60fps 动态渲染；逐帧头像复刻与逐像素运行态对照尚未完成。
- 按用户最新决定彻底删除聊天内 COT/过程详情入口：不再显示“思考与操作”“查看过程”等按钮，也不再保留相关展开样式。底层 `turn_activities` 与 `turns` 继续保留，用于动态运行状态、模型审计、Routine 关联和内部证据，不作为普通聊天页面入口。Agent 的 `commentary`、`partial_answer` 与缺失 phase 的兼容文本继续进入普通消息流；单聊 Bot 气泡不显示作者名，群聊显示实际发言 Bot 名称。
- 左侧 Bot 会话栏名称下方的副标题改为该私聊最后一条用户或 Bot 消息；没有消息时才回退到 Bot 职责或“开始聊天”。该预览由 snapshot 的 `recentMessages` 随附字段提供，切换 Bot 与重启后保持一致；新增 Store 定向单测覆盖“最后一条可见私聊消息、忽略 system 行”。
- 聊天区已改为仅在接近底部时跟随新消息；用户上翻后，运行状态和活动更新不会自动跳回底部，也不显示“回到最新”按钮。菜单栏已加入原生 Tray 多帧动画和运行态 working 图标；按后续 Q74，Dock 运行 badge 已移除，静态资源、状态机单测和构建通过，真机菜单栏外观仍待复验。
- Store 升级到 schema 16，新增消息 `turnId/phase` 和 `turn_activities` 持久化。Host 已处理 Codex 的 item started/completed、reasoning delta、command/file output delta、MCP progress 与 plan delta；类型检查和后端 **81/81** 通过，新增 Host 集成测试覆盖阶段消息可见、活动归属、事件发布及重启回读。
- 相关真实 Electron 案例已更新为：检查执行中动态行无头像、左侧运行 Bot 头像带动效（比较真实像素帧）、活动状态切换、阶段消息单独显示、单聊免作者名、群聊显示实际发言 Bot 名、侧栏最后一句预览，以及最终回复不存在 COT/过程入口和“运行详情”。最新定向验证：类型检查通过、构建通过、相关私有聊天与群聊 Electron 案例 **2/2 通过**；Store 最后消息预览、预览乱序保护、菜单栏状态单测 **3/3 通过**；Host/Store 相关集成测试 **61/61 通过**；验收目录校验与脚本测试 **16/16 通过**。本次未跑全量套件，仍不能据此通过 P02/B11 或发布验收。
- 侧栏未读提醒已接入 SQLite 已读水位：只统计唯一私聊中上一次已读之后由 Bot 发出的可见回复，用户消息和内部系统记录不增加未读；进入私聊、窗口重新获得焦点时清零并持久化。当前前台会话收到已完成的 Bot 回复或结束回合时也会推进已读水位，快照刷新同步抑制该会话的瞬时未读回显。重复点击当前私聊不再重新加载消息区。最新定向验证：类型检查通过、相关后端测试 **78/78**、验收脚本 **16/16**，真实 Electron“侧栏未读徽标”案例通过。
- 按 Q67 在 Bot 唯一私聊注册 `rambo_groups.create_group`：当前 Bot 自动成为成员，只接受已存在且未归档的成员，至少两个不同 Bot，任意重复成员都会被拒绝；成功后持久化群聊与成员，不自动发送首条群消息，并发送 `groupCreated` 事件让当前界面直接打开新群聊和统一侧栏入口。聊天输入框下方快捷键提示已移除，`Enter` 发送与 `Shift+Enter` 换行保持不变；单聊和群聊输入区不再显示权限控件，权限仍由 Bot 设置页管理。

## 2026-10-22：当前 dev 局部案例与候选包复验

- 当前开发模式验收 run 为 `acceptance-runs/20261022-acceptance-final-01`，冻结产品决策、验收矩阵和测试目录基线；dev epoch 1 源码指纹为 `1913207f0c5fb826486956c8812509cc06056e46d46bcd0eac60d001196a0ae8`。
- `npm run verify:fast` 在目录描述修正后通过：类型检查通过、后端 **79/79**、验收脚本 **16/16**、目录边界 **173/84/89**、台账 **18/18**。该数字是当时快照；R16 新规则把两个旧行为案例改为缺口后，当前目录为 175 个案例、82 implemented、93 not implemented。完整功能门禁当时执行 **80** 个局部案例并通过，原始结果与输出分别位于 `acceptance-runs/20261022-acceptance-final-01/evidence/feature-all-80/result.json` 和 `output.log`。
- 局部案例通过不等于规则通过。当时规则仍为 **0/113**，113 个完整规则场景尚未逐条完成；J1–J4 和当时的六个发布套件也未通过。89 个 not implemented 案例继续作为发布阻塞。该数量是当日历史快照，当前以 117 条规则目录为准。
- 从当前源码重建 `dist/mac-arm64/Rambo.app`，`app.asar` SHA-256 为 `ac1035326baefcddcc7ba61f7943b4e16477ca79bcbe851552dd11bc816e46b6`，应用签名严格验证通过但未公证。独立 app run `acceptance-runs/20261022-package-final-01` 已机器验证 A02-PACKAGE-01/02 与 A05-PACKAGE-01/02 四个局部包案例；A02/A05 的隔离安装、真实授权与模型任务、Computer Use 分发和升级隔离仍未验证。
- `npm run verify:release -- --sections J1,J2,J3,J4,connections,files,recovery,scheduling,interface,workflow` 退出码为 **1**，在测试前因 76 条规则无已实现测试及 89 个未实现案例被拦截；日志见 `acceptance-runs/20261022-acceptance-final-01/evidence/release-gate.log`。这不是发布验收通过。

## 2026-10-22：B06/B13 闭环增强与 G01 群历史工具

- `B06` 的真实 Electron 案例现在从当前 App Server 模型目录选择一个实际存在的模型，验证 Bot 默认模型、默认权限、唯一私聊模型与权限覆盖、A/B 范围隔离以及同 profile 重启持久化。尚未启动真实推理轮次，因此执行中快照、全局默认解析和实际 thread 模型仍未证明。
- `B13` 的真实 Electron 案例扩展为资料和配置写入、私有记忆新增与删除、Routine 创建/修改/暂停/恢复/删除、详情和全 Bot 总览回读、重启后回读。所有写入经验收专用事件进入真实 Host 处理器，未直接写数据库；仍未证明真实 Codex 自主选择工具、下一轮真实模型行为、群聊身份同步和 R14 删除历史。
- `G01` 的 Host 案例证明群成员会话仅获得 `rambo_group_history.read_history`，近期上下文默认有界，更早的当前群消息可按需查询，Bot 私聊和其他群不可读，跨群游标被拒绝。产品内添加既有群新成员的界面流程、真实模型自主调用历史工具和真实群聊旧事实旅程仍保留为缺口。
- 既有群添加成员已补齐：群聊标题新增“成员”入口，通过真实 Store/IPC/renderer 路径追加 Bot，保持成员顺序和已有消息；真实 Electron 验证组合头像及重启持久化。新成员的 Host 案例进一步证明其使用独立群成员会话，不读取自己的私聊，并能从当前群历史工具按需查到加入前事实。
- 当前目录为 **168** 个局部案例（**71** 个有实现证据、**97** 个明确缺口），有局部证据的规则 30 条，规则级通过仍为 **0/113**。最新完整校验结果：类型检查通过，后端 **67/67**，目录与门禁 **16/16**，台账 **18/18**，真实 Electron **12/12（55.8 秒）**，定向门禁 19 个局部案例通过。这些是当时源码构建的局部测试结果，不是发布验收通过，也不是当前 117 条规则基线。

## 2026-10-22：J1 快速验收基础与候选包证据

- 验收执行器修复了 Playwright 规则筛选：中文测试标题改用稳定子串匹配，`--grep` 位于文件参数之前。`npm run verify:feature -- --rules P03,B01,B02,B04` 现实际执行 7 个局部案例，其中 2 个为真实 Electron 路径，整套约 8 秒；不再出现“测试存在却 No tests found”。
- Runtime 新增受控子进程测试，证明 Rambo 启动自己的 `codex-app-server`，参数含 `--session-source app-server`，停止后仅该 PID 消失。Host 新增同一 Bot 跨两轮及 Host 重建继续同一私聊 thread、群聊成员会话使用独立 thread 的测试。以上分别只形成 A01/B02/A05 的局部证据。
- 真实 Electron 创建流程补齐空名称拒绝、云朵/蓝色头像选择与持久化、创建后空白聊天、重启后唯一私聊连续性；设置页确认复用本机 Codex 登录且无 Rambo 注册或跨设备同步入口。Playwright 仍操作真实 Electron，不依赖 Computer Use。
- 新增候选包资源测试与打包版 Playwright 启动测试。重新构建的 `dist/mac-arm64/Rambo.app` 通过 `codesign --verify --deep --strict`；包内 0.163.0 运行时、Code Mode Host、ripgrep 和两份清单齐全，三个二进制为 arm64 且签名有效。打包版以 `app.isPackaged=true` 从自己的 `Contents/Resources` 启动，并直接拉起包内 `codex-app-server --session-source app-server`。构建跳过公证，因为当前未生成 `notarize` 选项。
- 当时目录为 113 条规则、113 个完整场景、4 条旅程、6 个发布套件、154 个局部案例；其中 58 个已有实现证据、96 个明确缺口。该统计已由上面的最新记录替代。
- 当时已验证：`npm run verify:fast`；`npm run test:e2e` 5/5；候选资源 3/3；打包启动 1/1；`npm run verify:feature -- --rules P03,B01,B02,B04`。仍需真实原生 Codex 并行与任务隔离（A01/A04）、无外部 Codex 的隔离安装与真实登录任务及 Computer Use 分发（A02/P01/P03）、两次真实升级隔离（A05）、未登录 App Server 授权（A03）、登录项系统行为（O01）等条件。

## 2026-10-21：R11 部分实现与 epoch 7 验收续跑

- 按产品决策 R11/R12，epoch7 已接入新建单 Bot 文字线程中的例程定义保存和查询：任务列表显示指令/周期表达，并标明当前不会自动触发或执行。重复工具调用使用 callId 去重；已有线程和群聊不开放该创建工具。实现未包含 Live、调度器、触发执行或完整任务管理。
- 实现检查：`node --test tests/backend/*.test.mjs` 28 项通过；`npx tsc --noEmit` 通过；`npm run build` 成功。修复记录为 `ISSUE-0012`，源码指纹为 epoch7 `99283f2bbb33a7cb7fed3830d549e001069308b88a7b742fd0538aa6e0f5e5fe`。这些结果不等同产品 UI/运行时验收；`R11-TEXT-CREATE-01` 与 R11 均待有效运行时复验。
- 验收 run `acceptance-runs/20261021-resume-02` 最新报告（2026-10-21 11:59:18 UTC）为 coordinator 当前构建复验通过 8/62 子案例、0/111 规则、0/10 跨功能流程，全量仍未通过。`P03-DB-PERSISTENCE-RESTART-E7-02` 由 tester 与 coordinator 独立复验通过，范围仅为指定 Bot/chat 本机数据库记录在同 profile 受控重启前后持久；E7-01 因登记 UUID 笔误由 coordinator 复验受阻，另案已按完整 UUID 重跑，不覆盖原始记录。
- `A01-OWNED-SERVER-LIFECYCLE-E7-01` 由 tester 与 coordinator 独立复验通过：精确停止本 run Electron 后，其项目 App Server 退出；同一 profile/hash 重启后建立新进程，记录的外部 Codex PID 保持。该项不覆盖 A01 要求的原生 Codex 任务隔离。
- `P08-GATE-E7-01` 由 tester 与 coordinator 复验通过，确认 Q31/P08 的全量交付门槛与当前报告一致；本案例不替代 111 条规则、10 条跨功能流程的逐项验收，P08 总规则仍未完成。
- P05 当前 checkout 身份/源码组织窄案例与 P06 实施授权文档窄案例，均由 tester 和 coordinator 在 epoch7 独立复验通过；P05 历史目录去向及最终界面仍未覆盖，P06 授权不代表功能验收。W01/W03/W04 文档抽查由 tester 和 coordinator 复验通过，W02 因缺少原始子 Agent 调用/返回 artifact 和 F01 运行证据受阻。
- UI 验收仍受 CUA 无可操作窗口/AX 状态限制：2026-10-21 11:54–11:57 UTC 对新 epoch7 实例再取新鲜状态仍无窗口/AX/tab，`getApp("Electron")` 超时 120 秒，已停止 UI 操作链；见 [CUA 状态证据](../acceptance-runs/20261021-resume-02/evidence/CUA-EPOCH7-INSTANCE-60021-ATTACH-TIMEOUT.md)。最新验收结果及未关闭缺口见[当前验收任务](active-acceptance-run.md)与[当前报告](../acceptance-runs/20261021-resume-02/REPORT.md)。

2026-10-20 用户授权开始。全量范围沿产品决策与验收矩阵，以下批次仅是实施顺序。

## 第一批：工程、原版依据、真实文字聊天基础

- [已写入并完成构建] Electron / React / TypeScript 工程、隔离的 preload 接口、本机 SQLite。
- [首批依据已提取] Luna / max 提取 Grok 0.72.0 主界面、主题、头像和创建弹窗依据；完整像素和交互对照尚未完成，见 UI 基准。
- [代码已接入／启动已观察] 独立 App Server 包准备、stdio 初始化、账号/模型查询接口；设置页实际显示 0.163.0 已连接，并识别既有 ChatGPT 登录状态。
- [代码已接入／推理未验证] Bot / 聊天本机持久化、消息流、停止、引导、结果未知防重与本机消息搜索。未发送真实推理任务，不声称文字聊天验收通过。
- [首屏已显示／流程待验收] Bot 侧栏、创建入口与头像形状/颜色选择器（原版当前创建入口为 13 形状、11 色；26 几何模板仅供旧值解析；默认值按 UUID 派生）、普通聊天、Bot 资料/权限和账号设置。
- [已做源码审查并修补] 默认资源禁用覆盖、子进程退出等待、消息事务、迟到响应和消息加载竞态。修补未替代运行验收，见 foundation-review.md。

## 本轮实际执行

- `npm install`；固定 Electron **42.11.15**（使用本机缓存且校验匹配包内官方 SHA-256 清单），React **19.3.1**、electron-vite **6.0.0**，精确解析版本见 package-lock.json。
- `npm run runtime:prepare`：按需准备下载回退使用的独立 App Server **0.164.0**，归档 SHA-256 匹配后解包到开发缓存；未复制用户认证文件。Q196 后续修订后，常规启动只使用 Rambo 自己的缓存、包内资源或下载回退，不读取本机 Codex 运行时。
- `codex-app-server --help`：实际确认 `--session-source` 参数。
- `npm run build` 和 `npm run package:mac`：成功生成未签名 `dist/mac-arm64/Rambo.app`。这是 Q196 之前的历史结果；当前按 Q199 重新内置经校验的 `0.165.0` 基线，同时保留用户主动安装的独立更新版本。
- `npx tsc --noEmit`：最终通过；收敛头像选项到 13 项后发现的类型索引错误已修复。
- `npm run dev`：开发窗口实际打开；CUA 观察到设置页的 Codex 连接和既有账号状态，未将邮箱地址或凭据写入本记录。终端环境不兼容的 NODE_OPTIONS 仅在桌面启动脚本的子进程环境中清除，不改全局配置。
- 指定品牌原图经等比尺寸转换生成 app.icns，没有重绘或裁剪。原图继续保留。
- 以 CUA 只读对照 Grok 主窗口并打开/退出创建弹窗，没有创建原版 Bot、发送消息、修改连接或复制用户聊天。截图未持久化，因为包含用户已有内容。

未执行自动化测试套件、真实文字推理、Voice、麦克风、Computer Use、邮件发送或打包 App 的独立运行验收。开发窗口启动不等于打包版本已通过验收。

## 后续完整范围

群聊/协作、计划/Webhook/恢复、MCP/Skills/邮箱、文件/图像、Voice/唤醒/设备、Computer Use 争用协调、备份与升级均继续按矩阵推进。未接通能力不使用模拟回复充当完成。

当前未执行产品验收；构建与运行状态另按实际操作更新。

## 2026-10-21：验收 Skill 与首次执行

- 用户要求写完 Skill 后直接启动测试、独立修复和主 Agent 复验，已作为持续目标执行，不等待用户休息后的回复。
- 项目 Skill：`.agents/skills/rambo-acceptance/SKILL.md`，附运行手册、案例/证据约定、独立启动器、台账及单元测试。Skill 结构校验通过；台账 12 项单测通过。独立前向演练发现证据删除/改写仍误报通过的问题，由另一 Agent 修复后，原测试者独立复测通过。
- 正式 run：`acceptance-runs/20261021-full-01`；冻结 111 条规则、10 条 E 流程与 epoch0 构建。12 个首批 UI/集成子案例经主 Agent 审查登记；测试者分别记录受阻，未把包存在/进程存在当作功能通过。
- ISSUE-0001：打包版运行时重载 ICNS 导致启动初始化异常，进程存在但 Store/renderer 未建立。由 foundation_review（Luna/max）修复；正在重新打包，需主 Agent 登记新 epoch、由 rambo_acceptance_tester 复测，再由主 Agent复验。当前不能报此问题已验收关闭。
- Computer Use 操作权在测试 Agent；修复 Agent 只处理本轮测试进程和已分配源码。全量案例提案另由 acceptance_forward_check 编写，尚未作为已执行结果。

最新状态以 run 的 `REPORT.md`、`cases.json`、`issues.json` 和审计记录为准。规划、脚本测试和部分功能修复不代表产品全量验收通过。

### 2026-10-21：续验 epoch 2

- `acceptance-runs/20261021-resume-02` 的 epoch 2 打包并启动成功，使用独立 profile；`app.asar` SHA-256 为 `c2fed8597cbbe8d8a329fc0fc85352c2d7dfb107e5727c0c53753306b2ede44c`。
- 头像 SVG 颜色引用修复已进入包；当前运行窗口中 Bot A/B 图标显示蓝色/紫色。创建表单预览因 ISSUE-0001 的 AX 与像素不一致尚未复验。
- 主 Agent 在 epoch 2 复验 `P02-02` 导航子项和 `P06-DOC-01` 文档子项通过。全量报告仍为否；仅 2/18 个子案例由主 Agent 复验通过，规则拆解和其余功能继续保留。
- T06 的 epoch 1 权限差异尚未定位为“应用全部”实现缺陷；独立 profile 数据显示其中一条聊天晚于另一条更新，正在按明确聊天 ID 重跑权限覆盖与应用全部。


### 2026-10-21 续验更新（覆盖上文早期状态）

- epoch1 已实际启动并完成首批真实文字请求，指定头像可见；已有 13 个登记案例，tester 的 10 个 pass 尚不等于主 Agent 验收通过。
- 主 Agent 本次用 Computer Use 独立确认 T06-01 仍失败并写入台账；没有聊天权限显示/切换控件。导航按钮位置仍与原版不同。
- 三个 Luna/max 子 Agent 均因额度限制中断。后端修改只部分落盘，类型检查有两处错误，接口/界面接线未完成；没有把半成品打包覆盖现有可运行 epoch1。
- Skill 台账 12 项单测本次再次通过。全量功能未通过，持续目标当前为 usageLimited；具体续作入口见 [当前验收任务](active-acceptance-run.md)。


### 2026-10-21：epoch 2 续验与缺口确认

- `acceptance-runs/20261021-resume-02` 已登记 coordinator 对 G01 群聊入口、R11 任务入口、V06 唤醒/监听入口、F03 Bot 文件入口的独立复验：四项在 epoch2 UI 均不可见。各自仅能判定入口子案例失败，完整决策范围仍未覆盖。
- 创建 Bot 表单的 epoch2 AX/像素不一致经主 Agent直接点击及 `Rambo → 显示 Rambo` 再观察未重现；选云朵/蓝色后预览可见蓝色。因 Bot A/B 已占用本轮规定样本，未新建 Bot C，完整创建与颜色持久化路径仍待另一干净 profile 复验。
- T06 本轮单聊天覆盖与应用全部后的 UI/数据库状态一致；旧差异未重现。文件系统实际允许/拒绝行为未测，不能据此通过权限全案。
- B06 当前 Bot 默认与聊天继承标签一致显示 GPT-5.6-Luna；服务端实际模型及线程/轮次归属未取证，仍受阻。
- 群聊缺口已按已确认的 G01/Q39 用户范围交 fixer 实现首个可用 vertical slice；构建和独立复测待后续。全量验收范围保持 111 条规则与 10 条 E 流程。


- 更新：`B04-AVATAR-01` 在 epoch2 经独立 tester 和主 Agent 分别通过。两组形状/颜色预览与 AX 一致，现有 Bot A/B 图标按蓝/紫保存值呈现；取消后只读数据库确认无额外 Bot。该结果不验证新创建 Bot 的颜色持久化，`ISSUE-0002` 不关闭。完整 `B04-01` 仍受阻，创建表单错位问题 `ISSUE-0001` 的原生 Show Rambo 复现此次未复现。

### 2026-10-21：epoch 6 续验

- 当前 run `acceptance-runs/20261021-resume-02` 使用 dev epoch 6，源码 hash `031afab9270f6142cfbed8a2cf75169598c23197ecc3399f7ecac5ed63302255`。产品决策与验收矩阵基线未变；本轮没有修改产品代码或登记新构建。
- 当前报告为 9/52 个子案例经 coordinator 复验通过，规则 4/111、跨功能流程 0/10；全量验收未通过。W01/W03/W04 文档抽查通过；W02 因缺少原始子 Agent 回传 artifact 和 F01 运行证据受阻。详见 [当前验收报告](../acceptance-runs/20261021-resume-02/REPORT.md)。
- A01 两条进程生命周期子案例由 tester 和 coordinator 独立通过：Rambo 关闭/重启时只结束本 run 的 Electron 和其项目 App Server；9 个外部 Codex daemon/App Server/CLI PID 在停止及重启后保持。没有运行或比较原生 Codex 任务，故 A01 仍未完成。
- G01 消息入口复测受 CUA 工具阻塞：10:50–10:52 UTC 在新实例 Electron `8841` 上取得新鲜 state 后，`getApp("Electron")` 再次等待 120 秒超时，未取得 AX/截图。按验收流程停止该 UI 链；没有创建群聊、消息或 turn，也没有改动产品数据。后续仍有不依赖桌面的验收工作。

### 2026-10-24：F05 聊天文件展示与本机打开

- 补齐消息附件的授权流式读取、PDF/文本/Markdown/CSV 预览、音视频播放器、文件保存、本机默认应用打开与 Finder 定位；大文件媒体支持 Range 请求，拒绝工作区外的任意路径。
- `tests/backend/host.test.mjs` 54 项通过；隔离 Electron 用例 `F05-ELECTRON-01` 实测 PNG、PDF、TXT、Markdown、CSV、超过 2 MiB 文本的预览边界、9 MiB PCM WAV 的 Range 读取与实际播放、H.264 MP4 实际播放、无效视频解码提示、保存副本字节一致、RTF → TextEdit 与 Finder 定位。新增 `F05-HOST-01` 验证完成态生图通知只把图片挂到同一轮助手回复，并通过 Host 读取授权。
- 当前设备未安装 Word、Excel、PowerPoint；Office 文件卡片和路径授权已验，Office 应用本身的关联打开需在安装对应应用的设备复验。扩展名、文本 2 MiB 预览限制与编解码边界见 [文件预览兼容范围](file-preview-compatibility.md)。
- `npm run verify:feature -- --rules F05`、`npm run test:catalog` 与 `npm run test:acceptance` 通过；F05 门禁运行 `F05-HOST-01` 和 `F05-ELECTRON-01`，目录覆盖 125 条规则。当前全项目 `npm run typecheck` 被 `src/renderer/App.tsx` 两处对 `RamboAPI.applyBotPermissionToChats`、`RamboAPI.updateChat` 的引用阻塞；这两项声明/桥接不属于 F05。当前机器未安装 Office 应用，故其真实关联打开仍受环境限制。
- P03 的只读数据库持久性窄案例由 tester 与 coordinator 独立通过：本 run 中预登记 Bot 和空白 chat 在同 epoch6 profile 重启前后保持相同 ID、归属、标题、状态、消息数及 Bot/Chat 总数。此项不证明 UI、任务、设置、记忆或登录条件。

### 2026-10-24：系统设置与 Bot 设置调整

- 按 Q92/Q94 将应用全局模型和全部定时任务集中到系统设置；连接应用保留为侧栏独立入口。Bot 设置取消各 Tab 的手动保存按钮，普通设置改动自动保存，并保留 Bot 默认模型、私聊覆盖和权限的职责范围。
- 调整 Bot 设置的布局、Tab、权限卡片、长期记忆和任务/列表样式；补齐自动保存状态及窄屏布局。决策记录、验收矩阵、规则计划和测试目录已同步，S02 全量验收仍待完成。
- `node scripts/change-checks.mjs` 映射了类型检查、验收目录/结构、Host 与其他后端目标、Electron 构建，以及 avatar-picker、private-chat、group-chat E2E。按本轮范围运行验收/Host 检查、系统设置相关 private-chat 用例和群聊导航回归；avatar-picker、与页面无关的后端目标及打包运行时检查未命中本轮功能，未执行。
- 验证通过：`npm run test:catalog:sync`、`npm run test:plan`（124 条规则/完整场景）、`npm run test:catalog`（194 个案例，92 个已实现）、`npm run test:acceptance`（16/16）、`npm run typecheck`、`node --test tests/backend/host.test.mjs`（53/53）、`npm run build`、`npx playwright test tests/e2e/private-chat.spec.mjs --grep '系统设置|连接应用市场|一次性 Routine|停止本次并暂停|模型与默认权限|自管理写入'`（7/7）、`npx playwright test tests/e2e/group-chat.spec.mjs`（3/3）及 `git diff --check`。
- 定向 Electron 用例覆盖独立连接入口、全局模型和 Bot 设置自动保存、Bot 设置无任务 Tab、系统设置任务分组与现有连接授权页入口；浅色/暗色、键盘焦点、窄屏完整视觉检查、真实授权及运行时模型路由仍未由本轮用例证明。

### 2026-10-25：Q109 顶部语音胶囊与转写气泡增长

- 语音状态已从聊天底部运行行迁移到聊天顶部的当前 Bot 头像与名称胶囊，底部 `AgentRunningRow` 只表达普通文字任务。拨号时名称退出布局、胶囊收为水平居中的 44px 圆球并显示头像主色双层环形加载与轨道圆点；接通后头像位于展开胶囊左侧，右侧显示 13 根等宽、细高、宽幅排列的实时音柱，优先跟随真实输入频率。未说话时音柱完全等高、短而静止，不呼吸；说话后以中间为锚点向两侧交错读取语音频段，低频能量先抬高中心，再保留左右自然错落，动态快起慢落且不叠加 CSS 过渡，停顿约 `100ms` 后明显回落。结束中音柱变灰静止，成功后收回名称胶囊，失败保留可见错误。
- 音柱映射最初按原始低频到高频从左到右铺开，正常语音的低频能量导致左侧整排先升高；单纯翻转方向只会变成右侧先升高。当前改为 `[11, 9, 7, 5, 3, 1, 0, 2, 4, 6, 8, 10, 12]` 的中心锚点频段顺序，并将低频峰值向中心塑形；左右仍读取各自频段，不恢复镜像同步。纯状态测试新增低频人声先抬高中心、静音完全等高、左右非对称和快速回落场景。
- 静音误判修复：麦克风分析链路加入 75Hz 高通，频谱映射扣除全频段噪声底，状态模型按整段频谱平均能量而不是单个低频峰值判断说话，避免底噪集中在左侧时显示一串高音柱。纯状态测试新增左侧低频底噪场景。
- 修复回收路径的尺寸抖动：语音态中名称不再参与宽度计算，胶囊按钮自身保留尺寸过渡；真实采样从 `164px` 连续增长到名称态宽度，不再出现先缩窄再回弹。音柱改为 `space-between`，13 根等宽柱在实际胶囊宽度内横向铺开；柱体使用无渐变、无阴影、无模糊滤镜的实色圆角矩形，避免光晕感；删除单独加粗的第 7 根。
- Live 转写气泡在正文末尾使用 `1.5px × 1em` 的清晰普通光标，按 `em` 跟随实际字号，不再固定为 22px 行高；通过基线偏移让光标上下边界落在当前正文行内并与该行文字垂直居中，同时移除渐变、柔光、阴影和毛玻璃边缘。新增片段保留到该条转写完成，侧栏最新一句同步更新。
- 转写气泡宽度改为 `fit-content`：空态是贴近光标的窄气泡，随正文固有宽度增长，达到 `min(82%, 670px)` 后才换行增高。取消上一版为防回缩而锁定的固定长条宽度，也仍不做宽度过渡，避免每次增量触发横向缓动；新增片段只淡入、不改变排版宽度，换行后正文与气泡高度完整同步。
- Live 接通后，挂断叉放在胶囊右侧的独立圆球中，与胶囊间距 `8px`，尺寸对齐接通态胶囊内头像 `38px`，不再叠加在胶囊内部。
- 真实 Electron 定向用例覆盖连接圆球、居中位置、展开尺寸插值、13 根音柱横向跨度与左右镜像、头像主色、结束灰态、成功单调收回、挂断圆球与头像同尺寸、`1em` 普通光标的高度与上下边界、光标和正文中心线偏差不超过 1px、空态窄气泡、正文增量增宽、换行不裁字、片段动画、侧栏同步和 reduced-motion；浅色连接/接通/结束/回收截图已人工复核。本轮 `npm run build`、两条定向 private-chat 用例及状态模型测试通过。
- 边界：普通文字任务运行行仍位于 `.transcript-scroll` 外的悬浮 dock；本轮语音视觉使用验收事件和真实 renderer 渲染，不等同真实麦克风频率、真实 Live 音频闭环、真实语义挂断或完整 B11/V07 验收。外部窗口清理现为 best-effort，避免 macOS System Events 异常掩盖产品测试结果。
- 2026-10-25 继续修复真实麦克风音柱观感：放弃继续仿写 Hark 阈值，改为实际接入 `hark@1.2.3`（MIT）的 VAD 状态机，并使用 LiveKit `useMultibandTrackVolume` 的 Apache-2.0 dB 分析思路（`getFloatFrequencyData`、`[-100,-10]dB` 截断、`sqrt` 归一化、等宽频段平均）。Hark 使用 `fftSize=512`、`smoothingTimeConstant=0.1`、跳过最低 4 个频点、`-50dB` 阈值和 4 帧历史；它只负责起说/停说，视觉层不再自行判定或保留静音状态。视觉 analyser 继续以 `fftSize=2048` 分析约 `90–4000Hz`，Hark 未报告说话时所有柱强制回到等高短基线，报告说话后才显示真实频段。`voice-waveform-model` 的 8 个纯状态测试覆盖 dB 归一化、频段聚合、采样率/FFT 频段范围、中心锚定、底噪静默、左右独立落差和 Hark 释放后的回落；真实浏览器 Web Audio 用例新增上游 Hark 包的 50Hz 低频轰鸣、880Hz 起说与停说测试，3 次重复 6/6 通过。当前只证明合成振荡器与 Hark 浏览器链路，真实耳机麦克风、Live 音频闭环和听感仍未验收。
- 真实麦克风音柱第二轮修正：用户反馈说话时仍从左侧整排升高、静音回落不够丝滑、中柱偏粗。视觉频段改为 1.3 次幂的非等宽划分，给语音基频更多分辨率；`centerVoiceFrequencyBands` 先以中心频段作为能量锚点，再把左右各自独立频段作为纹理叠加径向权重，彻底去掉低频向右铺开的扫光效果。显示层继续使用双层非对称惯性（包络快起慢落、柱体再慢一档），新输入不会瞬时跳变，Hark 静音后连续、单调回落到等高短基线；中柱与其他柱共用同一 `2px` 宽度。
- 最新验证：`voice-waveform-model` 纯状态测试 11/11；真实 Web Audio 用例把停说观察窗与 `500ms` 回落判定拆开，连续 5 轮共 10/10 通过；真实 Electron 顶部语音胶囊定向用例通过；`npm run typecheck` 与 `npm run build` 通过。上述证据覆盖合成频谱与渲染状态，真实耳机麦克风的响度、底噪和主观平滑度仍须用户实机复验，不能写成 V07 或完整 B11 已通过。
- 语义挂断兜底：保留 Live 将 handoff 交给普通 Codex 的主路径，同时由 Host 对 `thread/realtime/itemAdded` 的 `handoff_request` 做独立语义控制判定。判定使用临时、`read-only`、`approvalPolicy=never`、无 dynamic tools、关闭 MCP/Skills/Apps/Plugins 的低推理回合，只返回 `end_current_voice | continue_voice` 与置信度；只有明确结束且高置信度才调用幂等的 `thread/realtime/stop`，不按固定关键词匹配。判定期间新 handoff 以最新话语覆盖待判内容；判定失败或超时只放弃兜底，不把可见 Live 置为结束中；内部判定回合的通知不写入聊天。手动挂断与判定结果竞态只产生一次 stop 和一次终态事件。Host 全套 70/70 通过，新增覆盖明确结束、讨论如何结束、低置信度、最新 handoff 覆盖、分类失败后恢复、内部通知隔离及手动/分类竞态。
- 真实 0.163 App Server 协议探测通过：`ephemeral + read-only + approvalPolicy=never + 关闭能力 config` 的 `thread/start` 返回临时 thread，未因字段组合被拒；ephemeral thread 不能被持久化 `thread/delete`，生产清理因此保持 best-effort。本次真实 Live 仍待复验：说“结束、挂断”应快速关闭；说“这个语音功能怎么结束？”不应关闭；助手问“现在挂断吗”后答“是”应关闭；说“结束这个提醒任务”不应关闭 Live。另已确认历史卡住样本 `14e755f1-ca3a-4ec0-98da-0f62796cccc6` 的普通 Codex 首 token 延迟约 644 秒，用户手动关闭后工具才执行；这解释了旧链路长时间“正在思考/正在结束”，但不替代新兜底的实机验收。
- 真实会话 `5340e353-5aee-4c65-8365-92e04c741652` 暴露了语义兜底的触发缺口：14:41:22 已完整识别“好，你可以结束了”，14:41:25 Live 口头回复“好的，这就结束语音”，但没有产生 handoff、普通 Codex 回合或结束工具调用；第二句 14:41:36 才 handoff，14:41:50 实际挂断。根因是兜底原来只监听 `handoff_request`，Live 模型忘记委派时完全没有独立判定机会。现改为用户 Realtime transcript item 完成时也触发隔离语义判定，同时保留 handoff 入口；同一转写 item 或相同最新话语按 `checkedIntentHandoffs` 去重，避免实时转写和 handoff 双触发。Host 新增“无 handoff 直接挂断”“转写/handoff 同句只判定一次”“旧转写不压制新 handoff”回归，并在测试目录登记 `V07-HOST-05`。最终 Host 74/74、`npm run typecheck`、`git diff --check` 和顶部语音胶囊定向 Electron 1/1 通过。真实 Live 音频、麦克风关闭和监听恢复仍需按 V07 实机复验。
- 语音 delegation 与错误态收尾：核对 `5340e353-5aee-4c65-8365-92e04c741652` 的真实记录，提醒和结束语音都只有 `<realtime_delegation><input>…</input><transcript_delta>…</transcript_delta></realtime_delegation>`，没有结构化工具名或参数；普通 Codex 在同一 thread 的后继 turn 中调用 `rambo_routines.create_routine` 和 `rambo_voice.end_current_voice_session`。V3 Realtime 启动参数没有 `tools`/`dynamicTools`，因此当前不能由 Live 直接调用动态工具；已加强 `VOICE_START_INSTRUCTIONS`/`VOICE_PROMPT`，要求结束委派明确点名 `rambo_voice.end_current_voice_session` 并传入空对象，Host 的转写完成和 handoff 语义兜底继续保留。
- 按用户截图优化语音错误胶囊：连接异常与结束失败都显示完整标题、短原因及胶囊外独立 `34px` 圆形“重新拨号”按钮；错误胶囊不再被外层 `320px` 上限和 `overflow:hidden` 裁成半句。Realtime/媒体协商失败现在也会进入该错误胶囊，而不是只显示通用错误通知；成功结束仍清理错误态。定向 Electron 用例同时覆盖“语音结束失败：服务暂不可用”和“语音连接异常：语音连接已关闭：transport_closed”，检查标题/原因不裁切、重试按钮尺寸、位置和视口内可见；头像颜色断言改为直接比较实际解析值，消除随机头像色造成的用例抖动。本轮 `npm run build` 通过，包含错误胶囊检查的宽幅实时频谱定向用例 5/5 通过；Host 全套 74/74 通过；验收目录同步后 `test:catalog` 与 `test:acceptance` 通过。真实 Live 音频首次结束语音是否不再漏 delegation、真实麦克风与监听恢复仍未复验，不能据此宣称 V07 或完整发布已通过。
- Q143 用户实测发现自然说“结束”时 Live 仍只口头回应，而明确说“调用工具结束”才触发流程。本轮扩展 `VOICE_START_INSTRUCTIONS` 与 `VOICE_PROMPT`：示例包含“结束通话”“你可以结束了”“退下吧”，要求不等用户提到工具、先委派当前 thread 并点名 `rambo_voice.end_current_voice_session` 与 `{}`；隔离 Host 意图判定提示同步扩展口语、委婉说法且继续按语义而非关键词判断。更新 V07 决策、验收矩阵和规则计划。Host 87/87、`npm run typecheck`、`npm run build`、`npm run test:catalog`（224 案例）、`npm run test:acceptance`（16/16）和 `git diff --check` 通过。回归仅证明启动参数注入和模拟 Host 判定；新提示只对下一次启动的 Live 生效，真实 Live 音频是否首次可靠挂断仍需复验。
- Q143 真实 Live 复验：会话 `a822d180-ddf8-4bbd-be5c-c942a26e0c1b` 已在启动时加载更新后的结束提示。同一 thread 更早的一次 `rambo_voice.end_current_voice_session({})` 正常回复；之后用户分别说“呃。退出语音吧”“好，OK。那你退下吧”，两回都成功调用结束工具、Realtime 进入 `ended`，但同一 turn 的后续回复均收到 `unsupported_persisted_item_context` / `previous_response_id` / HTTP 400，原始错误 JSON 被 Host 发给 UI。两次失败 rollout 均为 `cli_version=0.163.0`。当前源码默认目标是 `0.164.0`，但本地运行目录当时只有 `0.163.0`，所以新提示生效并不代表新 App Server 已运行。准确原因仍无法从报错区分 hosted-tool、compaction 或隐藏 reasoning 状态；0.164 发布说明也没有列出这条明确修复。需让应用实际运行 0.164 后再做真实 Live 复验；若仍失败，需要 App Server/Responses 续接层修复。V07 仍是部分证据。

## 2026-10-26：Q155 Gmail 新连接改用应用专用密码

- Gmail 新连接改为填写邮箱地址和 Google App Password，经 `imap.gmail.com:993` 与 `smtp.gmail.com:465` 验证；不再展示 OAuth Client ID/Secret，也不启动 Google OAuth。App Password 经 IMAP/SMTP 适配器提供搜索、读取、附件、草稿、回复和发送映射。QQ 与 Gmail 共用协议适配核心，分别保留各自服务器、邮箱和 ID 前缀。已有 OAuth-token Gmail 连接仍由旧 Adapter 兼容读取。
- 连接说明写明两步验证要求、账号限制、密码可重复使用至撤销、不是一次性验证码，以及 Google 对这种较不安全兼容方式的提示。Bot 凭证工具接受 Gmail App Password；成功保存会在当前 Bot 唯一私聊产生不含凭证的系统提醒。
- 决策、研究、验收矩阵、规则计划和目录已同步 Q155/T20 与 M09；Catalog 最新校验为 **144 条规则、229 个案例、112 个已实现局部案例、117 个缺口案例、50 条已有局部证据的规则**。`node scripts/change-checks.mjs` 命中构建、连接器、Host/Store/Runtime、跨进程契约、renderer 和验收模块；`.env.example` 与临时目录未匹配并保持原样。
- 检查通过：`npm run typecheck`；完整后端串行 **305/305**；`npm run test:catalog`；`npm run test:acceptance` **16/16**；`npm run build`；`git diff --check`。相关 Electron 联合回归 **31 通过、1 跳过**，覆盖 Gmail App Password 表单、群聊、多时刻/集中重启、后台运行和 Codex 运行时重启。完整后端默认并发运行时曾出现 Host 文件测试结束后的 SQLite 异步活动，单文件和串行完整回归均通过，测试收尾隔离风险仍保留。
- 证据边界：本地 Adapter 与 Electron 用例没有连接真实 Google 账号；真实 App Password 生成、Gmail 账号策略、完整邮件操作和撤销恢复仍待真实账号验收。相关 Electron 联合回归通过不等于全部 E2E、真实模型或 P08 全量验收通过。

## 2026-10-26：系统设置显示 Rambo 应用版本

- 系统设置标题栏新增当前安装包版本标签，通过 Electron `app.getVersion()` 读取；与“Codex 运行时”卡片中的运行时版本明确分开。
- 用户明确要求本轮按简单改动发布、不运行测试。仅完成构建、本机安装、签名与发布核验；该小改动不改变 P08 全量验收边界。

## 2026-10-28：Q175 插件统一管理自身 MCP 与三资源子 Tab

- 系统设置和 Bot 设置的资源页新增 `Skills`、`MCP`、`插件` 三个子 Tab。导入本地 Skill 只在 Skills 展示，添加直连 MCP 只在 MCP 展示，插件页承载 Plugin/App 开关。
- 插件 manifest 与 `.mcp.json` 中的内部 MCP 被识别为插件运行能力，并从独立 MCP 目录移除；启用插件时由 Host 注入其运行配置，停用时同时关闭插件与内部 MCP。旧 `computer-use` 与当前 `unified-computer-use` 继续合并为一个用户可见入口。
- Runtime 声明并转发 MCP form elicitation，Renderer 显示允许、拒绝、取消；Host 等用户明确选择后才回传结果，不在后台自动接受 Computer Use 权限。
- 定向验证已覆盖插件内部 MCP 不出现在独立目录、A/B Bot 插件开关隔离、Runtime 声明 `openai/form`、elicitation 转发与拒绝清理；隔离 Electron 已覆盖系统设置与 Bot 设置三个子 Tab，并断言 `Computer Use` 位于插件目录、`cua_repl` 不出现在独立 MCP 列表；`cua_repl` 权限弹窗经用户拒绝后清除。真实 Computer Use 端到端允许/拒绝和真实 GUI 操作仍待完成。

## 2026-10-28：Q177 资源新增改由 Bot Tools 管理

- 系统设置资源页移除“导入本地 Skill”“添加直连 MCP”按钮和直连 MCP 配置表单；对应 Renderer、Preload、RPC 手动入口一并删除。
- Bot 继续通过 `rambo_resources.import_local_skill`、`add_direct_mcp` 和 `manage_resource` 管理新增与目录操作；已有直连 MCP 定义的启停、删除保留为异常清理入口。
- 资源页新增固定管理说明和“新增由 Bot 管理”标记，切换“技能”“MCP 服务”“插件”时顶部说明不再变化；分段控件补充更明确的选中层级、主题化徽标和窄窗口布局。
- 验证边界：已通过类型检查、构建和定向 Electron 断言，覆盖三个子 Tab 均无手动新增入口、固定说明、浅色/暗色徽标和 640px 窄窗口；未执行真实 Codex 自主选择工具、真实 MCP 握手或完整安装版发布验收。

## 2026-10-28：Q178 主题化勾选控件与统一滚动条

- 全局复选框改为主题化圆角方框与勾号；设置、资源和连接应用 Bot Grant 的开关统一为胶囊轨道与圆形滑块，保留真实 checked、禁用、键盘焦点与无障碍名称。
- 群聊成员等真实多选行增加轻量选中背景与边界层级；浅色使用中性深色选中态，暗色自动反相，不再依赖平台原生勾选外观。
- 应用内所有滚动容器统一使用透明轨道、细圆角主题滑块和悬停淡入淡出，聊天框现有滑块作为视觉基准；连接应用弹窗增加 `scrollbar-gutter: stable` 和滚动链隔离，出现滚动条时正文不再横向跳动。
- 验证边界：类型检查、构建、资源设置定向 Electron 和 Gmail 连接弹窗定向 Electron 通过；资源页浅色/暗色截图已人工复核。完整安装版所有长列表、多 Bot 连接管理弹窗与不同窗口高度仍保留在发布视觉验收中。

## 2026-10-28：Q179 资源状态行取消整行底色

- 系统设置资源页移除“新增由 Bot 管理”徽标；Skill 与直连 MCP 继续由 Bot Tools 新增，Q177 的固定说明和入口边界不变。
- 资源启用状态与连接应用逐 Bot Grant 状态不再改变整行背景、边框或阴影；普通悬停反馈仍保留，状态只由主题化 switch 的轨道颜色和滑块位置表达。
- 开关开启时使用主题主文字色形成高对比轨道，关闭时使用低对比中性轨道；真实 checked、禁用、键盘焦点和明暗主题适配保持有效。
- 验证边界：资源设置 Electron 用例检查徽标不存在、开关启停时轨道颜色变化，以及资源行背景、边框和阴影不随状态变化；浅色与暗色隔离 Electron 截图已人工复核。完整安装版的明暗主题、长列表滚动和窄窗口视觉仍须在发布验收中复核。

## 2026-10-31：Q214 微信 4.2 图片独立密钥

- macOS 受管微信捕获钩子在数据库 AES key 之外，从微信进程内枚举 `kvcomm/key_<UIN>_*`；主进程用规范化 wxid 派生图片候选，并只在真实已缓存 V2 DAT 上验证通过后保存。
- 微信连接凭证新增可选 `imageKey`，继续由本地 AES-256-GCM 凭证库加密；旧的只含 SQLCipher key 的凭证仍可读取。连接捕获版本升至 `rambo-wechat-platform-v4`。
- Worker 对 V2 图片 DAT 使用独立 16 字符 AES key 与 1 字节 XOR key；消息结果可提前识别真实图片 MIME，媒体读取在内存返回解密字节，不建立 Rambo 媒体副本。
- 真实临时微信 4.2 样本枚举到 8 个 V2 DAT，从 `key_1791714642_*` 与 `wxid_qvhsb7mvm2u311` 派生后解出 3,384 字节 JPEG；未输出 key、路径或媒体内容。
- 合成及定向测试已覆盖图片 key 派生、V2 解密、缓存扫描校验、连接捕获、凭证传递和 Worker 媒体读取。现有正式微信 Connection 的加密凭证已写入真实验证通过的图片 key，固定绑定更新为微信 `4.2.0`（build `270348`）和捕获版本 `rambo-wechat-platform-v4`；在 Bot Grant 与账号、目录、版本绑定检查通过后，生产只读微信 Tool 连续读取同一张本机 `image/jpeg`（1,019,210 字节），其中第二次是在重新加载加密凭证后完成。
- 微信 4.2 的 `VoiceInfo.svr_id` 使用 64 位整数；Worker 现以 BigInt 读取并用文本形式匹配稳定 server ID，避免单条超出 JavaScript 安全整数后整张语音表被吞掉。媒体库 WAL 回放结果无法生成有效 SQLite 快照时，Worker 会读取已通过 HMAC 验证的基础数据库，并在覆盖信息中明确标记“可能不包含最新提交”，不会把降级读取说成完整结果。
- 真实正式 Connection 已通过生产 `rambo_wechat` Tool 读取一条本机语音：媒体库中检测到 2,038 条语音记录，最近候选命中 1 条消息和 1 个 `audio/silk` 媒体，SILK 经内置解码器转为 `audio/wav`，大小 294,764 字节。该复验使用构建后的 `out/main/wechat-worker.js`，不是源码直载。
- 真实 Bot 回合已证明动态 Tool 正常装载。旧版本曾把图片和语音作为 `input_image` / `input_audio` 交付，并导致 Codex 会话 JSONL 持久化 data URL；Q215 已改为写入受控临时文件并返回 `local_path`，不再由微信动态 Tool 返回媒体 base64。
- 微信连接提示现要求图片调用 `view_image({ path: local_path })`、视频按 `frame_paths` 读取，不能把临时文件复制到工作区或长期保存；语音优先使用消息自带的 `media.transcription`，没有可靠转写时必须如实说明当前没有可用的本机语音转写能力。
- 对真实语音样本的脱敏临时验证显示音频并非静音，但 macOS Speech `zh-CN` 在线/离线均返回 `No speech detected`，`zh-HK` / `yue-CN` 结果明显错误且置信度极低。若要覆盖微信没有提供转写的语音，需要另行确认并引入可靠的本机 Whisper/SenseVoice 等引擎；当前没有新增第三方转写依赖。
- 验证记录：`npm run typecheck`、`npm run build` 通过；微信媒体、微信 Tool、附件清理和 Host 定向测试 **140/140** 通过；当前开发实例已在构建后重启。真实图片和真实 SILK 语音均通过生产 Tool 路径落盘到 `composer-attachments`，权限 `600`，动态 Tool 输出不含媒体 data URL。
- 媒体输入、SILK→WAV 转换和视频抽帧仍走内存及 `stdin`/`stdout`；资源句柄 Map 只保存微信相对路径、语音 ID 和创建时间，不保存媒体字节，并短期失效。解密后的图片/语音/视频只在 `composer-attachments` 中形成受控临时文件，不进入 Rambo SQLite 或长期缓存。
- 仍有一个重要边界：内置 `view_image` 会把图片字节以内联 data URL 写入 Codex 会话 JSONL。新微信动态 Tool 已不再主动输出 base64，但 Agent 实际调用 `view_image` 后仍可能扩大会话历史。Rambo 当前没有按天清理 Codex 会话 JSONL 的策略；若要彻底移除该边界，需另案采用本地视觉描述/OCR 或不同的图片交付协议。
- 当前生效边界仍是 macOS 微信 4.2 的本机 V2 图片及真实 SILK 语音落盘；官方主微信在线状态、仅缩略图/完全缺失、断网、旧句柄失效、真实视频、WXGF、其他图片容器、Windows 图片链路及无微信转写时的可靠语音识别不在本轮通过结论内。
