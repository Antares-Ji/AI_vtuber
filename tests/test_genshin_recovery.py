import importlib.util,pathlib,unittest
root=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('recovery',root/'scripts/genshin/menu-recovery.py');recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)
class RecoveryTests(unittest.TestCase):
 def test_one_escape_and_release_through_native_controller(self):
  calls=[]
  class Native:
   def __init__(self,target,**kwargs):calls.append(target)
   def focus(self):calls.append('focus')
   def run(self,actions):calls.extend(actions);return {'status':'input_sent_not_game_verified'}
   def release_all(self):calls.append('release')
  r=recovery.return_one_level(pathlib.Path('cancel'),lambda:False,Native)
  self.assertEqual([c['key'] for c in calls if isinstance(c,dict) and 'key' in c],['ESC'])
  self.assertEqual(calls[-1],'release');self.assertFalse(r['verified'])
 def test_cancel_before_input(self):
  with self.assertRaises(InterruptedError):recovery.return_one_level(None,lambda:True,lambda *a,**k:self.fail('must not create controller'))
if __name__=='__main__':unittest.main()
