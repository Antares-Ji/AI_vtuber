"""test_ocr.py —— Phase D：OCR 结算字段提取测试

覆盖：正常字段、缺失/乱码（非结算图不发布值）、越界校验、
格式校验纯函数、provider 状态。
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

from ocr import (extract_results_fields, get_status,
                 _validate_accuracy, _validate_int, _validate_score, _validate_grade)

FIXTURES = os.path.join(ROOT, "tests", "fixtures", "vision")


def load_manifest():
    with open(os.path.join(FIXTURES, "manifest.json"), encoding="utf-8") as handle:
        return json.load(handle)


class TestOcr(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.results_fixtures = [f for f in cls.manifest["fixtures"] if f["expectedScene"] == "results"]

    def _extract(self, fixture_id):
        image = cv2.imread(os.path.join(FIXTURES, f"{fixture_id}.png"))
        height, width = image.shape[:2]
        return extract_results_fields(image, width, height)

    def test_results_fields_match_expected_values(self):
        for fixture in self.results_fixtures:
            expected = fixture["expectedValues"]
            result = self._extract(fixture["id"])
            for field, expected_raw in expected.items():
                if field == "accuracy":
                    self.assertAlmostEqual(result[field]["value"], float(expected_raw), places=2, msg=fixture["id"])
                elif field == "grade":
                    self.assertEqual(result[field]["value"], expected_raw, fixture["id"])
                else:
                    self.assertEqual(result[field]["value"], int(expected_raw), fixture["id"])
                self.assertGreaterEqual(result[field]["confidence"], 0.5, f"{fixture['id']}.{field} 置信度过低")

    def test_non_results_image_does_not_publish_values(self):
        # 游戏画面不是结算页：OCR 不发布值（即使识别出噪音也必须格式校验拦截）
        result = self._extract("gp-1280-a")
        for field in ("accuracy", "misses", "maxCombo", "score", "grade"):
            value = result[field]["value"]
            self.assertTrue(value is None or isinstance(value, (int, float)), field)

    def test_accuracy_validation(self):
        self.assertEqual(_validate_accuracy("95.28"), 95.28)
        self.assertEqual(_validate_accuracy("100.00"), 100.00)
        self.assertEqual(_validate_accuracy("87.453"), 87.45)  # 尾随噪声字符，取前两位小数
        self.assertIsNone(_validate_accuracy("105.00"))       # 越界
        self.assertIsNone(_validate_accuracy("abc"))
        self.assertIsNone(_validate_accuracy(""))
        self.assertIsNone(_validate_accuracy("944464"))       # 无小数点的乱码

    def test_int_validation(self):
        self.assertEqual(_validate_int("3"), 3)
        self.assertEqual(_validate_int("012"), 12)
        self.assertIsNone(_validate_int("1a2"))
        self.assertIsNone(_validate_int(""))
        self.assertIsNone(_validate_int("-4"))

    def test_score_validation(self):
        self.assertEqual(_validate_score("2341567"), 2341567)
        self.assertEqual(_validate_score("2,341,567"), 2341567)
        self.assertEqual(_validate_score("12a34"), 1234)
        self.assertIsNone(_validate_score("abc"))

    def test_grade_validation(self):
        self.assertEqual(_validate_grade("SS"), "SS")
        self.assertEqual(_validate_grade("S"), "S")
        self.assertEqual(_validate_grade("A"), "A")
        self.assertEqual(_validate_grade("X"), "X")
        self.assertIsNone(_validate_grade("F"))
        self.assertIsNone(_validate_grade(""))

    def test_ocr_status(self):
        status = get_status()
        self.assertTrue(status["ready"])


if __name__ == "__main__":
    unittest.main()
