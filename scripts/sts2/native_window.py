"""Reversible game-window sizing through Win32; never sends game keys/mouse."""
import argparse
import ctypes as C
from ctypes import wintypes as W
import json
import os
from pathlib import Path
import time
import psutil
from native_input import NativeInput

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT/'runtime/game-input'


class Placement(C.Structure):
    _fields_ = [('length',W.UINT),('flags',W.UINT),('showCmd',W.UINT),
                ('minimum',W.POINT),('maximum',W.POINT),('normal',W.RECT)]


def adjust(mode):
    if mode not in ('maximize','restore'):
        raise ValueError('Only maximize and restore are supported')
    stop = BASE/'STOP_INPUT'
    if not stop.exists():
        raise RuntimeError('Stop game input before adjusting its window')
    c = NativeInput('SlayTheSpire2.exe',stop,restore_minimized=False)
    if not c.privileges()['privilege_compatible']:
        raise RuntimeError('Game window privilege mismatch')
    kernel, user = c.kernel, c.user
    kernel.CreateMutexW.argtypes = [C.c_void_p,W.BOOL,W.LPCWSTR]
    kernel.CreateMutexW.restype = W.HANDLE
    kernel.WaitForSingleObject.argtypes = [W.HANDLE,W.DWORD]
    kernel.ReleaseMutex.argtypes = [W.HANDLE]
    handle = kernel.CreateMutexW(None,False,'Local\\AI_vtuber_native_game_input')
    if not handle:
        raise C.WinError()
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(handle,0) in (0,0x80)
        if not acquired or not stop.exists():
            raise RuntimeError('Native game input is not stopped and idle')
        if any(user.GetAsyncKeyState(key)&0x8000 for key in (1,2,4,5,6)):
            raise RuntimeError('Release mouse buttons before adjusting the window')
        user.GetWindowPlacement.argtypes = [W.HWND,C.POINTER(Placement)]
        user.SetWindowPlacement.argtypes = [W.HWND,C.POINTER(Placement)]
        user.ShowWindow.argtypes = [W.HWND,C.c_int]
        user.IsZoomed.argtypes = [W.HWND]
        placement = Placement(); placement.length = C.sizeof(placement)
        if not user.GetWindowPlacement(c.hwnd,C.byref(placement)):
            raise C.WinError()
        before = c.client_rect()
        identity = {'pid':c.pid,'created':psutil.Process(c.pid).create_time(),'hwnd':c.hwnd}
        saved = BASE/'window-placement.json'
        changed = False
        if mode == 'maximize':
            if user.IsZoomed(c.hwnd):
                return {'mode':mode,'changed':False,'before':before,'after':before,'inputSent':False}
            # Keep a durable restore point before the reversible window mutation.
            record = {**identity,'placement':list(bytes(placement))}
            BASE.mkdir(parents=True,exist_ok=True)
            temp = saved.with_suffix('.tmp')
            temp.write_text(json.dumps(record),encoding='utf-8')
            os.replace(temp,saved)
            user.ShowWindow(c.hwnd,3)
            changed = True
        else:
            record = json.loads(saved.read_text(encoding='utf-8'))
            if any(record.get(key)!=value for key,value in identity.items()):
                raise RuntimeError('Restore point belongs to a different game process/window')
            raw = bytes(record['placement'])
            if len(raw)!=C.sizeof(Placement):
                raise ValueError('Invalid saved window placement')
            placement = Placement.from_buffer_copy(raw)
            if placement.length!=C.sizeof(Placement) or placement.showCmd not in (1,3,9):
                raise ValueError('Unsupported saved window placement')
            if not user.SetWindowPlacement(c.hwnd,C.byref(placement)):
                raise C.WinError()
            changed = True
        deadline = time.monotonic()+3
        while time.monotonic()<deadline:
            time.sleep(.1)
            current = Placement(); current.length = C.sizeof(current)
            if not user.GetWindowPlacement(c.hwnd,C.byref(current)):
                raise C.WinError()
            if mode == 'maximize':
                ready = bool(user.IsZoomed(c.hwnd))
            else:
                ready = current.showCmd==placement.showCmd and bytes(current.normal)==bytes(placement.normal)
            if ready:
                after = c.client_rect()
                if mode == 'restore':saved.unlink()
                return {'mode':mode,'changed':changed,'pid':c.pid,'before':before,'after':after,
                        'inputSent':False,'windowChanged':True,'restoreAvailable':saved.exists()}
        raise RuntimeError('Window change was not confirmed; restore point retained')
    finally:
        if acquired:kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode',choices=('maximize','restore'))
    args = parser.parse_args()
    try:
        print(json.dumps(adjust(args.mode)))
    except Exception as error:
        print(json.dumps({'error':str(error),'inputSent':False}))
        raise SystemExit(1)
