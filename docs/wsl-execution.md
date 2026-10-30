# WSL 优先执行入口

2026-10-26：本机已有默认 Ubuntu，版本为 WSL2。项目映射为
`/mnt/e/Github/AI_vtuber`；现有默认 Linux 用户是 `root`，保留此设置。

## 调用

从 Windows 的命令工具直接调用，无需手动打开 PowerShell：

```text
wsl.exe -d Ubuntu --exec bash /mnt/e/Github/AI_vtuber/scripts/wsl-run.sh doctor
wsl.exe -d Ubuntu --exec bash /mnt/e/Github/AI_vtuber/scripts/wsl-run.sh linux git status --short
wsl.exe -d Ubuntu --exec bash /mnt/e/Github/AI_vtuber/scripts/wsl-run.sh win-node --version
```

WSL 内也可使用已安装的 `aivtuber` 命令：

```bash
aivtuber doctor
aivtuber linux python3 --version
aivtuber win-python --version
aivtuber win-node --version
```

每次执行先切换到项目根目录。`linux` 使用 Linux 程序；涉及 Windows
窗口、原生输入、Windows Python 扩展或 Windows 本机服务时，优先选择
`win-python`、`win-node` 或 `win PROGRAM.exe`，由 WSL 直接启动 Windows
程序。不要把 Linux Python 当成 Windows 桌面控制运行时。

`win-python` 优先使用现有 `runtime/vlm-env/Scripts/python.exe`，否则查找
PATH 中的 `python.exe`。可通过 `WSL_WINDOWS_PYTHON`、`WSL_WINDOWS_NODE`
指定其他 Windows 运行时。传给 Windows 程序的文件路径应使用项目相对路径
或 Windows 路径；不会猜测和改写任意参数中的 `/mnt/...`。

## 权限与使用约定

- 本机命令优先从 WSL 执行；直接以 `wsl.exe --exec ...` 传递参数，避免多层
  shell 字符串和不必要的 PowerShell 窗口。
- 如命令工具需要 Windows 宿主 shell，可使用
  `C:\Windows\System32\cmd.exe`，让其仅负责启动 `wsl.exe`。
- WSL 的 `root` 是 Linux 身份，Windows 程序仍使用当前 Windows 用户权限。
  不会因此获得管理员权限，也不会改变 UAC。
- Windows 控制优先复用已运行且授权的原生服务；真正缺少 Windows 权限时，
  先验证并说明具体阻塞，不默认让用户手动点击 PowerShell。
- WSL 的 Linux `127.0.0.1` 与 Windows 服务连通性需另行检查。调用
  Windows Python/Node 时，它们访问的是 Windows 网络环境。
- 有空格、中文或特殊字符的复杂命令，优先写进 UTF-8/LF 的 `.sh` 文件，
  再用 `wsl.exe -d Ubuntu --exec bash /mnt/e/.../script.sh` 调用，避免宿主命令
  工具的引号传递差异。
- 本机 Windows PowerShell 的 `.ps1` 执行策略实测会阻止脚本。此入口使用
  Bash 和 Windows 原生可执行文件，保留现有执行策略。
- 此次配置未操作游戏、未重启已有服务、未安装新的发行版或修改默认用户。

## 本次验证

已安装 `/usr/local/bin/aivtuber`，链接到项目脚本。实测通过：Linux 命令、
Windows Python 3.12.14、Windows Node v24.15.0、跨系统文件读写、中文和
带空格/特殊字符的参数，以及 Linux/Windows 子进程退出码原样返回。
验证脚本保存在被 Git 忽略的 `runtime/wsl/verify.sh`。

Windows 进程的管理员身份检查实测为 `false`。这些结果验证的是命令执行
通路；尚未验证游戏输入或管理员服务启动。
