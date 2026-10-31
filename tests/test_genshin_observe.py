import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts/sts2'))
from genshin_vision_schema import observation, evidence_image
spec = importlib.util.spec_from_file_location('genshin_observe', ROOT/'scripts/genshin/observe.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class ObserveTests(unittest.TestCase):
    def test_strict_model_schema(self):
        good = dict(scene='world', summary='草地', visible_text=['派蒙'], uncertain=False)
        self.assertEqual(observation(good), good)
        for value in [None, {**good, 'action': 'click'}, {**good, 'scene': 'unknown'},
                      {**good, 'uncertain': 1}, {**good, 'visible_text': ['x'*161]},
                      {**good, 'visible_text': ['x']*13}]:
            with self.assertRaises(ValueError):
                observation(value)

    def test_evidence_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)/'runtime/genshin/observations'
            file = base/str(uuid.uuid4())/'frame.png'
            file.parent.mkdir(parents=True); file.write_bytes(b'test')
            self.assertEqual(evidence_image(tmp, file), file.resolve())
            for p in [base/'frame.png', file.parent/'other.png', Path(tmp)/'frame.png']:
                with self.assertRaises(ValueError): evidence_image(tmp, p)

    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)/'runtime/genshin/observations'
            outside = Path(tmp)/'other'; outside.mkdir(); (outside/'frame.png').write_bytes(b'test')
            base.mkdir(parents=True); link = base/str(uuid.uuid4())
            try: link.symlink_to(outside, target_is_directory=True)
            except OSError: self.skipTest('Symlink creation unavailable')
            with self.assertRaises(ValueError): evidence_image(tmp, link/'frame.png')

    def controller(self, foreground=None, geometry=None):
        user = types.SimpleNamespace(GetForegroundWindow=foreground or (lambda: 7), IsIconic=lambda hwnd: False)
        return types.SimpleNamespace(hwnd=7, user=user, geometry=(100, 200, 1280, 720),
                                     client_rect=geometry or (lambda: (100, 200, 1280, 720)))

    def test_capture_uses_client_rectangle(self):
        def grab(box):
            self.assertEqual(box, dict(left=100, top=200, width=1280, height=720)); return 'frame'
        self.assertEqual(capture.capture_frame(self.controller(), grab), 'frame')

    def test_reject_foreground_loss_before_and_after_capture(self):
        for values in [[8], [7, 8]]:
            values = iter(values); calls = []
            c = self.controller(foreground=lambda: next(values))
            with self.assertRaisesRegex(RuntimeError, 'foreground'):
                capture.capture_frame(c, lambda box: calls.append(box))
            self.assertLessEqual(len(calls), 1)

    def test_geometry_change_and_pixel_limit(self):
        c = self.controller(geometry=lambda: (0, 0, 1280, 720))
        with self.assertRaisesRegex(RuntimeError, 'geometry'): capture.capture_frame(c, lambda _: None)
        c = self.controller(); c.geometry = (0, 0, 10000, 10000); c.client_rect = lambda: c.geometry
        with self.assertRaisesRegex(RuntimeError, 'pixel'): capture.capture_frame(c, lambda _: None)


if __name__ == '__main__': unittest.main()
