# 托盘图标资源

Windows 在浅色系统栏读取黑色 `brand.png`（18×18）与 `brand@2x.png`（36×36），在深色系统栏读取白色 `brand-dark.png`（18×18）与 `brand-dark@2x.png`（36×36）；主题变化时静态切换，不播放动画。

macOS 读取黑色 `brand.png` / `brand@2x.png` 作为 template alpha 蒙版，由系统按菜单栏浅色/深色自动着色，不需要另一套文件。

唯一源图位于 `../tray-logo-source.png`。派生图裁掉透明边并等比适配到 18×18 / 36×36，只保留最终轮廓；黑白 Windows 变体共享同一透明度。

`*.svg`、`00-*` 至 `16-*` 与 `working*` 是 Q80 时期的机器人托盘动画资产，仅保留为历史素材，不再由应用读取，也不进入安装包。
