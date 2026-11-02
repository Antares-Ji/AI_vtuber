"""Launch the configured game. Optional normal Windows consent; never bypass UAC."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts/sts2'))
TARGETS = {'yuanshen.exe', 'genshinimpact.exe'}


def launch_with_consent(executable):
    import ctypes
    from ctypes import wintypes
    class SHELLEXECUTEINFO(ctypes.Structure):
        _fields_ = [('cbSize', wintypes.DWORD), ('fMask', wintypes.ULONG), ('hwnd', wintypes.HWND),
                    ('lpVerb', wintypes.LPCWSTR), ('lpFile', wintypes.LPCWSTR), ('lpParameters', wintypes.LPCWSTR),
                    ('lpDirectory', wintypes.LPCWSTR), ('nShow', ctypes.c_int), ('hInstApp', wintypes.HINSTANCE),
                    ('lpIDList', ctypes.c_void_p), ('lpClass', wintypes.LPCWSTR), ('hkeyClass', wintypes.HKEY),
                    ('dwHotKey', wintypes.DWORD), ('hIcon', wintypes.HANDLE), ('hProcess', wintypes.HANDLE)]
    info = SHELLEXECUTEINFO(); info.cbSize = ctypes.sizeof(info); info.fMask = 0x40 | 0x100
    info.lpVerb = 'runas'; info.lpFile = str(executable); info.lpDirectory = str(executable.parent); info.nShow = 1
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    shell.ShellExecuteExW.argtypes = [ctypes.POINTER(SHELLEXECUTEINFO)]; shell.ShellExecuteExW.restype = wintypes.BOOL
    if not shell.ShellExecuteExW(ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetProcessId.argtypes = [wintypes.HANDLE]; kernel.GetProcessId.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    try:
        pid = kernel.GetProcessId(info.hProcess)
        if not pid: raise RuntimeError('Windows returned no game process receipt')
        return pid
    finally: kernel.CloseHandle(info.hProcess)


def matching_process(executable, processes):
    matches = [p for p in processes if (p.info['name'] or '').lower() in TARGETS]
    if len(matches) > 1:
        raise RuntimeError('Multiple Genshin processes exist; refusing another launch')
    if not matches:
        return None
    p = matches[0]
    if os.path.normcase(str(Path(p.exe()).resolve())) != os.path.normcase(str(executable.resolve())):
        raise RuntimeError('Another Genshin installation is already running')
    return p


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--nonce', required=True)
    parser.add_argument('--system-prompt', action='store_true')
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('Genshin launch requires Windows')
    executable = args.exe.resolve(strict=True)
    if not args.exe.is_absolute() or executable.name.lower() not in TARGETS or not executable.is_file():
        raise ValueError('Expected configured Genshin game executable')
    if str(uuid.UUID(args.nonce)) != args.nonce:
        raise ValueError('Canonical UUID required')
    import ctypes
    from ctypes import wintypes
    import psutil
    from native_input import NativeInput
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    mutex = kernel.CreateMutexW(None, False, 'Local\\AI_vtuber_native_game_input')
    acquired = False
    try:
        if not mutex:
            raise RuntimeError('Native game mutex unavailable')
        acquired = kernel.WaitForSingleObject(mutex, 0) in (0, 0x80)
        if not acquired:
            raise RuntimeError('Another native input run is active')
        process = matching_process(executable, psutil.process_iter(['pid', 'name']))
        started = process is None
        if started:
            try:
                child = subprocess.Popen([str(executable)], cwd=executable.parent,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
                process = psutil.Process(child.pid)
            except OSError as error:
                if getattr(error, 'winerror', None) != 740 or not args.system_prompt: raise
                process = psutil.Process(launch_with_consent(executable))
        result = dict(nonce=args.nonce, target=executable.name, pid=process.pid, started=started,
                      inputSent=False, verified=False, windowFound=False, foreground=False)
        # A launch receipt is not a playable-scene receipt. Never press through
        # login or permission prompts, and never retry a possibly accepted launch.
        deadline = time.monotonic()+20
        while time.monotonic() < deadline:
            if not process.is_running():
                raise RuntimeError('Genshin process exited before a visible game window')
            try:
                c = NativeInput(executable.name, restore_minimized=False)
                if c.pid != process.pid:
                    raise RuntimeError('Visible window belongs to another game process')
                result.update(windowFound=True, foreground=c.user.GetForegroundWindow() == c.hwnd)
                result.pop('windowDiagnostic', None)
                break
            except RuntimeError as error:
                result['windowDiagnostic'] = str(error)
            time.sleep(.25)
        print(json.dumps(result))
    finally:
        if acquired:
            kernel.ReleaseMutex(mutex)
        if mutex:
            kernel.CloseHandle(mutex)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Genshin launch failed: '+str(error), file=sys.stderr)
        raise SystemExit(1)
