# 外部技能示例：收集后返回

此模块只依赖公开 harness API 和 Gson，不导入 Minecraft、`game/` 或加载器类。`CollectReturnProvider` 通过 ServiceLoader 注册 `example:collect_return`，无需修改核心实现。

在仓库根目录使用 JDK 21：

```bash
bash ./gradlew -p examples/collect-return :test :run --args='build/demo' --no-daemon
```

结果应有 `simulation: true`、`state: VERIFIED`、3 个动作，以及带配置哈希和技能版本的运行记录。这里的拾取、寻路、模型和回执均是显式模拟；真正运行的是外部技能、服务发现、预算和 harness 生命周期。

可选传入 profile 路径（相对本示例目录）：

```bash
bash ./gradlew -p examples/collect-return :run --args='build/demo profile.json' --no-daemon
```

先创建该文件；它至少应包含以下选择，或使用默认 `["*"]`：

```json
{"schema_version":1,"enabled_skills":["minecraft:pickup_items","minecraft:navigate","example:collect_return"]}
```

profile 仍经真实校验；模拟不会连接其中配置的模型。退出时未验收会返回非零状态。模拟宿主最多推进 100 个 tick，不能把它当作真实游戏完成率评测。

任务请求：

```json
{"action":"SKILL","text":"example:collect_return","args":{"item":"minecraft:oak_log","count":2,"x":0,"y":64,"z":0}}
```

`count` 是目标库存数量，已有物品计入；技能只收集可见掉落物，不负责砍树。`x/y/z` 为返回方块坐标，验收位置为方块底部中心，距离容差 0.65。参数必须完整，未知参数、非整数坐标和非法数量会被拒绝。

技能先补足库存，检查观察后才开始返程，最后同时检查库存和位置；主 harness 仍使用现有单项 `goal_check`，这不是通用复合验收功能。测试覆盖虚假子任务成功、返回位置错误、子任务失败、禁用依赖、预算耗尽、暂停恢复、停止清理和参数边界。

核心文件：

- [CollectReturnProvider](src/main/java/example/collectreturn/CollectReturnProvider.java)：扩展注册与任务组合。
- [服务发现清单](src/main/resources/META-INF/services/dev.mcplayeragent.harness.SkillProvider)：真实 ServiceLoader 入口。
- [ExampleMain](src/main/java/example/collectreturn/ExampleMain.java)：带假技能与假回执的宿主。
- [CollectReturnTest](src/test/java/example/collectreturn/CollectReturnTest.java)：可执行扩展契约示例。

生成 Java 库可运行 `bash ./gradlew :collect-return-example:jar --no-daemon`（仓库根目录）。它尚不是可安装到 Minecraft 的模组；游戏加载的范围和兼容边界见 [扩展指南](../../docs/EXTENSIONS.md)。
