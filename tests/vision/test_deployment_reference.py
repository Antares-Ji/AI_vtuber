import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('reference',ROOT/'scripts/deployment-reference-check.py')
reference=importlib.util.module_from_spec(spec);spec.loader.exec_module(reference)
RUN=ROOT/'runtime/vision/local-deployment/1789189001769'

class ReferenceTests(unittest.TestCase):
    def test_card_must_be_present_and_affordable(self):
        refs=ROOT/'data/vision/deployment-references/0-1'
        self.assertTrue(reference.inspect(refs/'battle-ready.png','battle-card')['ready'])
        dim=ROOT/'runtime/vision/local-deployment/1789191085417/1789191113209-capture.png'
        state=reference.inspect(dim,'battle-card')
        self.assertTrue(state['portrait_visible']);self.assertFalse(state['ready'])
        self.assertFalse(reference.inspect(refs/'landed.png','battle-card')['ok'])
        self.assertFalse(reference.inspect(refs/'result.png','battle-card')['ok'])
    def test_counter_background_does_not_delay_a_bright_card(self):
        image=ROOT/'runtime/vision/realtime-deployment/1789195968040/battle-seen.png'
        state=reference.inspect(image,'battle-card')
        self.assertGreater(state['counter_error'],20)
        self.assertTrue(state['ready'])
    def test_page_gates_reject_battle_and_result_confusion(self):
        refs=ROOT/'data/vision/deployment-references/0-1'
        self.assertTrue(reference.inspect(refs/'result.png','result')['ok'])
        self.assertFalse(reference.inspect(refs/'landed.png','result')['ok'])
        self.assertFalse(reference.inspect(refs/'stage-select.png','result')['ok'])
        self.assertTrue(reference.inspect(refs/'stage-select.png','stage-select')['ok'])
        self.assertFalse(reference.inspect(refs/'result.png','stage-select')['ok'])
        self.assertFalse(reference.inspect(refs/'landed.png','stage-select')['ok'])
    def test_actual_direction_frame_is_required(self):
        self.assertTrue(reference.inspect(RUN/'1789189020824-drag.png','direction')['ok'])
        self.assertFalse(reference.inspect(RUN/'1789189092091-drag.png','direction')['ok'])
    def test_model_false_success_is_rejected(self):
        self.assertTrue(reference.inspect(RUN/'1789189028120-drag.png','landed')['ok'])
        self.assertFalse(reference.inspect(RUN/'1789189099265-drag.png','landed')['ok'])
    def test_green_map_alignment_and_wrong_scene(self):
        self.assertTrue(reference.inspect(RUN/'1789189084774-click.png','tile')['ok'])
        self.assertFalse(reference.inspect(ROOT/'runtime/vlm/controller/1789146721942-capture.png','tile')['ok'])
    def test_fast_alignment_preserves_landing_and_rejects_wrong_scenes(self):
        for image in [RUN/'1789189084774-click.png',ROOT/'runtime/vision/realtime-deployment/1789195968040/selected.png']:
            with self.subTest(image=image):
                original=reference.inspect(image,'tile');fast=reference.inspect(image,'fast-tile')
                self.assertTrue(original['ok']);self.assertTrue(fast['ok'])
                for a,b in zip(original['target_point'],fast['target_point']):self.assertLess(abs(a-b),.005)
        for name in ['result.png','stage-select.png','battle-ready.png','landed.png']:
            self.assertFalse(reference.inspect(reference.REF/name,'fast-tile')['ok'],name)

if __name__=='__main__':unittest.main()
