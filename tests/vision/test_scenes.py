"""test_scenes.py —— Phase C：场景分类 v2 测试矩阵

对 tests/fixtures/vision/manifest.json 的全部合成图断言：
- 每张图识别为 manifest 期望场景
- 候选分数完整且限定 [0,1]
- 输出包含 evidence
- 低置信度负样本落入 unknown

用法：runtime/vision-env/Scripts/python.exe -m unittest discover -s tests/vision -p "test_*.py"
"""
import json
import os
import sys
import unittest

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
ANALYZER_DIR = os.path.join(ROOT, "src", "vision", "python")
if ANALYZER_DIR not in sys.path:
    sys.path.insert(0, ANALYZER_DIR)

import scenes

FIXTURES = os.path.join(ROOT, "tests", "fixtures", "vision")
SCENE_ENUM = {"gameplay", "results", "songSelect", "pause", "fail", "unknown"}


def load_manifest():
    with open(os.path.join(FIXTURES, "manifest.json"), encoding="utf-8") as handle:
        return json.load(handle)


class TestScenes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()

    def test_all_fixtures_match_expected_scene(self):
        for fixture in self.manifest["fixtures"]:
            image = cv2.imread(os.path.join(FIXTURES, fixture["file"]))
            self.assertIsNotNone(image, fixture["file"])
            result = scenes.classify(image)
            self.assertEqual(
                result["name"], fixture["expectedScene"],
                f"{fixture['id']}: got {result['name']} candidates={result['candidates']} evidence={result['evidence']}"
            )

    def test_candidates_complete_and_bounded(self):
        for fixture in self.manifest["fixtures"]:
            image = cv2.imread(os.path.join(FIXTURES, fixture["file"]))
            result = scenes.classify(image)
            self.assertEqual(set(result["candidates"].keys()), SCENE_ENUM, fixture["id"])
            for value in result["candidates"].values():
                self.assertGreaterEqual(value, 0.0, fixture["id"])
                self.assertLessEqual(value, 1.0, fixture["id"])
            self.assertGreaterEqual(result["confidence"], 0.0, fixture["id"])
            self.assertLessEqual(result["confidence"], 1.0, fixture["id"])

    def test_evidence_present_on_recognized(self):
        for fixture in self.manifest["fixtures"]:
            if fixture["expectedScene"] == "unknown":
                continue
            image = cv2.imread(os.path.join(FIXTURES, fixture["file"]))
            result = scenes.classify(image)
            self.assertTrue(result["evidence"], f"{fixture['id']} 缺少 evidence")

    def test_negative_samples_land_unknown_or_low(self):
        # 黑屏/噪声/渐变/桌面：不能误判为 gameplay/results/pause/fail
        for fixture in self.manifest["fixtures"]:
            if not fixture["id"].startswith("uk-"):
                continue
            image = cv2.imread(os.path.join(FIXTURES, fixture["file"]))
            result = scenes.classify(image)
            self.assertNotIn(result["name"], {"gameplay", "results", "pause", "fail"}, fixture["id"])
            # 护栏 unknown 固定置信度 0.6（确定是未知），其余情况应低于阈值 0.42
            if result["name"] == "unknown":
                self.assertLessEqual(result["confidence"], 0.6, fixture["id"])
            else:
                self.assertLess(result["confidence"], 0.5, fixture["id"])

    def test_three_resolutions_covered(self):
        resolutions = {fixture["resolution"] for fixture in self.manifest["fixtures"]}
        self.assertIn("1280x720", resolutions)
        self.assertIn("1920x1080", resolutions)
        self.assertTrue(any(r != "1280x720" and r != "1920x1080" for r in resolutions), "缺少非 16:9 分辨率")


if __name__ == "__main__":
    unittest.main()
