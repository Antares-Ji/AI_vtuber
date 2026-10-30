# 配置与技能扩展 v0.4 Alpha

目标：开发者通过公开接口新增技能，不修改 harness 或游戏内部实现。当前支持可信 Java 扩展与配置文件；这是以 Minecraft 为首个环境的扩展入口，尚未实现跨环境通用协议、插件市场或隔离执行。

## 配置一个 Agent

现有文件仍为游戏实例的 `config/mcplayeragent/client/player-control.json`，不增加第二套用户配置。参见 [示例配置](../examples/profiles/collector.json) 与 [JSON Schema](../schemas/agent-profile.schema.json)。示例的模型名需替换为本机实际模型；复制前保留原配置副本。

字段：`schema_version`、`backend`、`endpoint`、`model`、`prompt`、`chat_summary`、`limits`、`enabled_skills`。API Key 保留在既有凭据文件或环境变量，不写入 profile。任务目标继续按存档保存。

- 缺省字段沿用现有默认值；没有 `schema_version` 的旧配置按 v1 读取。缺失文件使用默认值，文件损坏、权限错误、未知字段或非法类型会阻止接管，不静默忽略。
- 优先级为默认值 → 文件字段 → 显式 `AgentProfile.withOverrides` 覆盖。`limits` 按字段合并，数组整体替换。Java 宿主可以传入本次覆盖；游戏 F8 模型设置页保存的字段是持久修改，会保留未在面板展示的预算与技能选择。任务页只保存存档目标并读取当前配置，不将缓存的模型设置写回文件。
- `enabled_skills: ["*"]` 为默认值，允许所有已注册技能；`[]` 不允许从注册表启动技能。显式列表必须使用完整 ID，未知 ID 会阻止启动。
- 选择作用于注册表调用，包括经注册表调用的子技能。父技能需要哪些依赖由其说明声明；缺少依赖会显性失败，当前没有自动依赖求解。内置技能内部的原生操作、直接构造的子任务及本地生存反射仍可能执行。**技能选择不是动作权限控制，也不是插件禁用或安全沙箱。**
- 配置在每次开始任务时重新读取并冻结。修改文件不会改变正在运行的预算、模型、提示词或技能集合，下一次启动才生效。配置无效时修复该文件后重试；F8 保存不会覆盖一份无法解析的配置。
- 运行记录保存解析后配置的 SHA-256 和启用技能的 ID／版本，不复制 profile 中的提示词或端点。哈希用于核对配置，不包含恢复完整配置所需的数据，也不是匿名化保证。

Java 运行时显式校验上述字段与连接地址；Schema 为编辑器和工具提供字段契约。项目没有引入通用 JSON Schema 执行器，端点权限和注册表存在性仍由 Java 判断。

## 编写技能

公开入口为 [SkillProvider](../harness/src/main/java/dev/mcplayeragent/harness/SkillProvider.java)、[SkillRegistry](../harness/src/main/java/dev/mcplayeragent/harness/SkillRegistry.java) 和 [PlayerTasks.Task](../harness/src/main/java/dev/mcplayeragent/harness/PlayerTasks.java)。

```java
public final class MyProvider implements SkillProvider {
    public void register(SkillRegistry registry) {
        registry.register("my_pack:my_skill", "1", "Describe required args and dependencies",
                args -> new MyTask(args));
    }
}
```

这里的 `MyTask` 是扩展自己的实现，完整可编译示例见 [collect-return](../examples/collect-return/README.md)。

1. 工厂在创建任务时校验参数；不要在构造或注册时操作游戏。任务只能通过 `next` 返回动作，由宿主执行并提供回执。既有内置技能仍保留各自参数校验，并非所有技能都已具备严格统一的参数 Schema。
2. `Task.next` 接收真实观察、上一个动作结果及回执。返回 `Step.action` 或终态 `Step.done/failed`，任务完成不等于整个 mission 已验收。
3. 组合技能通过 `registry.start(id, args)` 创建子任务，转发 `paused/resumed/stopped`；更换子任务前清理旧任务，不把旧动作回执交给新任务。子任务声称成功后仍需核对关键观察。
4. 所有注册、任务推进与生命周期回调都在宿主线程上完成。回调需要及时返回；预算无法抢占一个阻塞宿主线程的 Java 扩展。
5. 注册表按运行实例创建，开始执行前 `seal`；重复 ID、未知或被禁用的技能、空工厂结果会显性报错。注册表封闭后不能新增或替换条目。

内置技能的完整 ID 使用 `minecraft:` 前缀；旧计划的 `harvest_tree` 等短名称仍映射到对应内置 ID。第三方扩展使用自己的命名空间，不能覆盖同名内置技能。修改技能行为或参数契约时更新注册的版本字符串，当前内置契约版本为 `1`。

## 加载扩展

最简单的自定义宿主可以直接调用 `new MyProvider().register(registry)`。标准服务发现使用 JDK `ServiceLoader`，资源文件为：

```text
META-INF/services/dev.mcplayeragent.harness.SkillProvider
```

文件每行写一个 provider 完整类名。示例包含真实资源文件与发现测试。Minecraft 启动任务时也会发现其类加载器可见的 provider，然后封闭注册表，并将启用的技能清单提供给模型。

**示例 JAR 是 Java 库，不是可直接放进 mods 的完整模组。** 在 Fabric／NeoForge 中发布扩展，需要另行提供该加载器的模组元数据、依赖声明及类路径装载；本轮未实现和验证这种安装包。不扫描任意目录，不下载代码，不支持热加载。

扩展在同一 JVM 中执行，必须视作可信代码。ServiceLoader 会调用发现到的 provider，`enabled_skills` 不阻止 provider 注册代码运行。若未来允许不可信插件，需要独立进程及权限隔离，不能用一个权限声明文件替代。

## 兼容与维护

- 当前扩展 API 随 `0.4.x Alpha` 演进，尚未作稳定性承诺。配置版本与项目发行版本分开；未来配置升级要保留原文件并提供迁移说明。
- `PlayerTasks.install` 和静态 `start/observe/...` 已迁移为实例。自定义宿主应构造 `PlayerTasks(registry, observer, memory, emergencies, stuck)`，或直接在自己的 `Adapter` 中使用注册表。`Task`、`Step` 和 `AgentHarness.Adapter` 的既有签名保留。
- 默认技能与外部技能使用同一注册协议；新增能力要提供示例、参数错误测试、取消清理测试与可复现运行记录。修改核心契约时先在 Issue／设计说明中陈述兼容变化。
- 模型后端仍为 DeepSeek／Ollama；`Planner` 可由 Java 宿主替换，游戏界面尚无第三方模型 provider 注册。记忆后端、复合条件及第二个环境尚在路线图中。
- 本项目仍是独立维护的 Numen 衍生项目，保留 LGPL 与来源说明；新增扩展入口不改变已有代码的来源。

原生操作、验收和线程约定见 [HARNESS](HARNESS.md)，待办与优先级见 [ROADMAP](ROADMAP.md)。
