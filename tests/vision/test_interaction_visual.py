import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import cv2
import numpy as np

spec=importlib.util.spec_from_file_location('visual',Path(__file__).resolve().parents[2]/'src/vision/interaction-visual.py')
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class InteractionVisualTest(unittest.TestCase):
    def test_state_return_is_candidate_only(self):
        with tempfile.TemporaryDirectory(prefix='interaction-visual-test-') as tmp:
            folder=Path(tmp)
            a=np.full((240,320),80,np.uint8);b=a.copy();b[80:120,120:210]=220
            for name,im in [('a.jpg',a),('b.jpg',b)]:
                cv2.imencode('.jpg',im)[1].tofile(folder/name)
            actions=[]
            for i,(before,after) in enumerate([('a.jpg','b.jpg'),('b.jpg','a.jpg')],1):
                actions.append(dict(id=i,kind='short-click',start=dict(at=1000,x=150,y=100,width=320,height=240),frames=[
                    dict(phase='before',file=before,capturedAt=900),dict(phase='after',file=after,capturedAt=2000)]))
            actions.append(dict(id=3,kind='drag',start={},frames=[]))
            manifest=folder/'manifest.json';manifest.write_text(json.dumps(dict(analysis=actions)),encoding='utf-8')
            output=mod.analyze(manifest)
            self.assertEqual(output[0]['controlType'],'unknown')
            self.assertEqual(output[1]['controlType'],'two-state-candidate')
            self.assertTrue(all(not item['verified'] for item in output))
            self.assertNotIn('changedFraction',output[2])


if __name__=='__main__':unittest.main()
