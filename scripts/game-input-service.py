"""Local, authenticated, single-flight real game input with visual evidence.

No model or navigation is simulated. Run one fixed target per service instance.
The HTTP result deliberately does NOT claim that a game action succeeded.
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts/sts2'))
from native_input import NativeInput, validate


class Evidence:
    def __init__(self, controller, directory):
        self.controller, self.directory = controller, directory
        self.stop = threading.Event()
        self.error = None
        self.frames = 0
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self.record, daemon=True)

    def record(self):
        import cv2
        import mss
        import numpy as np
        c = self.controller
        x, y, width, height = c.geometry
        size = (960, max(2, round(height/width*960)//2*2))
        writer = cv2.VideoWriter(str(self.directory/'recording.avi'), cv2.VideoWriter_fourcc(*'MJPG'), 10, size)
        try:
            if not writer.isOpened(): raise RuntimeError('Evidence video unavailable')
            with mss.mss() as screen, (self.directory/'frames.jsonl').open('w', encoding='utf-8') as timeline:
                while not self.stop.is_set():
                    tick = time.monotonic()
                    # Never capture a different foreground application as game evidence.
                    if c.user.GetForegroundWindow() != c.hwnd or c.client_rect() != c.geometry:
                        raise InterruptedError('Evidence lost game foreground or geometry')
                    image = np.asarray(screen.grab(dict(left=x, top=y, width=width, height=height)))[:, :, :3]
                    ns = time.perf_counter_ns()
                    writer.write(cv2.resize(image, size))
                    if self.frames % 5 == 0:
                        cv2.imwrite(str(self.directory/f'frame-{self.frames:04d}.jpg'), image)
                    timeline.write(json.dumps({'frame': self.frames, 'captured_ns': ns})+'\n')
                    timeline.flush()
                    self.frames += 1
                    self.ready.set()
                    self.stop.wait(max(0, .1-(time.monotonic()-tick)))
        except Exception as ex:
            self.error = str(ex)
            c.cancel.set()
        finally:
            self.ready.set()
            writer.release()


class ControlledInput(NativeInput):
    def __init__(self, exe, stop_file, cancel):
        super().__init__(exe, stop_file)
        self.cancel = cancel

    def guard(self):
        if self.cancel.is_set(): raise InterruptedError('Controller stop requested')
        super().guard()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--exe', choices=['YuanShen.exe', 'GenshinImpact.exe', 'SlayTheSpire2.exe', 'javaw.exe'], required=True)
    p.add_argument('--port', type=int, default=17651)
    args = p.parse_args()
    directory = ROOT/'runtime/game-input'
    directory.mkdir(parents=True, exist_ok=True)
    token_file = directory/'token.txt'
    if not token_file.exists(): token_file.write_text(secrets.token_urlsafe(32), encoding='utf-8')
    token = token_file.read_text(encoding='utf-8').strip()
    busy = threading.Lock()
    state_lock = threading.Lock()
    state = {'active': None, 'last_run': None}
    stop_file = directory/'STOP_INPUT'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass  # Do not log authentication headers.

        def reply(self, code, value):
            body = json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass

        def allowed(self):
            if self.headers.get('Host') not in (f'127.0.0.1:{args.port}', f'localhost:{args.port}') or self.headers.get('Origin'):
                self.reply(403, {'error': 'Local CLI clients only'})
                return False
            if not secrets.compare_digest(self.headers.get('Authorization', ''), f'Bearer {token}'):
                self.reply(401, {'error': 'Authentication required'})
                return False
            return True

        def do_GET(self):
            if not self.allowed(): return
            if self.path != '/health': return self.reply(404, {'error': 'Unknown route'})
            try:
                c = NativeInput(args.exe, stop_file)
                self.reply(200, {'service': 'real-game-input', 'target': args.exe, 'pid': c.pid,
                    'hwnd': c.hwnd, 'client_rect': c.geometry, **c.privileges(),
                    'busy': busy.locked(), 'last_run': state['last_run'],
                    'stop_file_present': stop_file.exists(), 'game_verified': False})
            except Exception as ex: self.reply(503, {'error': str(ex)})

        def do_POST(self):
            if not self.allowed(): return
            if self.path == '/stop':
                with state_lock:
                    if state['active'] is not None: state['active'].set()
                return self.reply(200, {'stop_requested': True, 'release_complete': not busy.locked()})
            if self.path != '/actions': return self.reply(404, {'error': 'Unknown route'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 32768: raise ValueError('Body must be 1..32768 bytes')
                self.connection.settimeout(5)
                request = json.loads(self.rfile.read(size))
                actions = validate(request['actions'])
                label = str(request.get('label', 'trial'))[:120]
            except Exception as ex: return self.reply(400, {'error': str(ex)})
            if not busy.acquire(blocking=False): return self.reply(409, {'error': 'Another action is running'})
            run = directory/'runs'/str(time.time_ns())
            run.mkdir(parents=True)
            cancel = threading.Event()
            with state_lock: state['active'] = cancel
            c, evidence = None, None
            result = {'label': label, 'target': args.exe, 'actions': actions, 'directory': str(run),
                      'game_verified': False, 'status': 'not_executed'}
            try:
                c = ControlledInput(args.exe, stop_file, cancel)
                result['privileges'] = c.privileges()
                if not result['privileges']['privilege_compatible']:
                    raise RuntimeError('Game is elevated but controller is not; no input sent')
                c.focus()
                evidence = Evidence(c, run)
                evidence.thread.start()
                if not evidence.ready.wait(3) or evidence.error:
                    raise RuntimeError(evidence.error or 'No evidence frame')
                c.wait(.5)
                result.update(c.run(actions))
                c.wait(1.5)  # Observe after release; do not imply motion stopped just because key-up was sent.
                result['status'] = 'awaiting_visual_review'
            except Exception as ex:
                result.update(status='stopped', error=str(ex))
            finally:
                if c:
                    try: c.release_all()
                    except Exception as ex: result['release_error'] = str(ex)
                    result.update(events=c.events, held_keys=list(c.held_keys), held_buttons=list(c.held_buttons))
                if evidence:
                    # Keep recording a short release tail even if the action was cancelled.
                    time.sleep(.6)
                    evidence.stop.set()
                    evidence.thread.join(3)
                    result.update(evidence_frames=evidence.frames, evidence_error=evidence.error)
                    if evidence.thread.is_alive(): result['evidence_error'] = 'Recorder did not finish'
                result.pop('motion_trace', None)
                (run/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
                with state_lock:
                    state['active'] = None
                    state['last_run'] = str(run)
                busy.release()
            self.reply(200 if result['status'] == 'awaiting_visual_review' else 422, result)

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    (directory/'service.json').write_text(json.dumps({'pid': __import__('os').getpid(), 'port': args.port,
        'target': args.exe, 'started': time.time()}), encoding='utf-8')
    print(f'Input service ready on 127.0.0.1:{args.port}; target={args.exe}', flush=True)
    server.serve_forever()


if __name__ == '__main__': main()
