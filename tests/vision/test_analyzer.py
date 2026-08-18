"""test_analyzer.py —— Phase B 错误路径与数据契约测试（unittest，无第三方依赖）。

覆盖：正常图、空文件、损坏图、超大图、文件不存在、schema v2 契约。
用法：runtime/vision-env/Scripts/python.exe -m unittest discover -s tests/vision -p "test_*.py"
"""
import os
import sys
import unittest

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
ANALYZER_DIR = os.path.join(ROOT, "src", "vision", "python")
if ANALYZER_DIR not in sys.path:
    sys.path.insert(0, ANALYZER_DIR)

from analyzer import analyze
from quality import ImageError

FIXTURES = os.path.join(ROOT, "tests", "fixtures", "vision")
SCENE_ENUM = {"gameplay", "results", "songSelect", "pause", "fail", "unknown"}


class TestAnalyzer(unittest.TestCase):
    def _fixture(self, name):
        return os.path.join(FIXTURES, name)

    # ---------- 正常路径 ----------
    def test_gameplay_schema_v2(self):
        result = analyze(self._fixture("gp-1280-a.png"))
        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["scene"]["name"], "gameplay")
        self.assertEqual(result["frame"]["width"], 1280)
        self.assertEqual(result["frame"]["height"], 720)
        self.assertGreaterEqual(result["scene"]["confidence"], 0.0)
        self.assertLessEqual(result["scene"]["confidence"], 1.0)
        # gameplay 场景 circleCandidates 应为正整数
        self.assertGreater(result["gameplay"]["circleCandidates"], 0)

    def test_results_scene_detected(self):
        result = analyze(self._fixture("rs-1280-a.png"))
        self.assertEqual(result["scene"]["name"], "results")

    def test_unknown_black_screen(self):
        result = analyze(self._fixture("uk-black.png"))
        self.assertEqual(result["scene"]["name"], "unknown")

    # ---------- 契约 ----------
    def test_contract_enum_and_bounds(self):
        for name in ("gp-1280-b.png", "rs-1080-a.png", "ss-1280-a.png", "ps-1280-a.png", "fl-1280-a.png", "uk-noise.png"):
            result = analyze(self._fixture(name))
            self.assertIn(result["scene"]["name"], SCENE_ENUM, name)
            for field in result["results"].values():
                value = field["value"]
                confidence = field["confidence"]
                self.assertGreaterEqual(confidence, 0.0, name)
                self.assertLessEqual(confidence, 1.0, name)
                if value is not None:
                    self.assertNotIsInstance(value, bool, name)

    def test_null_not_zero_for_unrecognized(self):
        # OCR 未就绪时，results 字段必须为 null，不能用 0 冒充
        result = analyze(self._fixture("rs-1280-a.png"))
        self.assertEqual(result["results"]["accuracy"]["value"], None)
        self.assertIn("ocr-unavailable-fields-null", result["warnings"])

    # ---------- 错误路径 ----------
    def test_empty_file(self):
        path = os.path.join(FIXTURES, "_tmp_empty.png")
        open(path, "wb").close()
        try:
            with self.assertRaises(ImageError) as context:
                analyze(path)
            self.assertEqual(str(context.exception), "empty-file")
        finally:
            os.remove(path)

    def test_corrupt_file(self):
        path = os.path.join(FIXTURES, "_tmp_corrupt.png")
        with open(path, "wb") as handle:
            handle.write(b"\x89PNG\r\n\x1a\nnot-a-real-image-bytes" * 40)
        try:
            with self.assertRaises(ImageError) as context:
                analyze(path)
            self.assertEqual(str(context.exception), "decode-failed")
        finally:
            os.remove(path)

    def test_too_large_image(self):
        path = os.path.join(FIXTURES, "_tmp_large.png")
        big = np.zeros((3000, 2000, 3), np.uint8)  # 6M 像素 > 4M 上限
        cv2.imwrite(path, big)
        try:
            with self.assertRaises(ImageError) as context:
                analyze(path)
            self.assertEqual(str(context.exception), "too-many-pixels")
        finally:
            os.remove(path)

    def test_missing_file(self):
        with self.assertRaises(ImageError) as context:
            analyze(os.path.join(FIXTURES, "_does_not_exist.png"))
        self.assertEqual(str(context.exception), "file-not-found")


if __name__ == "__main__":
    unittest.main()
