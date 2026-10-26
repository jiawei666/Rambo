# Grok Bot UI 基准（0.72.0、0.75.0 与 0.75.5）

## 2026-10-22 版本更新与聊天运行态证据

本节记录 2026-10-22 当时安装的 **0.75.0**。原 0.72.0 的页面、Token、头像和创建弹窗依据继续作为历史证据保留在本页；文件查看器的后续证据见 0.75.5 专节。

- 当前包：`/Applications/Grok Bot.app/Contents/Resources/app.asar`
- SHA-256：`1035db7b1f77974c78e6c18a4426a5fe16c639946335f7d57badfd0761971a5e`
- 当前 renderer 入口：`dist/renderer/assets/index.eager-app-wqHXQRAi.js`、`index.eager-common-DDLNUvWu.js`、`index-CEV-0tKx.css`。
- 发送消息后，Grok Bot 聊天运行态呈现动态 mark、三个青色动态圆点和从左向右扫光的活动文字。用户最新要求改为单聊与群聊复用同一动态运行组件：组件位于聊天 transcript 内，内部左侧显示 Bot 头像组、右侧显示随最新活动更新的统一状态；单聊一个头像，群聊显示仍在思考或执行的成员，最多并排 3 个并显示 `+N`，有头像时不显示三点；整轮全部结束后整条状态隐藏。该组件是原版运行结构上的扩展，不宣称逐像素复刻；左侧会话栏运行头像动效继续保留。
- 目标位置与当前实现边界：Q68 明确运行行留在 transcript 内；Q69 又要求新气泡在稳定运行行上方自然增长、运行行本身不随新气泡移动。当前 `src/renderer/App.tsx` 的 `AgentRunningRow` 位于 `.chat-bottom-dock`，而该 dock 在 `.transcript-scroll` 外，属于 B11 未完成项。现有“运行态出现/退出时 dock 锚点不移动”的 Electron 断言只证明当前 dock 稳定，不能证明运行行已进入 transcript。
- 0.72.0 静态 CSS 精确证据：三点使用 `sand-message-typing__dot`，6px、4px 间距、`1.4s ease-in-out infinite`，延迟为 -0.32s/-0.16s，关键帧 `sand-cqmojk-B` 在 30% 时透明度 1、上移 2px；working 呼吸变体 `sand-1tmrjwl-B` 为 2.4s、透明度 .3 到 .9。文字使用 `sand-shimmer-text`/`sand-n9qfrr`，2.2s `steps(60,end)`，背景位置从 200% 到 -200%。`shimmerDuration=1400ms` 是常量表定义，不是实际扫光时长；Rambo 不使用头像外圈轨迹。
- 当前包内可见的时长参数包括 `runningSpinDuration=1200ms`、`shimmerDuration=1400ms`、`sweepDuration=2200ms`、`breatheDuration=2400ms`；前三者不能直接解释为运行行头像环轨、文字扫光或 working 头像动画。文字与三点按上方 0.72.0 精确 CSS 证据实现；Rambo 使用现有主题变量模拟，不引入原版受限字体或业务资源。
- 已核实活动短语包括 `Thinking it through`、`Searching the web`、`Reading the web`、`Running a few commands`、`Reading the file`、`Drafting the file`、`Working on it` 等。Rambo 按 Codex item 类型映射为对应的中文状态，并随最新活动切换。
- 本证据来自当前安装包静态分析；尚未用截图完成 0.75.0 的逐像素运行态对照。Rambo 本轮实现和自动化结果不等同 P02/B11 验收通过。

<a id="grok-0755-file-attachments"></a>

## 2026-10-24 文件附件卡片与查看器（0.75.5）

- 取证对象：`/Applications/Grok Bot.app/Contents/Resources/app.asar`，`CFBundleShortVersionString=0.75.5`，ASAR SHA-256 `12bba50ba6cf12b35132518788610677a3fdc65de4ad849628d757bc7b780e5a`。REA 静态证据 ID：`ev_3245453f7de9bad7fc0a173d481d841091778609be5e6a8fa7b0daeaf95cad49`；选取 renderer 依赖图解析，未运行原版应用代码。完整性差异在 native 文件；本节结论限于所选 renderer JS/CSS，分析图不是完整包语义图。
- 关键资源及 SHA-256：`chunk-file-stage-mU_GEQrA.js` `aa2bcb1c73b1331bc6560c153a5c6c5c8041896b9cb0a1f8bf1b7b7c56168d3c`；`chunk-fullscreen-file-viewer-body-CBmdYO3G.js` `aa5ee1e5175bd06f652613eec150c1685e184a6dc6f023ebc9f1580ef8d19f21`；`chunk-text-viewer-CSwZgF4y.js` `265e4bb6ad74e9bade9d3e6f16b2be800ba6c19b7b869c6d98551e783781d1ce`；`fullscreen-file-viewer-body-222A7KEi.css` `f191e369c6a4b39cbacb0476c1285d4b3a7d11d5fdbe4a90187275928e770032`。通用主题与原子样式来自 `index.eager-app-uZS5Ltig.js`（`2d39bd8661b7329abb8a470d9e0df12191fe164679c1ee4566324576839bedf3`）和 `index-CFSAhbDS.css`（`f427579fa76c117aaea459e52ef2340b2bb674b8ed3e02d292bad87cdd671a43`）。
- 聊天附件卡使用带 `data-attachment-card` 的 elevated surface，统一显示图标、标题、补充说明和附加内容。原子样式证据为 22px 圆角、16px 内边距、36px 图标、10px 项目间距与 40px 信息区高度；卡片背景取附件卡主题色，阴影组合为 0.5px 附件边线、1px/4px 次级阴影及 6px/12px 卡片阴影。悬停/键盘聚焦时显示尾部动作。
- 共享查看器由 `FullscreenFileViewerBody` 和 `sand-file-viewer__stage-chrome` 等组件组成；外壳有文件说明、工具栏/动作槽和内容区。静态分支包括图片/视频、PDF、Markdown/文本、HTML、JSON、DOCX 等。`FileStage` 中 Markdown 和表格走原生 stage，其余多种类型经 viewer seam 渲染。
- Rambo 按 Q101 复用附件卡片结构与核心尺寸；F05 范围内的图片、PDF、文本/Markdown、CSV 预览使用同一查看器外壳，音视频保留卡片内播放器。Word/Excel/PowerPoint 使用同款卡片，但仍交给本机应用，不引入 Grok 静态代码中的 DOCX 阅读器或其他 Office 内置预览。
- 以上是静态 JS/CSS 证据；本次没有取得 Grok 0.75.5 同尺寸运行截图。因此 Rambo 的对应 Electron 用例只证明实现可见和关键计算样式，不等于 P02 的逐像素视觉验收。

## 2026-10-24 连接应用市场

- 取证对象仍为上方记录的 Grok Bot 0.75.0 安装包（ASAR SHA-256 `1035db7b1f77974c78e6c18a4426a5fe16c639946335f7d57badfd0761971a5e`）。REA 静态分析证据 **ev_0464ce080dc88d965f5cd351231a746b20747afb79d6f1421ace2805666ffa3f** 覆盖市场页面、浏览模型、条目组件与 CSS 的选定依赖图；包内另有 9 项完整性差异，位于 native 二进制/可执行文件。本节结论只来自选定的 renderer 静态代码，不代表运行时观察。
- 关键原始文件 SHA-256：`chunk-view-vrpva6BS.js` `deed0dfedc9248384b47004cefa9fb47914a48eb5f93392bd1abef62a7a30e08`；`chunk-marketplace-browse-model-DANn5Th0.js` `7c734fb74b981b072d80c06a700bde8c0d9ee9a076587220988151b6e2308a41`；`chunk-plugins-rows-CWS6HPoT.js` `612910201cebb9d9c2ac8394a74d94bfaefed4c87b009fd44dad7fd2bd004323`；`chunk-connector-card-view-DwL1EWhR.js` `be2a3e79ae05083df766913a5361eadabd08d5bec0c89d6c3c9d4da5b764385e`；`chunk-connector-card-9IEFjdko.js` `1826efdb568ebaf35b1616b92fcb5d04d9bd2e74960a767eac0e515b7fca3f91`；`index-CEV-0tKx.css` `6684c20fc9dd98128c59b8daf69cf5ff8c272da03d77588e21c3b9462a1e8787`。
- 页面结构：顶部搜索和分类 chips；常用分类直接显示，更多分类收进下拉菜单；首页以分组展示条目，每组预览最多 6 项，超出才显示“查看全部”。条目为自适应双列列表，列间距 8px、行间距 2px；单项使用 40px 图标、名称/说明和尾部操作，12px 内边距、16px 圆角、默认无边框，悬停显示约 5% 主文字色底。Communication 下的 Email 分类优先显示。
- Rambo 的连接市场按此结构实现：搜索和分类筛选保留，首页把 Gmail 与 QQ 邮箱列在“推荐”，日历和 GitHub 列在“所有应用”并显示“即将推出”；其他 Provider 不进入目录。条目操作负责连接或进入管理，Bot Grant 在管理弹窗里调整。Provider 数量少于 6 的分组不显示空的“查看全部”。
- 四个保留 Provider 均使用官方图标资源。Gmail 来自 `https://www.gstatic.com/images/branding/product/1x/gmail_48dp.png`（SHA-256 `40694e42ed3dcfe16a0c5e6b6dec25f3446bf6fd7b7e2c60e3795513f33c9d98`）；QQ 邮箱来自 QQ 邮箱官网引用的 `https://res.wx.qq.com/t/webmail/webmail/res/images/qqmail_favicon_96h.8d124a7.png`（SHA-256 `ea5718ce82f326c827ac6de52bc2e759864650956062faa61fcaf61694d0ab6e`）；macOS「日历」图标由 `/System/Applications/Calendar.app/Contents/Resources/AppIcon.icns` 使用 `sips` 导出为 256×256 RGBA PNG（SHA-256 `ae592fb7654c4936a6b87b99a4deae52054e2beb7668df846bc87f18d0ae5565`）；GitHub Invertocat 来自 [GitHub Brand Toolkit](https://brand.github.com/foundations/logo) 的官方 `GitHub_Logos.zip`（SHA-256 `2a2f5cbcc74c7fa83c40127dd8b0e42c23f1157131aebe28492aa1ac27bbdc6d`）。本地副本位于 `assets/connectors/`。
- 四项图标均直接以固定 40×40 尺寸绘制；图标容器透明，无边框、圆角底框或阴影。
- 原版依赖图为部分静态视图，其余未选模块与原版运行时界面没有在本次取证中复核。Rambo 当前样式仍需后续通过同尺寸运行截图完成 P02 视觉验收。

## 2026-10-23 输入框、运行头像与发送过渡

- 私聊和群聊输入框移除模型下拉。全局模型与权限在系统设置管理；Bot 设置“会话配置”只管理该 Bot 唯一私聊的覆盖，群聊与 Routine 使用全局值；该入口调整属于 Q81，不改变 Grok 原版输入框的整体胶囊布局。
- 输入框保持同一聊天容器内的悬浮胶囊结构，补充聚焦层、圆角、内边距、阴影和按钮状态。私聊 Placeholder 为当前 Bot 名称的动态文案，群聊仍使用固定群聊文案。
- Loading 运行行内部头像自动播放，不跟随鼠标；左侧会话栏头像继续保留悬停跟随。两者是不同展示场景，不能因为“反跟随”而移除侧栏动效。
- 用户消息提交后、真实 `turn/start` 回包前，同一运行行显示“正在读消息”；收到回包或 `turn/started` 后切换为真实思考/判断/活动。该文案表达 Bot 已经收到消息并准备回应，不使用工程术语“启动本轮”，也不改变发送后立即清空的行为。
- 发送后输入框立即清空，用户与 Bot 新气泡在私聊、群聊中统一使用约 220ms 的淡入、轻微上浮与缩放恢复入场，不从输入框跨区飞入，也不创建动画克隆。历史加载、重新打开、流式 token 和状态更新不重播；Bot 阶段内容替换仍使用独立约 160ms 过渡。Host 在真实用户消息持久化后解除发送态，不等待模型回复；提交前失败恢复原文，提交后启动失败显示错误。该效果不改变原版消息结构。
- 以上实现曾通过定向类型、构建、后端和真实 Electron 发送/设置用例的旧基线；Q88 修改后的结果需按本轮检查重新登记。尚未完成逐帧、长文本、语音与停止按钮同场、窄窗口下的完整视觉对照，不能据此声明 P02/B11/S01 验收通过。

## 2026-10-22 菜单栏运行指示与 Dock 气泡移除

- Grok Bot 0.75.0 ASAR 的 `dist/electron-main/menubar-tray/assets/` 含 `brand.png`、`working.png` 及 `bot-<shape>-face.png`。脸图在 1x 下为 `522×18`、2x 下为 `1044×36`，主进程按 `18×18` 切帧；`main-app.cjs` 的 `startMenubarTray` 用 `Tray.setImage` 循环显示这些帧，空闲时随机生成眨眼和向左/右/上瞟视序列，忙碌 Bot 菜单项使用 `working.png`，并为有未读的 Bot 加标题计数。这是原生 macOS 菜单栏状态项，不是 renderer 内的仿菜单。
- Grok 的 Dock 状态代码可从 `qK`/`dockBadge` 与 `app.setBadgeCount` 确认，用于未读数量；静态包未证明 Dock 图标本身有逐帧脸部动画。Rambo 不伪造 Dock 图标帧动画，也按 Q74 不再显示 Dock 红色运行气泡。
- Rambo 的菜单栏资源在 `assets/branding/tray-frames/`：采用应用内原本的机器人圆头轮廓，配合用户参考图中的斜眼；源文件为 SVG，输出 18×18 PNG 与 36×36 `@2x` PNG，运行时按 18×18 pt 的 template 图像加载。眼睛必须透明镂空，系统才能按明暗菜单栏统一染色。空闲播放 `rest → 多次眨眼 → 随机左右瞟视 → rest`，运行态播放 `working-0..3` 四帧；菜单项中的运行 Bot 使用 working 图标。该实现参考 Grok 的 `Tray.setImage` 播放机制，按公开静态证据作本地资源等价模拟，不宣称为逐帧复制 Grok 的 Bot 脸。
- 菜单栏动画需要真实 macOS 运行目测确认；本轮只做了可注入状态机单测和构建检查。菜单栏在深浅色菜单栏下的可读性仍待真机复验；Dock 红色运行气泡已按用户要求移除。

日期：2026-10-20。证据级别：已安装包静态分析；另含主 Agent 通过 CUA 实际观察的运行时记录（1040×760、深色主题）。未将截图或 DOM 文件作为本地证据归档。

## 固定目标与取证边界

续验校正（2026-10-21）：下表早期“窗口工具栏右侧”描述不够明确，不能据此把导航按钮放到整窗最右侧。后续具体观察见 `acceptance-runs/20261021-full-01/evidence/P02-02-layout-epoch1.txt`：原版 1040×760 下三个按钮约 x=163、200、245，属于约 280px 宽的左侧栏顶部、交通灯右侧；旧 Rambo 在 x=993、1030、1067，构成已登记的 P02-02 差异。本校正解释原有证据，不新增产品要求；同尺寸完整像素对照仍未完成。

- 应用：Grok Bot 0.72.0，Bundle ID **com.anysphere.sand**。
- 包：/Applications/Grok Bot.app/Contents/Resources/app.asar，SHA-256 **2dd8dde660f466a2f305bbdbff14bf3256fd0489a64b4044da629dbbe0a493bf**。
- REA 摘要：ASAR inventory **ev_7ea1b92f6a00b711b71bc03a8b2ed495447d8c15f28087b150faa26c33ee07f0**；Electron/renderer 摘要 **ev_473c26323b0674de1e878f5251f40bda336b614501ffe28118f3737c6b4a32f4**，父证据 **ev_df121d8545bec00805c1477b72bbaa9e96dec85690364f9d49205ecde3626171**；Artifact inspect 摘要 **ev_36f8847f5381336c593d5ea2def2ac38a094acf70edec2646bfb1d5bd93fa4ef**。
- 完整包 inventory 为 953 个节点、875 个文件；发现 9 项完整性差异，均位于 native 二进制/可执行文件，不是本次选用的 renderer JS/CSS。静态分析覆盖了主 app 与 common 两个 JS 文件；其余 707 个文件未纳入 app source view。不能据此断言未检视的原生资源或运行时状态。
- 选用的原版文件、SHA-256、大小和提取片段均记录在 [grok-ui-0.72.0.json](evidence/grok-ui-0.72.0.json)；组件/CSS/font 参考副本位于 [reference/grok-ui/0.72.0](../reference/grok-ui/0.72.0/)。它们来自安装包，仅作只读证据，不能作为 Rambo 可执行代码导入。

## 已核实的结构和尺寸

| 区域 | 静态证据 | 可用于复刻的结论 | 仍待对照 |
| --- | --- | --- | --- |
| 主窗口外框 | dist/renderer/assets/index-CMR1RvAA.css：html/body 与 #root 均铺满窗口；body 无 margin，root 的宽高为 100%，shell 后代采用 border-box。dist/electron-main/main-core.cjs 中窗口最小值 512×520；另有未持久化 bounds 分支 1040×760。 | CUA 实测窗口为 1040×760；macOS 左侧仅原生红绿灯，窗口工具栏右侧有紧凑侧栏、搜索、新建 Bot 三个按钮。 | 未归档截图/DOM；标题栏精确高度与 macOS 控件区域像素范围未量测。静态 CSS 有 52/44/38px 多种栏高，不能确定默认高度。 |
| Bot 侧栏 / 空列表 | 主 app bundle 字符偏移 1,078,142 有 sand-agents-empty 分支；locale 另含 “No saved Bots yet”。Bot 列表项 avatar gap 8px、item radius 10px。 | CUA 实测侧栏约 280px，无 Rambo 横幅和 “Bots” 标题。Bot 行显示头像、名称及一行最近对话摘要；底部左为账号圆点、右为连接应用胶囊。Rambo 首屏无 Bot 时保持空白列表，创建入口打开真实 dialog。 | 约 280px 来自主 Agent 的运行时目测，未保存带标尺截图。Rambo 摘要使用 snapshot 已带的最近 chat title，没有读取各 chat 的 messages。 |
| 普通聊天 | 主 app bundle 字符偏移 2,106,192 有 sand-message transcript 行及用户连续消息/分组状态类；偏移 2,450,049 附近有 composer send / voice call / dictate 状态分支。CSS 有 agent/user bubble token、消息块 padding 7px、单行高度 36px、bubble radius 18px。 | CUA 实测主内容顶部居中显示头像+Bot 名称小胶囊；输入区为整条圆角胶囊，原版左侧 + 控件和右侧语音按钮需分别按附件/语音功能实现。Rambo 每 Bot 仅显示一个持续私聊，不提供新对话、聊天归档或删除；未实现的语音不显示。 | CUA 的气泡色是目测值；静态 dark theme token 是半透明色，最终颜色随背景合成。精确消息宽度、作者行、时间和运行状态变化仍需对照。 |
| Bot 创建 | 偏移 989,315 的 “Create a Bot” menu item 调用 onCreateBot(entrypoint)。主 bundle 的 bEt（2,431,138）渲染 `sand-create-bot-dialog`，rich variant、宽 440px；Body 顺序为 96px 头像预览、名称输入（maxLength 255）、shape/color picker、错误提示；ActionBar 是取消与创建。标题为“创建新 Bot”，无独立可见字段标题；输入 placeholder 为“给你的 Bot 起个名字”。 | 创建 dialog 的宽度、组件顺序和 picker 控件均有实际组件代码依据。当前可见基础 picker 为 13 种形状、11 种颜色；形状按钮 48px、内部图形 36px，颜色按钮 32px、色斑 24px；每行最多 5 个形状。原版每次打开 dialog 时生成 UUID，再按 UUID 计算默认形状与颜色；颜色从非黑色的 10 色中选取，因此实测的 star/brown 是一次随机结果，不是固定默认。 | 未取得运行时截图；不同窗口高度下的滚动与实际选中态待对照。renderer 输入使用原版 255 字符上限；Host 校验也应保持一致。源码同时设置了输入 `aria-label`（消息 id `RFtRvq`），CUA 观察记录的是没有单独可见字段标题。 |
| Bot 资料 | 偏移 1,227,423 有 “Bot name” 的 kind: name 可编辑行；偏移 1,232,731 有 “Bot description” 的 kind: description 可编辑/折叠行。另有 BotConfigureDialog 和头像编辑器真实模块。 | Bot 名称、描述、头像配置可沿用原生编辑器方向；原始模块保存在 reference。 | 原版该资料页与 Rambo 的模型/权限字段关系、字段顺序、弹窗完整尺寸需核对；不得把 Bot 配置弹窗误认为创建流程。 |
| 应用设置 | chunk-layout-TYnTblYW.js 导出 settings layout，传入 activeSection、sections、navFooter、onSelectSection、onClose；chunk-settings-row-DdAJprQS.js 是独立 settings row/control。 | 有真实设置导航和行控件组件证据，可据此实现设置壳。 | 页面默认 section、导航宽度、表单完整列表和实测状态未核实。偏移 2,876,881 的 appearance theme picker 是 app bundle 中的一段命令项代码，不能单独证明设置页布局。 |

## Token / 字体

来源均为 dist/renderer/assets/index-CMR1RvAA.css，完整源文件和摘要见 evidence JSON。

| 类别 | 已提取值 | 说明 |
| --- | --- | --- |
| Light palette | CSS 片段 offset 423,524：pane/elevated/luminous `#fff`；chrome `#fcfcfc`；sidebar `#f5f5f5`；elevated-hover `#f1f1f1`；primary `#1c1c1c`；hover `#1c1c1c0f`；active `#1c1c1c14`；agent bubble `#1c1c1c0f`、user bubble `#1c1c1c`。CSS SHA-256 见 sources。 |
| Dark palette（语义值推导） | 原 CSS 没有 `prefers-color-scheme` 规则，只有 light root token 组；Sand Dark 由 app bundle 字符偏移 554,971–567,779 的原语表、opacity 表和语义解析函数动态生成。dark pane `#161616`、chrome `#121212`、sidebar `#0e0e0e`、elevated `#1f1f1f`、primary/text `#f5f5f5`。Agent bubble token `#f5f5f50a`（4% alpha），user bubble `#f5f5f52e`（18% alpha）；合成在 pane 上约为 `#1f1f1f` / `#3e3e3e`，与 CUA 目测约 `#1c1c1c` / `#404040` 接近。opacity 使用原版 `round(percent × 255 / 100)` 换算。 |
| 字号 / 行高 | 11/12/13/14/15/17/22/26px；对应 line-height 16/16/18/20/22/24/28/32px。 | Sand 基础字号 14px、行高 20px；weight 400/500/600。 |
| Cursor 控件 token | 控件高度 xs/sm/base/lg = 20/24/28/32px；基础字体 13px；radius tokens 包含 2/4/6/8/12/14/16/18px。 | Sand 与 Cursor tokens 同存；具体组件会各自引用不同家族。 |
| 消息 | transcript block padding 7px，one-line 36px，bubble radius 18px；agent fill #1c1c1c0f，user fill #1c1c1c，用户文字为白色。 | 仅记录 source 中的 token 值，不推断当前主题渲染结果。 |
| 字体 | CSS 声明 XVF、XVF Mono variable font（weight 200–800）和 cursor-icons 字体；`:root` 正文字体栈引用 `var(--cursor-font-family-sans)`。 | 没有证据证明 XVF 是正文实际字体，因此本次不复制 XVF/XVF Mono 到 Rambo；renderer 继续用本机系统 sans 栈。原版字体资源路径与哈希记录在 evidence JSON 中，但没有复制到 reference 目录。 |

## 头像图形数据证据

头像绘图模板库有 26 种形状，顺序为 `blob, pebble, bean, egg, squircle, tablet, capsule, cylinder, hex, gem, crystal, wedge, shield, dome, arch, cloud, teardrop, leaf, square, sparkle, clover, flower, heart, house, star, pumpkin`；这 26 项用于渲染和旧头像解码，不等于创建 picker 的可选集合。创建 picker 的 13 个基础选项顺序为 `blob, cloud, square, sparkle, clover, heart, flower, teardrop, tablet, wedge, house, star, hex`，对应可见中文名“团块、云朵、方形、星芒、四叶草、爱心、花朵、水滴、药片、楔形、房子、星形、六边形”。原码允许将 feature-gated 项追加到基础数组；本次 CUA 观察到的是以上 13 项。颜色顺序为 black、brown、red、orange、yellow、green、cyan、blue、violet、magenta、gray。浅色主题下 picker 使用的实色分别是 `#000000`、`#a06b39`、`#fb2b3e`、`#fd690f`、`#f59312`、`#14c16f`、`#13b7a2`、`#1e86fc`、`#8f59f9`、`#f93498`、`#959595`。

原版没有独立静态 SVG 路径表，而是从 shape 定义和纯绘图函数生成头像。我们只隔离执行了该绘图依赖闭包，未加载应用模块、未启动 Grok、未访问遥测/云 API/网络；输出为包含原始静止姿态与眼部镂空的 SVG 模板。对应原版来源是平台 bundle SHA-256 `b9ebccdfb06c077fd51a9b10f336c8c3a732531958e9f8f9f233bcbee2991bf3`：形状定义 `dL` 字符偏移 613,091–615,158，shape canonicalizer `RG` 694,312–694,470，绘图 `GG` 694,894–695,335，头像组件 `KG` 695,335–695,406，静止姿态 `nF` 530,446–535,918。picker 原代码与参数见主 bundle 的 [picker 摘录](../reference/grok-ui/0.72.0/source-excerpts/avatar-shape-color-picker.js.txt) 和 [定义摘录](../reference/grok-ui/0.72.0/source-excerpts/avatar-picker-definitions.txt)；静态 SVG 的稳定副本为 [avatar-svg-paths.json](../reference/grok-ui/0.72.0/source-excerpts/avatar-svg-paths.json)，SHA-256 `2c044d1ac2f33d7030190a360a5763ecfb6b107a0ec4fc719b8964a2017bcd5b`。

renderer 用 `grok-avatar:v1:<shape>:<color>` 保存选择结果。原版 `Rre={shape:blob,color:black}` 是应用级 fallback；创建弹窗另走 `vEt → A/wA`，使用新 UUID 按原版 hash 选择 13 个基础形状之一，并从排除 black 的 10 色中选一种。因此不把某个形状/颜色写成创建弹窗的固定原版默认值。旧值仍以原符号头像渲染；打开头像设置时映射为 `spark → sparkle/magenta`、`orbit → blob/blue`、`leaf → leaf/green`、`sun → flower/yellow`、`moon → teardrop/violet`、`wave → cloud/cyan`，用户改选后保存新编码。Rambo 实际导入的本地代码仅含静态绘图数据，不引入原版含遥测或云 API 的业务脚本。

原版 `Bx/Vx/Hx`（主 app bundle 字符偏移 567,779–568,172）将棕/红/橙/黄/绿/青/蓝/紫/洋红的头像色映射到 Sand theme 的 `*-bright` token；因此 renderer 的 SVG 头像和颜色样本使用同一组 CSS 主题变量。light 下值见上，dark 下依次为 `#a16b39`、`#fc2c3e`、`#f9670e`、`#f69412`、`#14c370`、`#13b8a3`、`#1884fc`、`#905afb`、`#fb3499`。黑色 `#000000` 与灰色 `#959595` 是固定色。

## Renderer 首屏实施边界

本轮实现对应 Bot 列表、无 Bot 空态、新建 Bot dialog、普通 chat、消息输入/发送/停止、Bot 间聊天切换、基础 Bot 资料和设置入口。每 Bot 唯一私聊；输入区加号待附件功能接入，不用作新建聊天。无 Bot 初始状态必须由真实 snapshot 决定。头像选择器与图形数据按静态源码复刻；全量页面和功能仍按 P02/P08 验收，不以本基准替代验收。

当前 renderer 使用 CUA 实测约 280px 侧栏；窗口工具栏 44px、内容标题栏 48px、聊天列最大宽度 790px 属于实现尺寸选择。原版 CSS 有多个标题栏变体，精确值仍待同尺寸截图复核。Rambo 系统浅/深色跟随 `prefers-color-scheme`；原版 dark theme 值来自 JS 语义表推导，不是 CSS 中静态暗色变量。

