"""Visible Windows SendInput controller; normalized coordinates refer to CLIENT area.

F8 or runtime/sts2/STOP_INPUT stops execution. Focus loss aborts; finally releases
only keys/buttons pressed by this controller. No background PostMessage input.
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
import json
import math
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[2]
KEYS = {'ESC': 0x1B, 'ENTER': 0x0D, 'SPACE': 0x20, 'TAB': 9,
        'LEFT': 0x25, 'UP': 0x26, 'RIGHT': 0x27, 'DOWN': 0x28,
        **{chr(i): i for i in range(65, 91)}, **{str(i): 48+i for i in range(10)}}
BUTTONS = {'left': (2, 4), 'right': (8, 16), 'middle': (32, 64)}


def ease(t):
    return t*t*t*(10 + t*(-15 + 6*t))  # minimum jerk, zero endpoint velocity


def validate(actions):
    if not isinstance(actions, list) or not 1 <= len(actions) <= 64:
        raise ValueError('Expected 1..64 actions')
    total = 0
    for a in actions:
        if not isinstance(a, dict) or a.get('action') not in {'move', 'relative', 'scroll', 'click', 'drag', 'down', 'up', 'key', 'key_down', 'key_up', 'wait'}:
            raise ValueError('Unknown action')
        kind = a['action']
        if kind == 'scroll' and (type(a.get('steps')) is not int or not 1 <= abs(a['steps']) <= 10):
            raise ValueError('Scroll steps must be a nonzero integer within -10..10')
        if kind == 'relative' and any(type(a.get(k)) is not int or abs(a[k]) > 1200 for k in ('dx', 'dy')):
            raise ValueError('Relative dx/dy must be integers within -1200..1200')
        for field in ('to', 'from'):
            if field in a and (not isinstance(a[field], list) or len(a[field]) != 2 or
                              any(type(v) not in (float, int) or not math.isfinite(v) or not 0 <= v <= 1 for v in a[field])):
                raise ValueError('Coordinates must be [x,y] in normalized client area 0..1')
        if kind in {'move', 'click', 'drag', 'scroll'} and 'to' not in a:
            raise ValueError('Missing to')
        if kind == 'drag' and 'from' not in a:
            raise ValueError('Missing from')
        if kind in {'click', 'drag', 'down', 'up'} and a.get('button', 'left') not in BUTTONS:
            raise ValueError('Unknown button')
        if kind.startswith('key') and a.get('key', '').upper() not in KEYS:
            raise ValueError('Key not in game-key allowlist')
        for field, default, maximum in [('duration', .7, 5), ('hold', .08, 2)]:
            value = a.get(field, default)
            if type(value) not in (int, float) or not math.isfinite(value) or not .02 <= value <= maximum:
                raise ValueError(f'Invalid {field}')
        total += a.get('duration', .7) + a.get('hold', .08) + (1 if kind == 'drag' else 0)
    if total > 30:
        raise ValueError('Action batch exceeds 30 seconds; observe between batches')
    return actions


class MouseInput(C.Structure):
    _fields_ = [('dx', W.LONG), ('dy', W.LONG), ('mouseData', W.DWORD), ('dwFlags', W.DWORD), ('time', W.DWORD), ('dwExtraInfo', C.c_size_t)]


class KeyInput(C.Structure):
    _fields_ = [('wVk', W.WORD), ('wScan', W.WORD), ('dwFlags', W.DWORD), ('time', W.DWORD), ('dwExtraInfo', C.c_size_t)]


class InputUnion(C.Union):
    _fields_ = [('mi', MouseInput), ('ki', KeyInput)]


class Input(C.Structure):
    _anonymous_ = ('u',)
    _fields_ = [('type', W.DWORD), ('u', InputUnion)]


class NativeInput:
    def __init__(self, exe='SlayTheSpire2.exe', stop_file=None, *, restore_minimized=True):
        if os.name != 'nt':
            raise OSError('Windows only')
        self.user = C.WinDLL('user32', use_last_error=True)
        self.kernel = C.WinDLL('kernel32', use_last_error=True)
        u = self.user
        u.SetProcessDpiAwarenessContext.argtypes = [C.c_void_p]
        u.SetProcessDpiAwarenessContext(C.c_void_p(-4))
        u.GetForegroundWindow.restype = W.HWND
        u.WindowFromPoint.argtypes = [W.POINT]
        u.WindowFromPoint.restype = W.HWND
        u.GetAncestor.argtypes = [W.HWND, W.UINT]
        u.GetAncestor.restype = W.HWND
        for name in ('IsWindowVisible', 'IsIconic', 'SetForegroundWindow', 'IsWindow'):
            getattr(u, name).argtypes = [W.HWND]
        u.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
        u.GetClientRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
        u.ClientToScreen.argtypes = [W.HWND, C.POINTER(W.POINT)]
        u.SendInput.argtypes = [W.UINT, C.POINTER(Input), C.c_int]
        u.SendInput.restype = W.UINT
        self.kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        self.kernel.OpenProcess.restype = W.HANDLE
        self.kernel.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)]
        self.kernel.CloseHandle.argtypes = [W.HANDLE]
        candidates = []
        callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        def visit(hwnd, _):
            if not u.IsWindowVisible(hwnd):
                return True
            pid = W.DWORD()
            u.GetWindowThreadProcessId(hwnd, C.byref(pid))
            process = self.kernel.OpenProcess(0x1000, False, pid.value)
            if process:
                try:
                    name = C.create_unicode_buffer(32768)
                    size = W.DWORD(len(name))
                    if self.kernel.QueryFullProcessImageNameW(process, 0, name, C.byref(size)) and Path(name.value).name.lower() == exe.lower():
                        candidates.append((hwnd, pid.value))
                finally:
                    self.kernel.CloseHandle(process)
            return True
        u.EnumWindows(callback_type(visit), 0)
        if len(candidates) != 1:
            raise RuntimeError(f'Expected one visible {exe} window; found {len(candidates)}')
        self.hwnd, self.pid = candidates[0]
        self.stop_file = Path(stop_file or ROOT / 'runtime/sts2/STOP_INPUT')
        self.held_buttons, self.held_keys = set(), set()
        # A minimized window can report a zero-size client before focus() runs.
        # Restore it before taking the geometry baseline used by input guards.
        if self.user.IsIconic(self.hwnd):
            if not restore_minimized:
                raise RuntimeError('Game is minimized; observation does not restore or focus windows')
            self.user.ShowWindow.argtypes = [W.HWND, C.c_int]
            self.user.ShowWindow(self.hwnd, 9)
            time.sleep(.3)
        self.geometry = self.client_rect()
        self.deadline = time.monotonic() + 35
        self.events = []
        self.motion_trace = []

    def client_rect(self):
        rect, point = W.RECT(), W.POINT(0, 0)
        if not self.user.GetClientRect(self.hwnd, C.byref(rect)) or not self.user.ClientToScreen(self.hwnd, C.byref(point)):
            raise RuntimeError('Cannot map client area')
        if rect.right < 100 or rect.bottom < 100:
            raise RuntimeError('Invalid client dimensions')
        return (point.x, point.y, rect.right, rect.bottom)

    def focus(self):
        # Restore a minimized game before activation; refresh geometry only before
        # any input begins. During execution guard() still rejects changes.
        if self.user.IsIconic(self.hwnd):
            self.user.ShowWindow.argtypes = [W.HWND, C.c_int]
            self.user.ShowWindow(self.hwnd, 9)  # SW_RESTORE
            time.sleep(.3)
            self.geometry = self.client_rect()
        self.user.SetForegroundWindow(self.hwnd)
        # A CLI spawned by an editor may not own the foreground input queue.
        # Temporarily attach queues for activation, then detach before any game input.
        if self.user.GetForegroundWindow() != self.hwnd:
            self.user.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
            self.user.BringWindowToTop.argtypes = [W.HWND]
            own = self.kernel.GetCurrentThreadId()
            foreground = self.user.GetWindowThreadProcessId(self.user.GetForegroundWindow(), None)
            attached = own != foreground and bool(self.user.AttachThreadInput(own, foreground, True))
            try:
                self.user.BringWindowToTop(self.hwnd)
                self.user.SetForegroundWindow(self.hwnd)
            finally:
                if attached: self.user.AttachThreadInput(own, foreground, False)
        time.sleep(.25)
        self.guard()

    def guard(self):
        if self.stop_file.exists() or self.user.GetAsyncKeyState(0x77) & 0x8000:
            raise InterruptedError('F8 or STOP_INPUT requested stop')
        if time.monotonic() > self.deadline:
            raise TimeoutError('Input batch exceeded deadline')
        if self.user.GetForegroundWindow() != self.hwnd or self.user.IsIconic(self.hwnd):
            raise InterruptedError('Game lost foreground; input stopped')
        pid = W.DWORD()
        self.user.GetWindowThreadProcessId(self.hwnd, C.byref(pid))
        if pid.value != self.pid or self.client_rect() != self.geometry:
            raise InterruptedError('Game window changed; observe again')

    def send(self, event):
        if self.user.SendInput(1, C.byref(event), C.sizeof(Input)) != 1:
            raise OSError('SendInput failed (possible privilege mismatch)')

    def privileges(self):
        """SendInput returning success does not establish that an elevated game received it."""
        adv = C.WinDLL('advapi32', use_last_error=True)
        adv.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
        adv.GetTokenInformation.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD)]
        def elevated(pid):
            process = self.kernel.OpenProcess(0x1000, False, pid)
            token = W.HANDLE()
            try:
                if not process or not adv.OpenProcessToken(process, 8, C.byref(token)):
                    raise OSError('Cannot inspect process token')
                value, size = W.DWORD(), W.DWORD()
                if not adv.GetTokenInformation(token, 20, C.byref(value), 4, C.byref(size)):
                    raise OSError('Cannot inspect token elevation')
                return bool(value.value)
            finally:
                if token: self.kernel.CloseHandle(token)
                if process: self.kernel.CloseHandle(process)
        own, target = elevated(os.getpid()), elevated(self.pid)
        return {'controller_elevated': own, 'game_elevated': target,
                'privilege_compatible': own or not target}

    def relative(self, dx, dy, duration=.3):
        """Bounded relative counts for captured game cameras; never absolute screen coordinates."""
        started = time.monotonic()
        previous = (0, 0)
        while True:
            self.guard()
            t = min(1, (time.monotonic()-started)/duration)
            current = (round(dx*ease(t)), round(dy*ease(t)))
            mx, my = current[0]-previous[0], current[1]-previous[1]
            if mx or my:
                self.send(Input(type=0, mi=MouseInput(mx, my, 0, 1, 0, 0)))
            previous = current
            if t == 1: break
            time.sleep(1/120)

    def position(self, xy):
        x, y, w, h = self.geometry
        return round(x + xy[0]*(w-1)), round(y + xy[1]*(h-1))

    def wait(self, duration):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            self.guard()
            time.sleep(min(.008, max(0, end-time.monotonic())))

    def move(self, xy, duration=.7):
        self.guard()
        p = W.POINT()
        self.user.GetCursorPos(C.byref(p))
        x, y = self.position(xy)
        vx, vy = self.user.GetSystemMetrics(76), self.user.GetSystemMetrics(77)
        vw, vh = self.user.GetSystemMetrics(78), self.user.GetSystemMetrics(79)
        started = time.monotonic()
        while True:
            self.guard()
            t = min(1, (time.monotonic()-started)/duration)
            q = ease(t)
            px, py = round(p.x+(x-p.x)*q), round(p.y+(y-p.y)*q)
            self.send(Input(type=0, mi=MouseInput(round((px-vx)*65535/(vw-1)), round((py-vy)*65535/(vh-1)), 0, 0xC001, 0, 0)))
            actual = W.POINT()
            self.user.GetCursorPos(C.byref(actual))
            self.motion_trace.append({'at': time.time(), 'x': actual.x, 'y': actual.y,
                                      'left_down': bool(self.user.GetAsyncKeyState(1) & 0x8000),
                                      'right_down': bool(self.user.GetAsyncKeyState(2) & 0x8000)})
            if t == 1:
                break
            time.sleep(1/120)

    def button(self, button, down):
        self.guard()
        if down:
            point = W.POINT()
            self.user.GetCursorPos(C.byref(point))
            owner = self.user.GetAncestor(self.user.WindowFromPoint(point), 2)
            if owner != self.hwnd:
                raise InterruptedError('Pointer covered by another window')
        self.send(Input(type=0, mi=MouseInput(0, 0, 0, BUTTONS[button][0 if down else 1], 0, 0)))
        (self.held_buttons.add if down else self.held_buttons.discard)(button)

    def scroll(self, steps):
        for _ in range(abs(steps)):
            self.guard()
            point = W.POINT()
            self.user.GetCursorPos(C.byref(point))
            if self.user.GetAncestor(self.user.WindowFromPoint(point), 2) != self.hwnd:
                raise InterruptedError('Scroll target covered by another window')
            self.send(Input(type=0, mi=MouseInput(0, 0, (120 if steps > 0 else -120) & 0xFFFFFFFF, 0x800, 0, 0)))
            self.wait(.08)

    def key(self, name, down):
        self.guard()
        vk = KEYS[name.upper()]
        scan = self.user.MapVirtualKeyW(vk, 0)
        flags = 8 | (0 if down else 2) | (1 if vk in (0x25,0x26,0x27,0x28) else 0)
        self.send(Input(type=1, ki=KeyInput(0, scan, flags, 0, 0)))
        (self.held_keys.add if down else self.held_keys.discard)(name.upper())

    def release_all(self):
        # Releases deliberately bypass foreground/emergency guard to avoid stuck input.
        failures = []
        for button in list(self.held_buttons):
            try:
                self.send(Input(type=0, mi=MouseInput(0, 0, 0, BUTTONS[button][1], 0, 0)))
                self.held_buttons.discard(button)
            except OSError as ex:
                failures.append(str(ex))
        for name in list(self.held_keys):
            vk = KEYS[name]
            try:
                self.send(Input(type=1, ki=KeyInput(0, self.user.MapVirtualKeyW(vk, 0), 10 | (1 if vk in (0x25,0x26,0x27,0x28) else 0), 0, 0)))
                self.held_keys.discard(name)
            except OSError as ex:
                failures.append(str(ex))
        if failures:
            raise RuntimeError('Input release failed: ' + '; '.join(failures))

    def run(self, actions):
        validate(actions)
        self.deadline = time.monotonic()+35
        try:
            for a in actions:
                self.guard()
                t = a['action']
                button = a.get('button', 'left')
                duration, hold = a.get('duration', .7), a.get('hold', .08)
                started = time.perf_counter_ns()
                if t in ('move', 'click', 'scroll'):
                    self.move(a['to'], duration)
                if t == 'scroll':
                    self.scroll(a['steps'])
                if t == 'relative':
                    self.relative(a['dx'], a['dy'], duration)
                if t == 'drag':
                    self.move(a['from'], .7)
                    self.button(button, True)
                    self.wait(hold)
                    self.move(a['to'], duration)
                    self.wait(hold)
                    self.button(button, False)
                elif t == 'click':
                    self.button(button, True)
                    self.wait(hold)
                    self.button(button, False)
                elif t in ('down', 'up'):
                    self.button(button, t == 'down')
                elif t == 'key':
                    self.key(a['key'], True)
                    self.wait(hold)
                    self.key(a['key'], False)
                elif t in ('key_down', 'key_up'):
                    self.key(a['key'], t == 'key_down')
                elif t == 'wait':
                    self.wait(duration)
                self.events.append({'at': time.time(), 'started_ns': started,
                                    'finished_ns': time.perf_counter_ns(), **a})
        finally:
            self.release_all()
        return {'pid': self.pid, 'client_rect': self.geometry, 'events': self.events,
                'motion_trace': getattr(self, 'motion_trace', []),
                'held_buttons': list(self.held_buttons), 'held_keys': list(self.held_keys),
                'status': 'input_sent_not_game_verified'}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('file', type=Path, help='JSON action array')
    p.add_argument('--execute', action='store_true')
    p.add_argument('--focus', action='store_true')
    p.add_argument('--log', type=Path)
    p.add_argument('--exe', default='SlayTheSpire2.exe', help='Exact target executable name')
    args = p.parse_args()
    actions = validate(json.loads(args.file.read_text(encoding='utf-8-sig')))
    if not args.execute:
        print(json.dumps({'validated': True, 'actions': actions, 'note': 'Add --execute for visible input'}))
        return
    controller = NativeInput(exe=args.exe)
    error = None
    try:
        if not controller.privileges()['privilege_compatible']:
            raise RuntimeError('Game is elevated but controller is not; input was NOT sent')
        if args.focus:
            controller.focus()
        result = controller.run(actions)
    except (OSError, RuntimeError, ValueError) as ex:
        error = str(ex)
        result = {'status': 'stopped', 'error': error, 'events': controller.events,
                  'held_buttons': list(controller.held_buttons), 'held_keys': list(controller.held_keys)}
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {k:v for k,v in result.items() if k != 'motion_trace'}
    summary['motion_samples'] = len(result.get('motion_trace', []))
    print(json.dumps(summary, ensure_ascii=False))
    if error:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
