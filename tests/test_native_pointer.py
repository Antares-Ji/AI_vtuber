from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_pointer import relative_move
from native_input import validate


class PointerTests(unittest.TestCase):
    def run_motion(self, gain=1, stuck=False, guard=lambda: None):
        point = [-1500, 100]; target = [-1150, 420]; now = [0]; calls = []
        def send(dx, dy):
            calls.append((dx, dy))
            if not stuck:
                point[0] += dx*gain; point[1] += dy*gain
        def sleep(dt): now[0] += dt
        value = relative_move(target, lambda: tuple(point), send, guard,
                              clock=lambda: now[0], sleep=sleep)
        return target, value, calls, now[0]

    def test_measured_position_converges_with_acceleration(self):
        for gain in [1, 2, 4]:
            target, actual, calls, elapsed = self.run_motion(gain)
            self.assertLessEqual(max(abs(target[i]-actual[i]) for i in (0, 1)), 2)
            self.assertTrue(calls)
            self.assertTrue(all(abs(x)<=12 and abs(y)<=12 for x,y in calls))
            self.assertLess(elapsed, 1.85)

    def test_stuck_pointer_times_out_without_absolute_fallback(self):
        with self.assertRaisesRegex(TimeoutError, 'did not reach'):
            self.run_motion(stuck=True)

    def test_foreground_or_cancel_guard_aborts_before_sending(self):
        def guard(): raise InterruptedError('stopped')
        with self.assertRaises(InterruptedError): self.run_motion(guard=guard)

    def test_already_at_target_needs_no_jitter(self):
        now=[0];calls=[]
        def sleep(dt):now[0]+=dt
        result=relative_move([50,50],lambda:(50,50),lambda *v:calls.append(v),lambda:None,
                             clock=lambda:now[0],sleep=sleep)
        self.assertEqual(result,(50,50));self.assertEqual(calls,[])

    def test_mode_cannot_change_click_drag_or_raw_relative_actions(self):
        self.assertEqual(validate([{'action':'move','to':[.5,.5],'pointer_mode':'relative'}])[0]['pointer_mode'],'relative')
        for action in ['click','drag','relative','key']:
            with self.assertRaisesRegex(ValueError,'pointer_mode'):
                validate([{'action':action,'pointer_mode':'relative'}])
        with self.assertRaisesRegex(ValueError,'pointer_mode'):
            validate([{'action':'move','to':[.5,.5],'pointer_mode':'invalid'}])


if __name__ == '__main__': unittest.main()
