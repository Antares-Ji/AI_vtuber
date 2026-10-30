# 实际游戏键鼠验证

当前阶段只验证输入，不训练导航、不把模拟测试算作游戏通过。

## 算法与边界

1. 按可执行文件名寻找唯一可见游戏窗口，固定 PID、句柄和客户区坐标。
2. 检查控制器/游戏权限。游戏为管理员而控制器不是管理员时，拒绝发送。
3. 完整校验一个动作批次后才开始执行。禁止任意脚本、命令和系统快捷键。
4. 只允许前台游戏收输入。每约 8ms 检查停止信号、焦点、窗口几何与期限。
5. 键盘使用扫描码 SendInput；界面点击使用客户区归一化坐标；转镜头使用相对鼠标计数。
6. 每个请求串行执行，其他请求返回 409。F8、STOP_INPUT 文件和 /stop 都能中止正常运行中的批次。
7. 正常结束或异常均释放该控制器按下的键。进程被强制终止/操作系统失效不在 finally 的保证范围内。
8. 每次保存动作、权限、时间戳、10fps 视频和间隔截图；松键后继续观察。
9. API 只报告 awaiting_visual_review，绝不把 SendInput 成功或像素变化当作游戏成功。

## 启动和调用

管理员运行游戏时，请用户手动允许同权限的控制器。无需远程桌面、无需更改安全设置。

```powershell
# 直接启动，系统 UAC 由用户操作。不要让 Agent 代点。
Start-Process -FilePath 'E:\Github\AI_vtuber\runtime\vlm-env\Scripts\python.exe' -Verb RunAs -WindowStyle Hidden -WorkingDirectory 'E:\Github\AI_vtuber' -ArgumentList '"E:\Github\AI_vtuber\scripts\game-input-service.py" --exe YuanShen.exe'

.\runtime\vlm-env\Scripts\python.exe scripts/game-input-request.py health
.\runtime\vlm-env\Scripts\python.exe scripts/game-input-request.py actions --file scripts/game-input-trials/exit-menu.json
.\runtime\vlm-env\Scripts\python.exe scripts/game-input-request.py stop
```

服务只监听 `127.0.0.1:17651`；所有接口都需要本地随机令牌，拒绝跨源浏览器请求。令牌由客户端从 `runtime/game-input/token.txt` 读取，不放进命令行或文档。

可选目标为 YuanShen.exe、GenshinImpact.exe、SlayTheSpire2.exe、javaw.exe。一个服务固定一个目标，换游戏需重新启动。多个 javaw 窗口时拒绝猜测目标。支持目标名称不代表已经在该游戏验证通过。

## 人工可审核的逐次验证

先截图判断场景，不在悬崖、战斗、加载界面盲目发动作。

| 项目 | 动作 | 通过依据 |
| --- | --- | --- |
| 菜单按键 | Esc 120ms | 对应菜单实际关闭 |
| 前进/后退 | W/S 350ms | 地面参照物相对角色移动，松键后的多帧显示不再平移 |
| 镜头转动 | 相对 ±120 counts | 固定地标横向改变位置，停止发送后镜头稳定 |
| 停止 | 持键中请求 /stop | 请求提前退出、无遗留持键、后续画面角色停止 |
| 焦点保护 | 用户主动切出游戏 | 控制器中止、不继续给其他窗口输入；需另行实测 |

动作成功至少重复三轮，并把成功次数、失败次数和证据路径都写入报告。一次通过不能推断长期稳定，也不能推断跨游戏成功。

证据目录为 `runtime/game-input/runs/<时间戳>/`。`recording.avi` 为固定播放帧率，真实时序看 `frames.jsonl` 的 captured_ns 和 result.json 的动作 started_ns/finished_ns。截图只是可观察表面；位置正确性与导航学习是后续独立验证。

## 2026-10-26 初次诊断

在原神设置/声音页实测非管理员 SendInput：Esc 调用返回成功但画面未退出；点击关闭按钮在鼠标未到达游戏后触发遮挡保护。权限查询确认控制器未提升、原神已提升。因此这两次不计通过。已加入提前权限检查，后续结果另写实测报告。
