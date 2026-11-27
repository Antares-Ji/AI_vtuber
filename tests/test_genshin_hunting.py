import importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('import_hunting',ROOT/'scripts/genshin/import-hunting-routes.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
def point(i,kind='path',action=''):
 return {'id':i,'x':i,'y':i,'type':kind,'action':action,'move_mode':'walk'}
class HuntingImportTests(unittest.TestCase):
 def test_segments_end_at_first_fight_preserving_upstream_order(self):
  points=[point(1,'teleport'),point(2),point(3,action='fight'),point(4,action='fight'),point(5,'teleport'),point(6,action='fight')]
  data={'info':{'bgi_version':'0.52.0'},'positions':points}
  self.assertEqual(mod.segments(data),[points[:3],points[4:]])
 def test_no_custom_script_or_unknown_action_allowed(self):
  for p in [{**point(1,'teleport'),'action':'script'},{**point(1,'teleport'),'script':'run()'}]:
   with self.assertRaises(ValueError):mod.segments({'info':{'bgi_version':'0.52.0'},'positions':[p]})
if __name__=='__main__':unittest.main()
