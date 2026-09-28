import importlib.util,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('evidence',ROOT/'scripts/operator_evidence.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class RecoveryTests(unittest.TestCase):
    def test_ignores_sp_hp_and_summons(self):
        for text in ['技力自然回复速度+0.25/秒','回复生命值，获得8枚棋子','攻击力+120%，阻挡数+1']:
            self.assertEqual(m.recovery_kind(text)['kind'],'none_or_unknown')
    def test_separates_recovery_conditions(self):
        self.assertEqual(m.recovery_kind('停止攻击，持续时间内回复总共18点部署费用')['kind'],'over_time')
        self.assertEqual(m.recovery_kind('每次攻击获得1点部署费用')['kind'],'on_hit')
        self.assertEqual(m.recovery_kind('击杀敌人后获得2点部署费用')['kind'],'on_kill')
        self.assertEqual(m.recovery_kind('停止攻击，立即回复10点部署费用')['kind'],'immediate')
if __name__=='__main__':unittest.main()
