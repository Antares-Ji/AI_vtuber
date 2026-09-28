import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
import cv2
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from local_stage_session import Session


class SessionEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.session=Session.__new__(Session)
        self.session.out=Path(self.temp.name)

    def events(self):
        return [json.loads(line) for line in (self.session.out/'events.jsonl').read_text(encoding='utf8').splitlines()]

    def test_failed_request_is_unknown_and_logged(self):
        self.session.request=Mock(side_effect=RuntimeError('connection lost'))
        with self.assertRaises(RuntimeError):self.session.control('click',xRatio=.5,yRatio=.5)
        self.assertEqual([r['event'] for r in self.events()],['control_requested','control_failed'])
        self.assertEqual(self.events()[-1]['outcome'],'unknown')

    def test_controller_live_image_is_copied(self):
        source=self.session.out/'live.png'
        cv2.imwrite(str(source),np.zeros((10,10,3),np.uint8))
        original=source.read_bytes()
        self.session.request=Mock(return_value={'ok':True,'path':str(source)})
        response=self.session.control('capture')
        source.write_bytes(b'replaced')
        self.assertEqual(Path(response['evidence_path']).read_bytes(),original)
        self.assertEqual(len(response['evidence_sha256']),64)

    def test_repeated_capture_keeps_both_evidence_files(self):
        source=self.session.out/'live.png'
        cv2.imwrite(str(source),np.zeros((10,10,3),np.uint8))
        self.session.control=Mock(return_value={'evidence_path':str(source)})
        self.session.capture('before')
        cv2.imwrite(str(source),np.ones((10,10,3),np.uint8)*255)
        self.session.capture('before')
        rows=self.events()
        self.assertNotEqual(rows[0]['path'],rows[1]['path'])
        self.assertNotEqual(rows[0]['sha256'],rows[1]['sha256'])
        self.assertTrue(all(Path(row['path']).exists() for row in rows))
        self.assertTrue((self.session.out/'before.png').exists())

    def test_surface_fallback_cannot_escape_map_crop(self):
        self.session.capture=Mock(return_value=np.zeros((1024,1600,3),np.uint8))
        self.session.locate=Mock(return_value=None)
        self.session.analyze=Mock(return_value={'x':1000,'y':1000})
        self.session.control=Mock(return_value={'ok':True})
        self.session.click_target('blank map',(250,620,950,850),surface=True)
        self.assertEqual(self.session.analyze.call_args.kwargs['crop'],(250,620,950,850))
        self.session.control.assert_called_once_with('click',xRatio=950/1600,yRatio=850/1024)


if __name__=='__main__':unittest.main()
