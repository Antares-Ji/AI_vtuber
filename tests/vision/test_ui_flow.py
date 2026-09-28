import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
import cv2
import numpy as np

spec=importlib.util.spec_from_file_location('ui_flow',Path(__file__).resolve().parents[2]/'src/vision/ui-flow.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)


class FlowTest(unittest.TestCase):
    def test_unknown_and_scroll_are_candidates(self):
        rng=np.random.default_rng(20)
        doc=cv2.GaussianBlur(rng.integers(0,255,(1100,500,3),np.uint8),(3,3),0)
        with tempfile.TemporaryDirectory(prefix='ui-flow-test-') as tmp:
            folder=Path(tmp);frames=[]
            for i,offset in enumerate([0,150,300]):
                im=np.full((650,720,3),40,np.uint8);im[90:590,180:680]=doc[offset:offset+500]
                name=f'frame-{i+1:03}.jpg';cv2.imencode('.jpg',im,[cv2.IMWRITE_JPEG_QUALITY,94])[1].tofile(folder/name);frames.append(dict(file=name))
            manifest=folder/'manifest.json';manifest.write_text(json.dumps(dict(frames=frames)),encoding='utf-8')
            flow=mod.build(manifest)
            self.assertEqual(len(flow['nodes']),1)
            self.assertTrue(flow['images'])
            self.assertIsNone(flow['nodes'][0]['parentPage'])
            self.assertFalse(flow['verified'])
            self.assertTrue(all(e['kind']=='scroll-overlap-candidate' for e in flow['edges']))


if __name__=='__main__':unittest.main()
