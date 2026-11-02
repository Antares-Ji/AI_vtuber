import importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
def module(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'scripts/genshin'/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
capture=module('bettergi-capture');supervisor=module('bridge-supervisor')
class BridgeTests(unittest.TestCase):
 def test_restore_window_preserves_owner_and_cancel_checks_without_input(self):
  with tempfile.TemporaryDirectory() as tmp:
   cancel=pathlib.Path(tmp)/'cancel';owner={'alive':True};seen=[]
   def restore(file,*,cancelled):
    self.assertEqual(file,cancel);self.assertFalse(cancelled());seen.append(file)
    owner['alive']=False;self.assertTrue(cancelled());owner['alive']=True
    return {'inputSent':False,'verified':False,'focused':True,'pid':42}
   result=supervisor.restore_window(cancel,lambda:owner['alive'],restore)
   self.assertFalse(result['inputSent']);self.assertEqual(len(seen),1)
   self.assertEqual(supervisor.SUPERVISOR_VERSION,9)
 def test_restore_window_cancel_never_runs_or_reports_success(self):
  with tempfile.TemporaryDirectory() as tmp:
   cancel=pathlib.Path(tmp)/'cancel';calls=[]
   def forbidden(*args,**kwargs):calls.append(1);raise AssertionError('unexpected restore')
   with self.assertRaises(InterruptedError):supervisor.restore_window(cancel,lambda:False,forbidden)
   cancel.touch()
   with self.assertRaises(InterruptedError):supervisor.restore_window(cancel,lambda:True,forbidden)
   self.assertEqual(calls,[])
   cancel.unlink()
   def interrupted(file,*,cancelled):
    file.touch();self.assertTrue(cancelled())
    return {'inputSent':False,'verified':False,'focused':True}
   with self.assertRaisesRegex(InterruptedError,'during'):supervisor.restore_window(cancel,lambda:True,interrupted)
 def test_restore_window_rejects_incomplete_or_input_sending_receipt(self):
  with tempfile.TemporaryDirectory() as tmp:
   for value in [None,{}, {'inputSent':True,'verified':False,'focused':True}, {'inputSent':False,'verified':True,'focused':True}]:
    with self.assertRaisesRegex(RuntimeError,'Invalid window restore receipt'):
     supervisor.restore_window(pathlib.Path(tmp)/'cancel',lambda:True,lambda *args,**kwargs:value)
 def test_receipt_replace_retries_transient_windows_denial_atomically(self):
  with tempfile.TemporaryDirectory() as tmp:
   file=pathlib.Path(tmp)/'status.json';file.write_text('{"busy":false}')
   replace=supervisor.os.replace;attempts=[]
   def flaky(source,target):
    attempts.append(source)
    self.assertEqual(json.loads(file.read_text()),{'busy':False})
    if len(attempts)<3:raise PermissionError('simulated sharing violation')
    replace(source,target)
   with patch.object(supervisor.os,'replace',side_effect=flaky),patch.object(supervisor.time,'sleep'):
    supervisor.write(file,{'busy':True})
   self.assertEqual(json.loads(file.read_text()),{'busy':True});self.assertEqual(len(attempts),3)
   self.assertEqual(list(pathlib.Path(tmp).glob('*.tmp')),[])
 def test_permanent_receipt_denial_does_not_publish_success(self):
  with tempfile.TemporaryDirectory() as tmp:
   file=pathlib.Path(tmp)/'status.json';file.write_text('{"busy":true}')
   with patch.object(supervisor.os,'replace',side_effect=PermissionError('permanent')),patch.object(supervisor.time,'sleep'):
    with self.assertRaises(PermissionError):supervisor.write(file,{'busy':False})
   self.assertEqual(json.loads(file.read_text()),{'busy':True});self.assertEqual(list(pathlib.Path(tmp).glob('*.tmp')),[])
 def test_capture_configuration_restores_only_its_own_values(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);(root/'User').mkdir();script=root/'script';script.mkdir();file=root/'User/config.json'
   config={'hotKeyConfig':{'takeScreenshotHotkey':'','takeScreenshotHotkeyType':'KeyboardMonitor'},'autoPickConfig':{'enabled':True,'other':12},'unrelated':1};file.write_text(json.dumps(config))
   changes=capture.prepare(root,script);current=json.loads(file.read_text());self.assertEqual(current['hotKeyConfig']['takeScreenshotHotkey'],'F9');self.assertFalse(current['autoPickConfig']['enabled'])
   current['unrelated']=2;file.write_text(json.dumps(current));capture.restore(root,changes);restored=json.loads(file.read_text());self.assertEqual(restored['autoPickConfig'],config['autoPickConfig']);self.assertEqual(restored['hotKeyConfig'],config['hotKeyConfig']);self.assertEqual(restored['unrelated'],2)
 def test_existing_shortcut_collision_does_not_modify_config(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);(root/'User').mkdir();file=root/'User/config.json';data=json.dumps({'hotKeyConfig':{'cancelTaskHotkey':'F9'}});file.write_text(data)
   with self.assertRaises(RuntimeError):capture.prepare(root,root)
   self.assertEqual(file.read_text(),data)
 def test_routes_reject_outside_paths_and_invalid_route_files(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);folder=root/'User/AutoPathing';folder.mkdir(parents=True);(folder/'ok.json').write_text(json.dumps({'positions':[{'x':0,'y':0}]}));(folder/'bad.json').write_text('{}');(root/'User/secret.json').write_text(json.dumps({'positions':[{}]}))
   self.assertEqual(supervisor.route_file(root,'user:ok.json'),folder/'ok.json')
   for route in ['user:../secret.json','user:bad.json','other:ok.json']:
    with self.assertRaises(ValueError):supervisor.route_file(root,route)
if __name__=='__main__':unittest.main()
