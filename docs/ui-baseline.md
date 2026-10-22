# Grok Bot UI 基准（0.72.0）

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

