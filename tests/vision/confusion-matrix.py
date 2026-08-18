"""confusion-matrix.py —— 输出合成图场景分类混淆矩阵（验收包用）。"""
import json
import os
import sys

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
ANALYZER_DIR = os.path.join(ROOT, "src", "vision", "python")
if ANALYZER_DIR not in sys.path:
    sys.path.insert(0, ANALYZER_DIR)
import scenes

FIXTURES = os.path.join(ROOT, "tests", "fixtures", "vision")
NAMES = ["gameplay", "results", "songSelect", "pause", "fail", "unknown"]

manifest = json.load(open(os.path.join(FIXTURES, "manifest.json"), encoding="utf-8"))
matrix = {expected: {predicted: 0 for predicted in NAMES} for expected in NAMES}
details = []
for fixture in manifest["fixtures"]:
    image = cv2.imread(os.path.join(FIXTURES, fixture["file"]))
    got = scenes.classify(image)["name"]
    matrix[fixture["expectedScene"]][got] += 1
    if got != fixture["expectedScene"]:
        details.append(f"{fixture['id']}: expected={fixture['expectedScene']} got={got}")

print("场景分类混淆矩阵（17 张合成图；真实样本 0 张 -> 真实准确率未评估）")
header = "          " + "".join(name[:4].ljust(10) for name in NAMES)
print(header)
for expected in NAMES:
    row = "".join(str(matrix[expected][p]).ljust(10) for p in NAMES)
    print(expected.ljust(10) + row)
total = sum(matrix[e][e] for e in NAMES)
count = len(manifest["fixtures"])
print(f"合成图总体正确率: {total}/{count} = {total / count * 100:.0f}%")
if details:
    print("误判明细:", " | ".join(details))
