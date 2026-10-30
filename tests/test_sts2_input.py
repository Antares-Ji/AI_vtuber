import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sts2input', Path(__file__).resolve().parents[1]/'scripts/sts2/native_input.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Fake(m.NativeInput):
    def __init__(self):
        self.events = []
        self.held_buttons, self.held_keys = set(), set()
        self.released = False
        self.pid, self.geometry = 1, (0,0,800,600)
    def guard(self):
        pass
    def move(self, xy, duration=.7):
        if self.held_buttons:
            raise InterruptedError('Simulated foreground loss while dragging')
    def button(self, button, down):
        (self.held_buttons.add if down else self.held_buttons.discard)(button)
    def wait(self, duration):
        pass
    def release_all(self):
        self.held_buttons.clear()
        self.held_keys.clear()
        self.released = True


class InputTests(unittest.TestCase):
    def test_no_partial_execution_of_invalid_batch(self):
        f = Fake()
        with self.assertRaises(ValueError):
            f.run([{'action':'down'}, {'action':'key','key':'WIN'}])
        self.assertFalse(f.held_buttons)
        self.assertFalse(f.events)
    def test_release_on_interrupted_drag(self):
        f = Fake()
        with self.assertRaises(InterruptedError):
            f.run([{'action':'drag','from':[.2,.2],'to':[.5,.5]}])
        self.assertTrue(f.released)
        self.assertFalse(f.held_buttons)
    def test_invalid_coordinates_and_nonfinite_time(self):
        for action in [{'action':'click','to':[1.1,.5]}, {'action':'wait','duration':float('nan')}, {'action':'click','to':[True,.3]}]:
            with self.assertRaises(ValueError): m.validate([action])
    def test_client_origin_and_minimum_jerk(self):
        f=Fake(); f.geometry=(-1920,100,1600,900)
        self.assertEqual(f.position([0,0]),(-1920,100))
        self.assertEqual(f.position([1,1]),(-321,999))
        self.assertEqual(m.ease(0),0); self.assertEqual(m.ease(1),1)
        self.assertAlmostEqual(m.ease(.5),.5)

    def test_camera_rejects_unbounded_or_fractional_counts(self):
        for dx in [1201, -1201, True, .5, float('nan')]:
            with self.assertRaises(ValueError):
                m.validate([{'action':'relative', 'dx':dx, 'dy':0}])
        m.validate([{'action':'relative', 'dx':-120, 'dy':20, 'duration':.35}])


if __name__ == '__main__': unittest.main()
