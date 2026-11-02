import json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/sts2'))
from native_model_config import resolve_model_dir

class ModelConfigTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.model=self.root/'runtime/vlm/models/Qwen3-VL-4B-Instruct'
        self.model.mkdir(parents=True)
        (self.model/'config.json').write_text(json.dumps({'model_type':'qwen3_vl'}))
    def test_default_and_explicit_local_models(self):
        (self.model/'model.safetensors').write_bytes(b'fixture')
        self.assertEqual(resolve_model_dir(self.root),self.model.resolve())
        self.assertEqual(resolve_model_dir(self.root,str(self.model)),self.model.resolve())
        self.assertEqual(resolve_model_dir(self.root,str(self.model.relative_to(self.root))),self.model.resolve())
    def test_incomplete_or_empty_checkpoint_is_rejected(self):
        for content in [None,b'']:
            if content is not None:(self.model/'model.safetensors').write_bytes(content)
            with self.assertRaises(ValueError):resolve_model_dir(self.root)
    def test_index_cannot_escape_the_selected_checkpoint(self):
        outside=self.root/'outside.safetensors';outside.write_bytes(b'fixture')
        (self.model/'model.safetensors.index.json').write_text(json.dumps({'weight_map':{'layer':str(outside)}}))
        with self.assertRaises(ValueError):resolve_model_dir(self.root)
    def test_all_indexed_shards_and_correct_architecture_are_required(self):
        (self.model/'model.safetensors.index.json').write_text(json.dumps({'weight_map':{'a':'one.safetensors','b':'two.safetensors'}}))
        (self.model/'one.safetensors').write_bytes(b'one')
        with self.assertRaises(ValueError):resolve_model_dir(self.root)
        (self.model/'two.safetensors').write_bytes(b'two')
        self.assertEqual(resolve_model_dir(self.root),self.model.resolve())
        (self.model/'config.json').write_text(json.dumps({'model_type':'other'}))
        with self.assertRaises(ValueError):resolve_model_dir(self.root)

if __name__=='__main__':unittest.main()
