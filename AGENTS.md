# 项目工作入口

- 开始功能讨论、技术设计、实现或审查前，先读 `docs/product-decisions.md`，以稳定编号引用已确认规则。
- 核对用户确认、历史方案或相互冲突的说法时，沿该文档链接读取 `docs/conversation-evidence.md` 对应问答；已确认的问题按记录继续推进。
- 用户接受新决定或修改旧决定后，在当轮更新决策记录和依据。助手建议、参考产品行为与技术可行性各按文档中的状态记录。
- 用户于 2026-10-20 明确“开始吧”，当前进入实现阶段；既定功能范围与全量验收标准继续有效。子 Agent 默认 Luna / max，按需启用，避免重复研究与高阶模型消耗。
- 开发 Agent 改完代码后先运行 `node scripts/change-checks.mjs`，列出本轮命中的模块、必跑检查和未选原因；合并去重后只执行相关项，不默认运行全套。映射在 `tests/change-checks.json`；Agent 可补充，放宽或删除现有门禁须用户明确同意。真实 Electron 流程、完整验收和发布检查按触发条件升级；真实设备、系统原生和外部副作用仍按风险独立复验。
- 测试、缺陷闭环和发布验收使用 `.agents/skills/rambo-acceptance/SKILL.md`。确定性机器结果可单次登记，最终发布仍须覆盖全部产品决策，不以局部成功替代完整交付。
- Agent 或连接器为运行时生成、需要后续按本机路径读取的临时媒体和资源，统一放入 `<userData>/composer-attachments`，不要复制到仓库工作区、桌面或长期资料目录，也不要把媒体 base64 写回 Tool 输出或聊天正文。该目录不是长期缓存；`pasted-image-*` 与 `wechat-media-*` 按现有 7/30 天规则清理。新增其他临时文件类型时，必须同时接入 `composer-attachment-cleanup` 的目标命名、权限和清理测试，不能只写文件不接清理；凭证、密钥和不可恢复数据不得放入该目录。
- 本地只保留活动应用 `/Applications/Rambo.app`，不为覆盖安装或版本更新保留 `.app` 备份、`backup`/`replaced` 副本或 `~/Library/Application Support/Rambo/install-backups`。用户于 2026-10-27 明确不需要应用备份；安装前正常退出并核验待安装包，替换失败即停止，不以预存旧应用作为回滚手段。Git 与 GitHub Releases 仍是版本归档来源，应用数据目录不属于应用包备份，不得因此删除。
