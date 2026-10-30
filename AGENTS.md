# Project operating memory

For Arknights desktop control or local vision testing, read
`docs/arknights-control-memory.md` before operating the game. It records the
user-confirmed working input path, coordinate convention and verification rules.

## WSL-first execution preference

The user requested on 2026-10-26 that local command execution first use the
existing Ubuntu WSL2 distribution, without asking them to open or click
PowerShell. Read `docs/wsl-execution.md` for the verified entry point.
Use `wsl.exe -d Ubuntu --exec bash /mnt/e/Github/AI_vtuber/scripts/wsl-run.sh`
with `linux`, `win-python`, `win-node`, `win`, or `doctor` as appropriate.
If a Windows host shell is needed, use `C:\Windows\System32\cmd.exe` to launch
WSL. Prefer existing authorized Windows control services for desktop input.
WSL root does not confer Windows administrator privileges; verify a real
permission failure before proposing manual intervention. Never change UAC or
claim that WSL bypasses Windows elevation.
