#!/usr/bin/env bash
# WSL-first entry point. Pass argument arrays; never evaluate command strings.
set -euo pipefail

script_path=$(readlink -f -- "${BASH_SOURCE[0]}")
project_root=$(cd -- "$(dirname -- "$script_path")/.." && pwd -P)
cd -- "$project_root"

fail() { printf 'wsl-run: %s\n' "$*" >&2; exit 1; }
require_args() { (( $# > 0 )) || fail 'missing command or script; use --help'; }

windows_executable() {
  local candidate=$1
  if [[ "$candidate" =~ ^[A-Za-z]:[\\/] ]]; then
    candidate=$(wslpath -u "$candidate")
  fi
  if [[ "$candidate" == */* ]]; then
    [[ -f "$candidate" && -x "$candidate" ]] || return 1
    printf '%s\n' "$candidate"
  else
    command -v -- "$candidate"
  fi
}

windows_python() {
  if [[ -n "${WSL_WINDOWS_PYTHON:-}" ]]; then
    windows_executable "$WSL_WINDOWS_PYTHON"
  elif [[ -x "$project_root/runtime/vlm-env/Scripts/python.exe" ]]; then
    printf '%s\n' "$project_root/runtime/vlm-env/Scripts/python.exe"
  else
    windows_executable python.exe
  fi
}

mode=${1:---help}
(( $# == 0 )) || shift
case "$mode" in
  -h|--help|help)
    cat <<'USAGE'
Usage: bash scripts/wsl-run.sh MODE [ARGS...]
  doctor                  Check WSL, project access and Windows interop
  linux COMMAND [ARGS...]  Run a Linux command from the project root
  win PROGRAM.exe [ARGS...] Run a Windows executable from WSL
  win-python [ARGS...]     Use the project's Windows vision Python, if present
  win-node [ARGS...]       Use Windows Node.js for Windows APIs/services
  shell                   Open Bash at the project root

Use relative project paths for Windows program arguments, or Windows paths.
Linux /mnt/... paths in arbitrary Windows arguments are not auto-converted.
WSL_WINDOWS_PYTHON and WSL_WINDOWS_NODE may override the Windows runtimes.
This runner does not elevate Windows privileges or request UAC approval.
USAGE
    ;;
  doctor)
    printf 'Kernel: %s\nLinux user: %s\nProject: %s\n' "$(uname -r)" "$(id -un)" "$project_root"
    [[ -r AGENTS.md && -w scripts ]] || fail 'project is not readable/writable'
    for tool in bash python3 git node rg wslpath; do
      printf '%s: %s\n' "$tool" "$(command -v "$tool" || printf 'unavailable')"
    done
    printf 'Windows Python: %s\n' "$(windows_python || printf 'unavailable')"
    printf 'Windows Node: %s\n' "$(windows_executable "${WSL_WINDOWS_NODE:-node.exe}" || printf 'unavailable')"
    identity=$(windows_executable whoami.exe) || fail 'Windows interop unavailable'
    printf 'Windows identity: '
    "$identity"
    ;;
  linux)
    require_args "$@"
    exec "$@"
    ;;
  win)
    require_args "$@"
    [[ "$1" == *.[eE][xX][eE] ]] || fail 'win requires an explicit .exe program'
    executable=$(windows_executable "$1") || fail "Windows executable not found: $1"
    shift
    exec "$executable" "$@"
    ;;
  win-python)
    executable=$(windows_python) || fail 'Windows Python unavailable; set WSL_WINDOWS_PYTHON'
    exec "$executable" "$@"
    ;;
  win-node)
    executable=$(windows_executable "${WSL_WINDOWS_NODE:-node.exe}") || fail 'Windows Node unavailable; set WSL_WINDOWS_NODE'
    exec "$executable" "$@"
    ;;
  shell)
    exec bash -i "$@"
    ;;
  *)
    fail "unknown mode: $mode; use --help"
    ;;
esac
