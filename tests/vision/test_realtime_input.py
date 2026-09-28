"""Fault injection for the local input loop; never sends operating-system input."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('realtime',ROOT/'scripts/realtime-deployment.py')
realtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(realtime)

class InputFailureTests(unittest.TestCase):
    def native(self):
        native=realtime.Native.__new__(realtime.Native)
        native.pressed=False
        native.u=Mock()
        native.u.SendInput.return_value=1
        native.u.GetAsyncKeyState.return_value=0
        native.move=Mock();native.verify=Mock()
        native.bounds=Mock(return_value=dict(left=557,top=236,width=2002,height=1282))
        return native

    def test_window_change_during_drag_releases_button(self):
        native=self.native();box=native.bounds()
        native.bounds.side_effect=[box,dict(box,left=600)]
        with patch.object(realtime.time,'sleep'),self.assertRaisesRegex(RuntimeError,'Window moved'):
            native.drag([.04,.93],[.75,.40],.09)
        self.assertFalse(native.pressed)
        native.u.mouse_event.assert_called_once_with(4,0,0,0,0)

    def test_foreground_loss_during_drag_releases_button(self):
        native=self.native();box=native.bounds()
        native.bounds.side_effect=[box,RuntimeError('Game lost foreground')]
        with patch.object(realtime.time,'sleep'),self.assertRaisesRegex(RuntimeError,'foreground'):
            native.drag([.04,.93],[.75,.40],.09)
        self.assertFalse(native.pressed)
        native.u.mouse_event.assert_called_once()

    def test_invalid_target_and_failed_pointer_check_never_press(self):
        for point in [[float('nan'),.4],[1.01,.4],[-.1,.4]]:
            native=self.native()
            with self.assertRaises(ValueError):native.click(point)
            native.u.SendInput.assert_not_called()
        native=self.native();native.verify.side_effect=RuntimeError('Wrong window')
        with patch.object(realtime.time,'sleep'),self.assertRaisesRegex(RuntimeError,'Wrong window'):
            native.click([.04,.93])
        native.u.SendInput.assert_not_called()
    def test_keyboard_press_is_released_on_interruption(self):
        native=self.native()
        with patch.object(realtime.time,'sleep',side_effect=RuntimeError('interrupted')),self.assertRaisesRegex(RuntimeError,'interrupted'):
            native.tap_f()
        self.assertEqual(native.u.SendInput.call_count,2)
    def test_keyboard_does_not_press_when_foreground_check_fails(self):
        native=self.native();native.bounds.side_effect=RuntimeError('Game lost foreground')
        with self.assertRaisesRegex(RuntimeError,'foreground'):native.tap_f()
        native.u.SendInput.assert_not_called()

if __name__=='__main__':unittest.main()
