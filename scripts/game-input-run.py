"""Run the project's own Win32 input executor with its own screenshot/video capture.

No Computer Use/LLM/MCP desktop driver, game mod, or memory access.
Without --execute this only captures the explicitly selected foreground game.
"""
import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
from pathlib import Path
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('game_input_service', ROOT/'scripts/game-input-service.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--exe', default='SlayTheSpire2.exe')
    p.add_argument('--actions', type=Path)
    p.add_argument('--execute', action='store_true')
    args = p.parse_args()
    actions = []
    if args.execute:
        if not args.actions: p.error('--execute requires --actions JSON')
        actions = module.validate(json.loads(args.actions.read_text(encoding='utf-8-sig')))
    directory = ROOT/'runtime/game-input/runs'/str(time.time_ns())
    directory.mkdir(parents=True)
    result = {'target':args.exe,'directory':str(directory),'actions':actions,
              'status':'not_executed','game_verified':False,'driver':'project_native_win32'}
    c, evidence, mutex, acquired = None, None, None, False
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    try:
        mutex = kernel.CreateMutexW(None, False, 'Local\\AI_vtuber_native_game_input')
        if not mutex: raise RuntimeError('Cannot acquire native input mutex')
        acquired = kernel.WaitForSingleObject(mutex, 0) in (0, 0x80)
        if not acquired: raise RuntimeError('Another native input run is active; no input sent')
        c = module.ControlledInput(args.exe, ROOT/'runtime/game-input/STOP_INPUT', threading.Event())
        result['privileges'] = c.privileges()
        if not result['privileges']['privilege_compatible']: raise RuntimeError('Privilege mismatch; no input sent')
        c.focus()
        evidence = module.Evidence(c,directory)
        evidence.thread.start()
        if not evidence.ready.wait(3) or evidence.error: raise RuntimeError(evidence.error or 'No screenshot')
        c.wait(.6)
        if args.execute: result.update(c.run(actions))
        c.wait(1.5)
        result['status'] = 'awaiting_visual_review' if args.execute else 'captured_only'
    except Exception as ex:
        result.update(status='stopped',error=str(ex))
    finally:
        if c:
            try: c.release_all()
            except Exception as ex: result['release_error']=str(ex)
            result.update(events=c.events,held_keys=list(c.held_keys),held_buttons=list(c.held_buttons),
                          motion_trace=c.motion_trace,client_rect=c.geometry,pid=c.pid)
        if evidence:
            evidence.stop.set()
            evidence.thread.join(3)
            result.update(evidence_frames=evidence.frames,evidence_error=evidence.error)
        (directory/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({k:v for k,v in result.items() if k!='motion_trace'},ensure_ascii=False))
        if acquired: kernel.ReleaseMutex(mutex)
        if mutex: kernel.CloseHandle(mutex)
    if result['status']=='stopped': raise SystemExit(1)

if __name__=='__main__': main()
