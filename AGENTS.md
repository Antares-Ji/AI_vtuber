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

## Game autonomy through the director API

The user requires the director console/Skill API to start game tasks, DeepSeek
API to decide gameplay, local model/CV/OCR APIs to observe and locate targets,
and the project's existing native input API to execute keyboard/mouse actions.
The user subsequently requested a faster cloud vision API (2026-10-30). STS2 may
select official DeepSeek Flash image inference while retaining local OCR/CV
checks and native input. Record the actual provider; do not describe cloud
observations as local model inference. Genshin cloud vision is not yet enabled.
Codex may inspect code, diagnose, repair, test, and supervise start/stop, but must
not choose gameplay actions, read a screenshot itself to supply target coordinates,
or manually play through computer-use tools. API-only includes CV and grounding.

For current Slay the Spire 2 pure-vision trials, do not fill missing observations
from MCP/hidden game state. Preserve the imported MC native Harness observation,
action and server-receipt architecture; do not describe it as pure vision.
Keep simulated tests, input receipts and independently verified game outcomes
distinct. Before changing the live runtime or switching games, stop the task and
confirm input release and idle vision. Preserve pending user choices of MC save
and normal Windows permission handling for Genshin.
