# 机器人眼部动作开源参考

日期：2026-10-23。范围：核对五个机器人表情项目的官方 GitHub README、源码、许可证与作者演示入口。本报告是技术资料调研，不新增或修改产品决策。以下三项由研究子 Agent 核对，末尾两项由主 Agent 核对；本轮未使用 Computer Use。

星标数取本日 GitHub 仓库页面显示值，数字会变化。源码快照为本轮只读拉取时的仓库 HEAD。演示链接来自仓库作者维护的 README；本轮没有播放 YouTube 视频。`kaia.ai` 示例应用链接通过本环境的 HTTP HEAD 检查返回 404，不能据此断言所有网络环境都不可达。

## 概览

| 项目 | GitHub Stars（约） | 许可证 | 可否在浏览器直接运行 | 作者演示 |
| --- | ---: | --- | --- | --- |
| [FluxGarage/RoboEyes](https://github.com/FluxGarage/RoboEyes) | 917（约 900） | GPL-3.0 | 否。Arduino/C++，依赖 Adafruit GFX 显示驱动 | [演示视频](https://www.youtube.com/watch?v=ibSaDEkfUOI)、[入门视频](https://www.youtube.com/watch?v=WtLWc5zzrmI)；README 有链接，视频未播放 |
| [kaiaai/kaia-face.js](https://github.com/kaiaai/kaia-face.js) | 21（约 20） | Apache-2.0 | 是，面向浏览器的 JavaScript/Canvas API；需要 Fabric.js 等宿主运行环境 | [示例应用](https://kaia.ai/view-app/5a0556a554d7fc08c068f3b7)（本环境返回 404）；[样例源码](https://github.com/kaiaai/sample-apps/tree/master/face-animation) |
| [ggldnl/Procedural-Expression-Library](https://github.com/ggldnl/Procedural-Expression-Library) | 23（约 20） | GPL-3.0 | 否。C++/Arduino 与 OLED 像素绘制 | README 嵌入[仓库 GIF](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/media/animation.gif)；没有外链视频 |

## FluxGarage/RoboEyes

这是三者中星标最多的仓库。快照为 `b42f8e5`（2026-01-20）；仓库介绍明确目标是用 Adafruit GFX 在 OLED 上绘制机器人的眼睛。[README](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/README.md) 提供两条 FluxGarage YouTube 演示链接，但本轮只确认 README 中存在链接且视频地址返回 HTTP 200，没有播放视频或据此描述画面。

可借鉴的动作与算法：

- 每帧将眼睛当前值向目标值收敛，例如高度按 `(current + next) / 2` 更新，宽度、位置、圆角也有同类缓动；这是一种简短的状态平滑方式，适合参考“眼睛先变、再稳定”的节奏。[`FluxGarage_RoboEyes.h`](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/src/FluxGarage_RoboEyes.h#L523-L549)
- `setMood()` 提供疲倦、生气、开心、默认等表情。实现以眼睛本体加上三角遮罩形成上眼睑或下眼睑，且遮罩高度自身也逐帧收敛；这比把整只眼睛统一缩放能表达更多眼睑形态。[源码](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/src/FluxGarage_RoboEyes.h#L650-L690)
- `blink(left, right)` 可单独控制左右眼；自动眨眼和 idle gaze 各自设置基础间隔及随机变化，idle 时眼睛转向随机屏幕位置。[眨眼 API](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/src/FluxGarage_RoboEyes.h#L440-L486)；[自动动作](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/src/FluxGarage_RoboEyes.h#L567-L613)
- 混淆和大笑分别以水平、垂直交替位移来抖动；`curious` 会在注视屏幕左右边缘时放大外侧眼睛高度。[源码](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/src/FluxGarage_RoboEyes.h#L493-L505)

README 中的[无 `delay()` 动画序列示例](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/examples/i2c_SSD1306_AnimationSequences/i2c_SSD1306_AnimationSequences.ino#L38-L82)把睁眼、开心/大笑、疲倦等动作按计时事件编排，适合作为状态切换和节奏安排的参考。

许可证为 [GPL-3.0](https://github.com/FluxGarage/RoboEyes/blob/b42f8e596535234932be3514ac7a813d4ced0046/LICENSE.txt)。源码不能直接作为浏览器组件使用；移植时需要把 Adafruit GFX 绘制调用映射到目标绘图层，并单独评估 GPL-3.0 的代码复用条件。

## kaiaai/kaia-face.js

这是三者中最直接面向浏览器的项目，仓库 README 展示 `<script src="kaia-face.min.js">` 用法、表情切换、视线控制和动作 API。[README](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/README.md#L7-L18) 列出 32 种表达和示例。快照为 `2d40223`（2024-03-14），距本次调研较久，运行状态需以实际环境复核。

值得参考的动作类别包括：环形路径 eye-roll、tear-drop 水滴、snoozing 的 Z 字、上部/下部起伏与抽动，以及 `bounce`、`jelly`、`swoosh`、`splat` 等动作效果。`eye-roll` 用角度和圆周坐标更新眼睛元素位置；tear-drop 会创建单独的 Canvas 路径并让它下落；`jelly` 用弹簧状态分别驱动横纵缩放。[动画源码](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/animationModule.js#L95-L125)；[eye-roll 与 tear-drop](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/animationModule.js#L158-L208)；[弹簧效果](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/animationEffectModule.js#L22-L102)。

与“眨眼只是缩放”的反馈直接相关：该库默认 `blinking` 仍是把眼部图像的 `scaleY` 压低后恢复；`wink` 也采取相同的纵向缩放。上眼皮起伏和 eye-roll、泪滴等提供了不同动作，但单独采用它的默认 blink 不能解决动作都像同一套缩放的问题。[眨眼实现](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/animationModule.js#L65-L79)；[wink 实现](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/animationModule.js#L127-L140)。

浏览器运行边界：README 声明了浏览器用法，但实现通过 `fabric.StaticCanvas` 创建画布，并使用 `fabric.Image`、`fabric.util`、`requestAnimationFrame` 等全局能力。[浏览器能力检查与 Canvas 创建](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/main.js#L26-L50)；[Canvas 实例化](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/main.js#L535-L553)。`package.json` 只列出 jQuery 依赖，构建脚本未把 Fabric.js 加入源码拼接；因此 README 的单个 `<script>` 片段不足以证明构建产物包含完整运行时，接入页还需提供 Fabric.js。表情资源主要是按表情拆分的 PNG 眼睛图片，不是 SVG path 动画。[表情资源定义示例](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/src/js/main.js#L91-L115)；[`package.json`](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/package.json)；[构建配置](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/gulpfile.js#L18-L45)。

许可证为 [Apache-2.0](https://github.com/kaiaai/kaia-face.js/blob/2d40223581a3cdf1ed31d9aaeb87134f47c26408/LICENSE)。作者 README 提供的[在线示例](https://kaia.ai/view-app/5a0556a554d7fc08c068f3b7)在本轮通过 HTTP HEAD 返回 404；[样例源码入口](https://github.com/kaiaai/sample-apps/tree/master/face-animation)仍列在 README 中，但本轮未检查该示例的部署状态。

## ggldnl/Procedural-Expression-Library

该仓库 README 自称 proof of concept，并明确说现有实现计算和内存开销较大。快照为 `76d1d9d`（2024-09-26）。它提供的核心算法最贴近“改变眼形轮廓”这一方向：用 8 个 `[0,1]` 归一化顶点定义眼睛形状，可左右眼分别定义以表达不对称；从当前多边形逐点插值到目标多边形，眨眼则插到一条扁平矩形再恢复。渲染时遍历包围盒像素并用点在多边形内判断决定点亮哪些像素。[README 算法说明](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/README.md#L12-L18)；[多边形插值与像素包含判断](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/polygon.cpp#L24-L77)。

表情点集和 blink 目标位于 [`expressions.h`](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/expressions.h#L28-L85)；逐帧插值、视线点移动和两阶段 blink 位于 [`gui.cpp`](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/gui.cpp#L148-L230) 及 [blink 入口](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/gui.cpp#L304-L325)。当前默认表情插值 4 步、眨眼 2 步；这是面向小型 OLED 的低分辨率实现，帧数和像素遍历方式不能直接视为桌面 SVG 动画的现成实现。

仓库 README 内嵌 [`media/animation.gif`](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/media/animation.gif) 作为演示资源；本轮确认了资源文件和 README 引用，但没有逐帧观看。许可证为 [GPL-3.0](https://github.com/ggldnl/Procedural-Expression-Library/blob/76d1d9d1788284162ce1c8993a05edbd6b84706e/LICENCE.md)。项目源码使用 Arduino/C++ 与 SH1106 OLED 显示接口，不能直接在浏览器运行。

## 对现有 SVG 头像的适配观察

以下仅比较源码与现有浏览器头像场景的距离，不构成实现选择或产品决定：

- 若要从“整眼缩放”转向轮廓变化，Procedural-Expression-Library 的归一化点集和逐顶点插值最有参考价值；但实现本身是 GPL-3.0、Arduino 像素渲染，适合研究算法，不能直接搬进浏览器组件。
- 若需要眨眼之外的动作节奏，RoboEyes 展示了随机间隔、idle gaze、独立左右眼、遮罩眼睑和水平/垂直抖动；它星标最高，但需要移植绘图/计时逻辑且是 GPL-3.0。
- 若优先看浏览器 API 和动作清单，kaia-face.js 最接近前端运行环境、Apache-2.0，但底层依赖 Fabric.js Canvas 和栅格表情资源；其默认 blink 仍使用 `scaleY`，且本轮作者在线 demo 返回 404。

源码快照：RoboEyes `b42f8e596535234932be3514ac7a813d4ced0046`，kaia-face.js `2d40223581a3cdf1ed31d9aaeb87134f47c26408`，Procedural-Expression-Library `76d1d9d1788284162ce1c8993a05edbd6b84706e`。本轮未改头像代码，未运行 UI 或测试，也未修改产品决策。

## Agent Robot Avatar：优先参考具体动作

[官方仓库](https://github.com/CX-ArtLab/agent-robot-avatar)，本轮 GitHub 页面约 55 stars；[作者演示入口](https://cx-artlab.github.io/agent-robot-avatar/?lang=en)。采用 SVG 与原生 Web Component，许可证为 [MIT](https://github.com/CX-ArtLab/agent-robot-avatar/blob/main/LICENSE)。本轮通过 raw.githubusercontent.com 读取入口和两个动作模块，没有运行或观看动态演示；演示页面无法由本轮 web 工具提取，不据此判断用户浏览器可达性。

与现有动画相比，值得参考的是两个有完整动作过程的模块：

- [`agent-robot-avatar-love.js`](https://github.com/CX-ArtLab/agent-robot-avatar/blob/main/src/agent-robot-avatar-love.js)：分别改变两只眼睛的姿态，使其向中间靠合成心形，默认保持三个心跳再恢复。源码将准备、变形进入、心跳、变形退出分别计时；不是简单的统一开合循环。
- [`agent-robot-avatar-random.js`](https://github.com/CX-ArtLab/agent-robot-avatar/blob/main/src/agent-robot-avatar-random.js)：两眼像老虎机滚筒绕水平轴滚动。根据角度用正弦计算位置、余弦计算可见高度；左眼先减速、越过停止点并阻尼回弹，右眼延迟收尾。具有加速、匀速、减速和落定四个阶段。

这是对动作结构与许可证的核对，不是动画审美验收。项目自己的机器人头部、天线和完整造型不符合用户的透明背景眼睛头像，不能把直接引入整个组件当作已满足需求。若继续实现，可以把该 MIT 项目的具体动作代码作为适配对象，并保留归属声明；仍要适配原图眼睛、眼白填色、日夜主题和悬停/Loading 生命周期。心形、滚筒属于候选参考，并非用户已接受的新动作。

## Aora Bot / Emotion Ball：表情轮廓参考，许可证受限

[官方仓库](https://github.com/sam70361/aora-bot)，本轮 GitHub 页面约 552 stars；[作者在线表情馆](https://emotion-balls.vercel.app/)。本轮读取 README、`rings.js`、`emotions.js`、`ball.js`、`engine.js`，没有运行或观看动态演示。在线站点无法由本轮 web 工具提取，不据此判断用户浏览器可达性。

- [`rings.js`](https://github.com/sam70361/aora-bot/blob/main/emotion-ball/js/rings.js) 与 [`emotions.js`](https://github.com/sam70361/aora-bot/blob/main/emotion-ball/js/emotions.js) 提供多组眼睛轮廓和 32 种状态配置。不是每个状态只调整同一个椭圆的宽高；表情可从不同轮廓池切换，并配置左右眼不同动作、视线抖动、扫描和进入状态时的关键帧。
- [`engine.js`](https://github.com/sam70361/aora-bot/blob/main/emotion-ball/js/engine.js) 中 `springStep`、`_ringSpring` 与 `lerpRing` 控制从当前眼睛轮廓到目标轮廓的插值；[`ball.js`](https://github.com/sam70361/aora-bot/blob/main/emotion-ball/js/ball.js) 根据当前点集更新 SVG path。适合研究“先设计表情关键姿态，再做连续形变”的组织方式。
- 根据[作者许可说明](https://github.com/sam70361/aora-bot#许可)与[LICENSE](https://github.com/sam70361/aora-bot/blob/main/LICENSE)，视觉形象有禁止商业使用的限制，引擎和表情配置为非商业免费、商业需另获授权。它是公开源码的参考项目，不能标为 MIT 或无条件可复用的开源依赖，也不能通过只拷贝配置数据规避授权。

建议先由用户查看作者演示，判断其轮廓变形风格是否更接近期望；不直接把受限代码或表情数据纳入 Rambo。通用动画库的 Star 数不能替代具体表情设计质量。
