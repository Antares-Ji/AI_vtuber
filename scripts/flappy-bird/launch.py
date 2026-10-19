"""Launch the installed demo without requiring PowerShell script execution."""
import argparse
import ctypes
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "runtime/flappy-bird"
RUN = Path(__file__).with_name("run.py")


def running_demo():
    """Require both a recent game heartbeat and a live Windows process."""
    try:
        state = json.loads((RUNTIME / "live-status.json").read_text(encoding="utf-8-sig"))
        updated = datetime.fromisoformat(state["updated_at"])
        if (datetime.now(timezone.utc) - updated).total_seconds() > 15 or "score" not in state:
            return None
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, int(state["pid"]))
        if not handle:
            return None
        try:
            code = ctypes.c_uint32()
            if kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259:
                return state
        finally:
            kernel.CloseHandle(handle)
    except (OSError, ValueError, KeyError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--stop", action="store_true")
    mode.add_argument("--evaluate", action="store_true")
    args = parser.parse_args()
    if args.stop:
        (RUNTIME / "stop-demo").touch()
        print("Stop requested. The game will close shortly.")
        return 0
    if args.evaluate:
        return subprocess.call([sys.executable, str(RUN), "--episodes", "100", "--target", "1000",
                                "--seed", "30000", "--output", str(RUNTIME / "acceptance.json")], cwd=ROOT)
    existing = running_demo()
    if existing:
        print(f"Flappy Bird AI is already running (PID {existing['pid']}, score {existing['score']}).")
        print("Use its game window. Press Esc to stop.")
        return 0
    (RUNTIME / "stop-demo").unlink(missing_ok=True)
    command = [str(RUNTIME / ".venv/Scripts/pythonw.exe"), str(RUN), "--render", "--episodes", "0",
               "--target", "10000", "--max-steps", "1000000", "--seed", "50000",
               "--output", str(RUNTIME / "demo.json")]
    started = datetime.now(timezone.utc)
    with (RUNTIME / "demo.stdout.log").open("w") as stdout, (RUNTIME / "demo.stderr.log").open("w") as stderr:
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
    (RUNTIME / "demo-process.json").write_text(json.dumps({
        "pid": process.pid, "started_at": started.isoformat(), "script": str(RUN)
    }, indent=2), encoding="utf-8")
    for _ in range(150):
        if process.poll() is not None:
            print(f"Game exited during startup. See {RUNTIME / 'demo.stderr.log'}", file=sys.stderr)
            return 1
        live = running_demo()
        if live and datetime.fromisoformat(live["updated_at"]) >= started:
            print(f"Flappy Bird AI started (PID {live['pid']}). Press Esc in the game to stop.")
            return 0
        time.sleep(0.1)
    print("Game process started, but its first heartbeat is still pending. Check demo.stderr.log.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
