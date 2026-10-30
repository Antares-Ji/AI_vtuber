# 开发者接手指南

先从本页开始；[README](../README.md) 面向使用者，[HANDOVER](HANDOVER.md) 定位代码，[HARNESS](HARNESS.md) 定义运行契约。本仓库面向 Minecraft 1.21.1，当前为 Alpha。

## 第一次打开工程

1. 使用包含 `settings.gradle`、`gradlew`、`harness/` 的目录作为根目录，不打开外层交付包。
2. 准备 JDK 21、Git 和 Python 3.10+；Python 工具仅使用标准库，没有 pip 安装步骤。设置 `JAVA_HOME`，确认 `java -version` 输出 21。
3. 支持 Gradle 的 IDE 应导入根 `settings.gradle`，使用仓库 Wrapper，并将项目 SDK 和 Gradle JVM 都设为 21。`game/` 是共享源码目录，不是独立 Gradle 子项目。
4. `examples/collect-return` 是独立扩展示例，也由根构建作为 `collect-return-example` 子项目纳入。它有自己的 `settings.gradle`，可单独导入且无需 Minecraft。不要同时运行多个构建写入相同输出目录。
5. 只做核心开发时，可单独导入 `harness/settings.gradle`。不要同时打开两个构建并并发写入 `harness/build/`。

环境自查：

```bash
java -version
python3 --version
git rev-parse --show-toplevel
```

最后一项必须是当前工程根目录。如果从 ZIP 解压且尚无 Git 仓库，先在这里执行 `git init -b main`，避免使用上层目录的仓库。不要提交个人 IDE 配置、API Key 或测试存档。

## 第一次跑通

在根目录依次运行；Windows 使用 `python` 与 `.\gradlew.bat` 替代 `python3` 与 `bash ./gradlew`：

```bash
python3 tools/check_repository.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
bash ./gradlew -p harness test run --args='demo build/demo' --no-daemon
```

预期：仓库检查通过、工具测试通过、核心测试通过，演示输出 `simulation: true` 和 `VERIFIED`。首次 Gradle 运行需要网络下载依赖。此路径不启动 Minecraft，不调用真实模型。

核心测试报告：`harness/build/reports/tests/test/index.html`；演示记录：`harness/build/demo/mcplayeragent/runs/<UUID>/`。

## 根据改动选择验证

| 改动 | 必须执行 | 还需要判断 |
| --- | --- | --- |
| Markdown、开发配置 | 仓库检查；文档中新增或修改命令的验证 | 本地链接检查不验证外链和标题锚点 |
| `tools/` | 仓库检查与全部 Python 工具测试 | 修改打包行为还需实际生成并核查发行包 |
| 纯核心规则、调度、模型协议、公开扩展接口 | 核心全量测试与模拟闭环；扩展示例测试与演示 | 公共接口变化还需双加载器构建 |
| `game/`、加载器、Mixin | 核心测试、双加载器构建、两套 GameTest | 按影响补充客户端实测 |
| UI、输入接管、存档迁移、玩法 | 上述游戏验证 | 按 [EVALUATION](EVALUATION.md) 做真实客户端验证 |
| 发布版本 | [RELEASING](RELEASING.md) 的完整流程 | 不能用局部测试报告或旧日志替代本次发布验证 |

调试时可先跑一个类：

```bash
bash ./gradlew -p harness test --tests 'dev.mcplayeragent.harness.AgentHarnessTest' --no-daemon
```

这是局部验证；提交前按影响范围恢复全量测试，发布前必须执行完整流程。

扩展示例使用独立入口：

```bash
bash ./gradlew -p examples/collect-return :test :run --args='build/demo' --no-daemon
```

它只依赖核心公开接口，输出与测试范围见 [扩展指南](EXTENSIONS.md)。独立示例构建也会使用 `harness/build/`，与其他 Gradle 构建顺序运行。

## 构建与调试

```bash
bash ./gradlew :harness:test :collect-return-example:test :fabric:build :neoforge:build --no-daemon
bash ./gradlew :neoforge:runGameTestServer --no-daemon
bash ./gradlew :fabric:runGameTestServer --no-daemon
```

GameTest 必须顺序运行。客户端入口是 `:fabric:runClient` 或 `:neoforge:runClient`，分别使用对应加载器的 `runs/client/`；首次客户端启动可能需要下载额外资源。在开发实例的测试存档中工作。

核心演示可附加 Java 调试器：

```bash
bash ./gradlew -p harness run --debug-jvm --args='demo build/debug' --no-daemon
```

Gradle 的 `run` 任务会暂停并监听本机端口 5005，等待 IDE 的 Java Remote Debug 连接。没有连接前不会继续，这是调试行为。优先在 `AgentHarness.tick`、`complete` 和 `consumeReply` 设置断点。不同加载器客户端任务的调试选项应通过 `help --task :fabric:runClient` 或 `help --task :neoforge:runClient` 核对，不照搬核心任务参数。

## 日常修改约定

- Java 使用现有 `dev.mcplayeragent` 包、PascalCase 类型和 camelCase 方法；测试命名 `*Test.java`。Python 工具沿用 snake_case 和 `unittest`。
- `.editorconfig` 约束新编辑的编码、缩进与换行；保留相邻代码的既有风格，不把全仓库格式化混入功能 PR。原有紧凑 Java 排版尚未批量改写。
- `LICENSE` 与 `COPYING` 保留上游原文，`.gitattributes` 仅为这两个文件放宽末尾空行检查；其他文件继续使用正常的 Git 空白检查。
- 修改前找到调用方与对应测试。先添加能重现问题的测试，再修复最小行为；报告值、结构、副作用和错误类型。
- 不在 `harness` 导入游戏或加载器类型，不让共享服务端代码引用客户端类型。核心状态属于会话实例；Minecraft 客户端桥接仍有静态状态，详见 [HANDOVER](HANDOVER.md)。
- 新增依赖先说明用途与已有方案差异；确定性阈值、路由和重试写成代码，不交给模型决定。
- 变更公共行为时同步 README、HARNESS、CHANGELOG；只有重新验证后才更新 VALIDATION 中的结果。

仓库检查复用打包器的源码清单，拒绝上层 Git 仓库、敏感文件和运行数据，检查显式 Java import 与可随源码交付的 Markdown 本地链接。它是轻量检查，不解析完整 Java 依赖图、反射、同包隐式引用、Markdown 引用式链接或外部站点；代码审查和真实构建仍然必要。

## Git 与人工审查

本工程的早期开发来自本地提取快照，未恢复上游完整提交历史。交接基线之后，每个问题保留小而可解释的提交；建议使用 `fix:`、`feat:`、`docs:`、`test:`、`chore:` 前缀，不把这写成已存在的历史惯例。

```bash
git switch -c codex/short-topic
git status --short
git diff --check
git diff
```

确认改动后添加明确的文件，再提交。PR 写清触发条件、修改前后行为、验证命令、实际结果、未检查范围与回退方式。CI 是合并前证据的一部分，最终审查由维护者负责。AI 辅助生成的代码同样需要理解、测试和审查。

## 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 找不到 Java 21 或编译版本不符 | `JAVA_HOME`、`java -version`、IDE 的 Gradle JVM；不提交本机 JDK 绝对路径 |
| 根构建下载很多游戏依赖 | 核心工作改用 `-p harness`；完整游戏构建首次下载属于预期 |
| Gradle 输出相互覆盖、报告数量不符 | 停止并行的根构建与独立核心构建，然后重跑需要的全量测试 |
| 本地文档链接在 CI 失败 | 检查大小写和目标是否进入 Git 源码清单；生成目录不是源码链接目标 |
| 任务停止但以为成功 | 查看 `summary.json` 的 `state`、`end_reason`，区分 `VERIFIED`、`UNVERIFIED`、`INTERRUPTED` |
| GameTest 成功但游戏操作异常 | GameTest 只覆盖有限的原生拾取场景，继续按客户端复现步骤定位 |

下一步任务和验收条件见 [ROADMAP](ROADMAP.md)。
