# Rambo 名称与 Logo

2026-10-20 实施修正：用户指出未看到指定头像。将设置入口通用图标改为指定原图，并显式设置开发/打包模式 Dock 图标；各 Bot 的独立头像继续沿原配置。修正后重新打包并启动，实际显示状态按本轮观察记录。

确认日期：2026-10-20。依据：[Rambo 命名](decision-followups.md#q37-rambo)、[用户最新换图](decision-followups.md#q37-logo-v2)。

- 应用和项目名称：**Rambo**，保留用户输入大小写。
- 唤醒称呼：**Rambo**；此前支持问候语前缀的规则对应为“你好，Rambo”。实际口头识别效果待验证。
- 项目位置：`/Users/yuanjiawei/ai-coding/Rambo`。
- 应用 Logo：[项目原图](../assets/branding/app-logo-source.png)。当前图为用户最新指定的《霓虹落日下的战士凝视》：黑发红头带战士侧脸，蓝紫、粉橙至黄色渐变背景；替换早先的卡通头像，按原图使用。
- 原始来源：`/Users/yuanjiawei/Downloads/霓虹落日下的战士凝视.png`。
- 项目素材相对路径：`assets/branding/app-logo-source.png`。
- 图片规格：PNG，1254 × 1254 像素。
- SHA-256：`fc527b8ebc1ae67cce4fb673ef49bc5613b2efb7d70e308d564e1240053ad37e`。
- macOS 菜单栏状态图标：用户于 2026-10-23 指定小机器人斜眼，并明确脸型使用应用内原本的机器人圆头而非参考图正圆、图标尺寸要适配菜单栏、颜色交给系统统一染色，见 [Q80](decision-followups.md#q80)。本地 SVG 设计源与动画帧位于 `assets/branding/tray-frames/`，输出 18×18 PNG 和 36×36 `@2x` PNG，运行时按 18×18 pt 的 template 图像加载；眼睛使用透明镂空。Dock 应用图标仍使用上述战士 Logo。

该素材是原始文件的字节一致副本，不是重新生成或编辑后的图。Downloads 原件保持原位。具体 macOS 图标尺寸资源和应用包图标接入在实现阶段处理，最终视觉按 P02/全量验收矩阵复核；本轮没有编写应用代码或声称已完成打包。

应用图标与各个 Bot 的头像是两层设置，Bot 预置/上传/生成头像功能继续按 I03 实现。

历史名称 cobo、伟哥及旧图标提案保留在补充问答中，仅作变更依据，不作为当前名称或默认唤醒词。

## 换图历史

2026-10-20 用户要求“那个头像换成这个”，提供《霓虹落日下的战士凝视.png》，当前按 Rambo 品牌头像／Logo 源图替换，不改名称、唤醒词或所有 Bot 的独立头像配置。早先卡通头像保留为 [历史素材](../assets/branding/archive/app-logo-source-v1.png)，其 SHA-256 为 `a2c121e2a4430a4549a0da5ce78dcd78c5be1306d35549066b3840e245a9f0b3`，不再作为当前图。
