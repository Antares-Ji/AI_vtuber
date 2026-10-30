# Alpha 发布流程

## 正确的根目录

GitHub 仓库第一层应直接包含 `README.md`、`.github/`、`harness/`、`game/`、`fabric/`、`neoforge/` 和 `gradlew`。不要上传外层交付包、旧版本安装包、缓存、存档或个人配置。

如果从源码 ZIP 解压后还没有 `.git`，先在该目录执行 `git init -b main`。脚本要求这里就是 Git 顶层，防止意外使用父目录仓库。

## 验证与打包

环境：JDK 21、Python 3.10+、Git；首次构建需要网络。`gradle.properties` 的 `agent_version` 是唯一发行版本来源，独立核心和两个加载器共用它。发布时同步更新 README 和 CHANGELOG。

依次执行（Windows 将 `bash ./gradlew` 换为 `.\gradlew.bat`，`python3` 换为 `python`）：

```bash
python3 tools/check_repository.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
bash ./gradlew -p harness clean test installDist run --args='demo build/demo' --no-daemon
bash ./gradlew -p examples/collect-return :test :run --args='build/demo' --no-daemon
bash ./gradlew :harness:test :collect-return-example:test :fabric:build :neoforge:build --no-daemon
bash ./gradlew :neoforge:runGameTestServer --no-daemon
bash ./gradlew :fabric:runGameTestServer --no-daemon
python3 tools/package_release.py
```

不要并行运行独立核心构建与完整构建，它们共用 `harness/build/`。源码、扩展示例与安装包配套交付；打包器同时要求核心及外部示例测试报告通过。每个 GameTest 日志必须出现三个测试通过；打包器检查报告，但不能证明它们没有过期。源码改变后必须重跑对应检查，不要复用旧报告。

`dist/` 生成两个加载器安装包、对应源码 ZIP、验证 JSON 和 SHA-256 清单。正式 JAR 内必须包含 harness 核心及许可证，不能包含 GameTest 或旧 Numen 包。打包前检查 `git status --short`，上传源码中可以有 `.github/`，不能有 `.git/`、密钥或运行数据。

## GitHub 设置与预发布

1. 将仓库内容推送至自己的 GitHub 仓库；网页上传时也要包含隐藏的 `.github/`、`.gitignore`、`.gitattributes`。ZIP 是传输包，不能只把 ZIP 当作仓库源码上传。
2. 等待 Actions 的 `Build` 两个任务都成功。本地验证不能代替首次云端 CI。
3. 在仓库设置启用私密漏洞报告；如使用分支保护，将 `harness` 和 `build` 设为必需检查。
4. 对已经验证的提交创建 `v0.4.0-alpha.1` 标签和 Release，勾选 **Set as a pre-release**。
5. 附上本次 `dist/` 中的安装包、对应源码、验证 JSON 和校验清单。发布说明列出已验证与未验证范围。

本仓库不包含自动发布、推送或创建 Release 的工作流；上传与发布由仓库所有者执行。
