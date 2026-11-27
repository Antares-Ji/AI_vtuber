import sys,pathlib,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts/sts2'))
from genshin_vision_schema import enemy_observation
class EnemyScanTests(unittest.TestCase):
    def test_unknown_cannot_claim_complete_identification(self):
        result=enemy_observation({'enemies':[{'kind':'unknown','evidence':'模糊'}],'allVisibleHostilesIdentified':True,'uncertain':False})
        self.assertTrue(result['uncertain'])
        self.assertFalse(result['allVisibleHostilesIdentified'])
    def test_requires_explicit_type_and_evidence(self):
        for item in [{'kind':'water','evidence':'blue'},{'kind':'hydro_slime','evidence':''},{'kind':'hydro_slime','evidence':'蓝色','point':[1,2]}]:
            with self.assertRaises(ValueError):enemy_observation({'enemies':[item],'allVisibleHostilesIdentified':True,'uncertain':False})
if __name__=='__main__':unittest.main()
