# 参与开发

本项目处于 Alpha：先解决可复现问题，API 和配置格式暂不承诺稳定。提交 Issue 或 PR 前请阅读 [项目边界](docs/PROJECT.md) 与 [行为准则](CODE_OF_CONDUCT.md)。

新增技能请从 [扩展指南](docs/EXTENSIONS.md) 和 [可运行示例](examples/collect-return/README.md) 开始。公开 API 的破坏性变更必须提供迁移步骤。

完整环境、IDE 与调试步骤见 [开发者接手指南](docs/DEVELOPMENT.md)，按需求定位源码见 [架构导航](docs/HANDOVER.md)。

## 开始

需要 Git、JDK 21；打包工具测试需要 Python 3.10+。从你的克隆或解压目录进入包含 `settings.gradle` 和 `gradlew` 的根目录。

```bash
python3 tools/check_repository.py
bash ./gradlew -p harness test run --args='demo build/demo' --no-daemon
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

Windows 使用 `.\gradlew.bat` 与 `python`。首次构建需要网络。

- 纯规则、计划、会话调度放在 `harness`，不得依赖 Minecraft。
- 游戏操作放在 `game`，加载器入口保持薄层；先读 [线程与回执约定](docs/HARNESS.md)。
- 用户目标、实体操作和服务器回执要有明确边界；模型说完成不能直接成为成功结果。
- 修改行为时补充针对失败原因的测试，避免只测“没有抛异常”。
- 不提交存档、API Key、原始模型推理、个人路径和未脱敏日志。
- 保留 LGPL 及来源说明，提取或迁移代码时维护 `provenance.json`，不要将历史快照哈希改成当前文件哈希。

## 验证与提交

完整构建：

```bash
bash ./gradlew :harness:test :collect-return-example:test :fabric:build :neoforge:build --no-daemon
```

改动游戏代码、拾取钩子或加载器后，按顺序运行：

```bash
bash ./gradlew :neoforge:runGameTestServer --no-daemon
bash ./gradlew :fabric:runGameTestServer --no-daemon
```

客户端 UI、输入接管与长任务需要额外游戏实测。PR 写清问题、行为变化、执行过的验证及未检查范围，不把编译通过写成玩法可靠。每个 PR 保持单一目标；大范围设计变更先开 Issue 说明方案与取舍。

报告问题请提供版本、加载器、Java 版本、最小复现步骤、预期与实际结果，以及脱敏后的日志片段。安全问题按 [SECURITY.md](SECURITY.md) 处理。
