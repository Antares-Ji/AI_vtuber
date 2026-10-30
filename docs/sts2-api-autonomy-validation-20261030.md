# 导演控制台的原生视觉自动执行链

本次约束：游戏决策由角色 API 产生，画面事实由本地模型 API 读取，键鼠由项目原生 API 执行。开发助手负责启动任务、检查记录和修复程序，不代替角色选择卡牌、输入坐标或操作游戏。

## 入口与架构

```text
导演控制台 /studio.html#game-input
  → POST /api/skills/run（sts2:native-play）
  → Skill Host：任务、取消、预算、桌面资源互斥
  → 原生自主循环
      → /api/game-input/action：取得游戏客户端截图
      → /api/game-input/read-card → 本地 Qwen HTTP 服务
      → DeepSeek 角色决策 API：依据当前目标 ID 提议动作
      → 当前帧、能量、牌面、目标校验
      → /api/game-input/action：项目原生 Win32 键鼠
      → 下一帧重新观察，反馈上一步结果
```

统一 Skill Host 承接原有执行器。原 ZIP 的 Java 核心、Loader、Harness 和示例保持独立；本次没有改动其架构。原生视觉路径仅依赖共享的角色 API 设置，不再因读取配置而加载 STS2 MCP 客户端。MCP 模式仍保留自己的适配器和既有测试。

## 实测发现与修复

- 原始视觉会输出“手牌1”等泛称，角色曾据此推测牌名、费用和伤害。现在只有当前帧的完整牌名、费用、类型和描述通过校验后才允许拖牌；未知牌允许悬停，拒绝直接出牌，并把拒绝原因交给角色 API 重新规划。
- 战场和手牌分开读取。手牌裁剪坐标映射回原始客户端图像，不直接当作整图坐标使用。
- 悬停会把卡牌向上抬起。悬停后的手牌识别扩大纵向范围，并按悬停列裁剪读取完整牌面。同名、同费且位置匹配的唯一目标才能关联本帧牌面；有歧义时不关联。
- 提示词中的示例文字可能被小模型照抄。读取提示改为字段说明；无效输出保留原始模型记录，不能转换为假坐标。
- 完全相同的目标事实和坐标可合为一个候选；同坐标但内容冲突仍失败。格式无效的分区识别最多重试一次，之后停止。
- 等待也进入角色历史，避免下一次决策不知道自己已经等过。停止一个已经结束的任务不再把最终状态改成“正在停止”。
- 角色请求包含按实际执行校验生成的可用动作摘要，明确哪些牌已经读清、可拖向哪些目标。摘要提供合法候选，最终选择仍来自角色 API。
- 停止入口仍直接调用执行器，统一任务同时收到取消请求；任务释放资源之前仍保持互斥。

## 证据与状态

本机运行时记录位于 `runtime/game-input/autonomy/*.jsonl`、`runtime/game-input/learning/vision-*.json` 和 `runtime/game-input/runs/`，未作为模型训练完成的证据。视觉结果保留 `unverified_local_model_output`，原生输入回执只表示输入已经执行；效果必须由后续画面确认。

2026-10-30 的实测已经确认控制台经统一 Skill 启动任务、实际调用本地 Qwen3-VL-4B-Instruct/NF4、实际调用 DeepSeek（返回模型名和 usage），并由原生 API 执行模型决定的悬停。运行 `1793389565589` 的本地视觉记录 `vision-1793389689268385300.json` 成功读出完整牌面并关联当前帧；随后一次执行因游戏失去前台停止，没有将计划冒充游戏结果。早期运行分别暴露坐标格式无效、重复目标及悬停后裁剪丢失牌名的问题。修复后的持续战斗验证仍在进行；不能据此宣称本次已经通关，也不能宣称 MC 或 BetterGI 的实机链路通过。

本次没有进行权重训练。此前保存的杀戮尖塔经验、卡牌记录、MC 资料和 BetterGI 探索内容继续保留。

## 验证命令

```text
node --test tests/native-autonomy.cjs tests/skills-runtime.cjs tests/skills-api.cjs tests/sts2-tactics.cjs tests/sts2-learning.cjs integrations/sts2-mcp/test.cjs
node --test tests/skills-*.cjs tests/genshin-framework.js tests/sts2-deepseek-fetch.cjs tests/game-input-console.js
python tests/test_native_vision_schema.py
```

视觉模型需要本机已有权重和 GPU 环境。单元测试使用受控的观察和 API 回执验证边界，不代表真实游戏已经完成。

本次完整 Node 整合回归 68/68、坐标与手牌归一化 3/3 通过；原 ZIP 字节一致性、151 个来源文件保留清单及 17 项上游仓库检查通过。原源码只有之前记录的测试等待补丁，本次没有新增改动。
