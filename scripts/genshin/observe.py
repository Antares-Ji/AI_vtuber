"""One bounded, foreground-only observation. Never focuses or sends input."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts/sts2'))


def capture_frame(controller, grab):
    """Validate the same window both sides of capture; reject a changed frame."""
    def guard():
        if controller.user.GetForegroundWindow() != controller.hwnd or controller.user.IsIconic(controller.hwnd):
            raise RuntimeError('Genshin must already be foreground; observation sends no focus or input')
        if controller.client_rect() != controller.geometry:
            raise RuntimeError('Game geometry changed during observation')
    guard()
    x, y, width, height = controller.geometry
    if width * height > 16777216:
        raise RuntimeError('Game screenshot exceeds pixel limit')
    frame = grab(dict(left=x, top=y, width=width, height=height))
    guard()
    return frame


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--exe', choices=['YuanShen.exe', 'GenshinImpact.exe'], required=True)
    parser.add_argument('--nonce', required=True)
    args = parser.parse_args()
    if str(uuid.UUID(args.nonce)) != args.nonce:
        raise ValueError('Canonical UUID required')
    from native_input import NativeInput
    from PIL import Image
    import mss
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
        c = NativeInput(args.exe, restore_minimized=False)
        # No focus(), run(), send(), release_all(), or STOP_INPUT mutation.
        with mss.mss() as screen:
            frame = capture_frame(c, screen.grab)
        pid = wintypes.DWORD()
        c.user.GetWindowThreadProcessId(c.hwnd, ctypes.byref(pid))
        if pid.value != c.pid:
            raise RuntimeError('Game window identity changed during observation')
        captured_at = int(time.time()*1000)
        directory = ROOT/'runtime/genshin/observations'/args.nonce
        directory.mkdir(parents=True, exist_ok=False)
        image = directory/'frame.png'
        Image.frombytes('RGB', frame.size, frame.rgb).save(image)
        result = {'nonce': args.nonce, 'target': args.exe, 'pid': c.pid,
                  'capturedAt': captured_at, 'image': str(image),
                  'clientRect': c.geometry, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                  'source': 'project_native_capture', 'inputSent': False, 'verified': False}
        (directory/'result.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if acquired:
            kernel.ReleaseMutex(mutex)
        if mutex:
            kernel.CloseHandle(mutex)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Genshin observation failed: '+str(error), file=sys.stderr)
        raise SystemExit(1)
