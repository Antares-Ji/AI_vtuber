import importlib.util
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('sts2vision', Path(__file__).resolve().parents[1]/'scripts/sts2/vision_worker.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class VisionCommentaryTests(unittest.TestCase):
    def test_changed_game_with_unchanged_capture_is_not_new_evidence(self):
        engine=object.__new__(m.Engine)
        engine.capture_evidence=None;engine.analyze=Mock(return_value={})
        replies=[io.BytesIO(b'{"hp":80}'),io.BytesIO(b'old frame'),
                 io.BytesIO(b'{"hp":70}'),io.BytesIO(b'old frame')]
        with tempfile.TemporaryDirectory() as directory, patch.object(m,'BASE',Path(directory)), patch.object(m,'urlopen',side_effect=replies):
            engine.capture()
            with self.assertRaisesRegex(RuntimeError,'捕获画面未更新'):
                engine.capture()
        self.assertEqual(engine.analyze.call_count,1)

    def test_unupgradable_card_and_human_input_attribution(self):
        prompt=m.commentary_prompt({'id':'X','name':'伤口','base':{'cost':-1,'description':'无法打出。'},'upgraded':None})
        self.assertIn('升级后：无',prompt)
        self.assertIn('不说是你操作的',prompt)

    def test_speech_failure_isolated_from_learning(self):
        engine=object.__new__(m.Engine)
        engine.speech_lock=threading.Lock();engine.said=set()
        engine.status={'last_error':None,'commentary_busy':False}
        card={'id':'X','name':'测试','base':{'cost':1,'description':'测试。'}}
        with patch.object(m,'urlopen',side_effect=TimeoutError('speech timed out')):
            engine.speak(card)
        self.assertIsNone(engine.status['last_error'])
        self.assertEqual(engine.status['commentary_error'],'speech timed out')
        self.assertFalse(engine.status['commentary_busy'])
        self.assertFalse(engine.speech_lock.locked())
        self.assertNotIn('X',engine.said)


if __name__=='__main__': unittest.main()
