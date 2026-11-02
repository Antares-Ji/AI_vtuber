import importlib.util,pathlib,tempfile,unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('genshin_window',ROOT/'scripts/genshin/window.py')
window=importlib.util.module_from_spec(spec);spec.loader.exec_module(window)

class Backend:
 def __init__(self,*,busy=False,compatible=True,minimized=True,restore_works=True):
  self.events=[];self.busy=busy;self.compatible=compatible;self.iconic=minimized;self.restore_works=restore_works
 def emergency(self):return False
 def acquire(self):
  self.events.append('lock')
  if self.busy:raise RuntimeError('Native input busy')
 def close(self):self.events.append('close')
 def target(self):self.events.append('target');return (5,42,123)
 def check_identity(self,target):self.events.append('identity')
 def privileges(self,target):self.events.append('permissions');return {'privilege_compatible':self.compatible}
 def minimized(self,target):return self.iconic
 def restore(self,target):
  self.events.append('restore')
  if self.restore_works:self.iconic=False
 def focus(self,target,cancel_file):self.events.append('focus');return [0,0,1920,1080]

class RestoreTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.stop=pathlib.Path(self.tmp.name)/'STOP_INPUT';self.stop.touch()
  self.cancel=pathlib.Path(self.tmp.name)/'cancel'
 def run_restore(self,backend,**kw):return window.restore(self.cancel,backend=backend,stop_marker=self.stop,**kw)
 def test_only_restores_after_lock_and_permission_check_without_clearing_stop(self):
  b=Backend();r=self.run_restore(b)
  self.assertTrue(r['restored']);self.assertTrue(r['focused']);self.assertFalse(r['inputSent']);self.assertFalse(r['verified'])
  self.assertLess(b.events.index('lock'),b.events.index('target'))
  self.assertLess(b.events.index('permissions'),b.events.index('restore'))
  self.assertEqual(b.events[-1],'close');self.assertTrue(self.stop.exists())
 def test_busy_or_incompatible_does_not_restore_or_focus(self):
  for b in [Backend(busy=True),Backend(compatible=False)]:
   with self.assertRaises(RuntimeError):self.run_restore(b)
   self.assertNotIn('restore',b.events);self.assertNotIn('focus',b.events);self.assertEqual(b.events[-1],'close')
 def test_cancelled_or_running_input_never_takes_window_ownership(self):
  b=Backend();self.cancel.touch()
  with self.assertRaises(InterruptedError):self.run_restore(b)
  self.assertEqual(b.events,[])
  self.cancel.unlink();self.stop.unlink()
  with self.assertRaises(RuntimeError):self.run_restore(b)
  self.assertEqual(b.events,[])
 def test_cancel_after_lock_releases_without_restoring(self):
  b=Backend()
  with self.assertRaises(InterruptedError):self.run_restore(b,cancelled=lambda:'lock' in b.events)
  self.assertEqual(b.events,['lock','close'])
 def test_restore_failure_never_reports_focused_success(self):
  b=Backend(restore_works=False)
  with self.assertRaisesRegex(RuntimeError,'remained minimized'):self.run_restore(b)
  self.assertNotIn('focus',b.events);self.assertEqual(b.events[-1],'close')
 def test_already_visible_window_skips_restore_but_checks_and_focuses(self):
  b=Backend(minimized=False);r=self.run_restore(b)
  self.assertFalse(r['restored']);self.assertNotIn('restore',b.events);self.assertIn('focus',b.events)

if __name__=='__main__':unittest.main()
