"""Inspect game activation without sending game input."""
import json
from native_input import NativeInput

c = NativeInput()
def state():
    return {'hwnd': c.hwnd, 'foreground': c.user.GetForegroundWindow(),
            'minimized': bool(c.user.IsIconic(c.hwnd)), 'rect': c.client_rect()}
result = {'before': state(), 'privileges': c.privileges()}
try:
    c.focus()
except Exception as e:
    result['error'] = str(e)
result['after'] = state()
print(json.dumps(result))
