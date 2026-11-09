# Rambo 名称与 Logo

2026-10-20 实施修正：用户指出未看到指定头像。将设置入口通用图标改为指定原图，并显式设置开发/打包模式 Dock 图标；各 Bot 的独立头像继续沿原配置。修正后重新打包并启动，实际显示状态按本轮观察记录。

确认日期：2026-10-20。依据：[Rambo 命名](decision-followups.md#q37-rambo)、[用户最新换图](decision-followups.md#q37-logo-v2)。

- 应用和项目名称：**Rambo**，保留用户输入大小写。
- 唤醒称呼：**Rambo**；此前支持问候语前缀的规则对应为“你好，Rambo”。实际口头识别效果待验证。
- 项目位置：`/Users/yuanjiawei/ai-coding/Rambo`。
- 应用 Logo：[圆角派生图](../assets/branding/app-logo-rounded.png)，由 [项目原图](../assets/branding/app-logo-source.png) 等比生成，使用透明圆角遮罩，不重绘原图内容。当前图为用户最新指定的《霓虹落日下的战士凝视》：黑发红头带战士侧脸，蓝紫、粉橙至黄色渐变背景；替换早先的卡通头像。
- 原始来源：`/Users/yuanjiawei/Downloads/霓虹落日下的战士凝视.png`。
- 项目素材相对路径：`assets/branding/app-logo-source.png`。
- 图片规格：PNG，1254 × 1254 像素。
- SHA-256：`fc527b8ebc1ae67cce4fb673ef49bc5613b2efb7d70e308d564e1240053ad37e`。
- 托盘/菜单栏 Logo：用户于 2026-10-31 最终确认使用红头带战士单色轮廓，并明确 Windows 也使用该图，均不播放动态效果，见 [Q220](decision-followups.md#q220)。唯一源图保存为 `assets/branding/tray-logo-source.png`，SHA-256 为 `f3323d77b7ad610a4ec75c7ba25e7ca6e49e626ebc741e80aecd33a5de96a2b7`。Windows 使用 `brand.png` / `brand@2x.png` 和 `brand-dark.png` / `brand-dark@2x.png` 两套静态黑/白轮廓，随系统浅色/深色主题切换；macOS 使用 `brand.png` / `brand@2x.png` 作为 template 蒙版，由系统自动着色。Dock 与应用包图标使用 `app-logo-rounded.png`；原始图保留为唯一未编辑源图。

`app-logo-source.png` 是原始文件的字节一致副本，Downloads 原件保持原位。2026-11-06 起按 [Q247](decision-followups.md#q247) 从原图生成 `app-logo-rounded.png`，仅处理透明圆角边缘；macOS `.icns` 和 Windows `.ico` 由该派生图生成。

托盘图是独立品牌素材，不替换上面的应用 Logo。旧机器人 SVG、眨眼/瞟视帧和 `working*` 已按用户要求清理，不再保留在当前项目中；历史决定仅记录在 [Q80](decision-followups.md#q80)。

应用图标与各个 Bot 的头像是两层设置，Bot 预置/上传/生成头像功能继续按 I03 实现。

历史名称 cobo、伟哥及旧图标提案保留在补充问答中，仅作变更依据，不作为当前名称或默认唤醒词。

## 换图历史

2026-10-20 用户要求“那个头像换成这个”，提供《霓虹落日下的战士凝视.png》，当前按 Rambo 品牌头像／Logo 源图替换，不改名称、唤醒词或所有 Bot 的独立头像配置。早先卡通头像保留为 [历史素材](../assets/branding/archive/app-logo-source-v1.png)，其 SHA-256 为 `a2c121e2a4430a4549a0da5ce78dcd78c5be1306d35549066b3840e245a9f0b3`，不再作为当前图。
