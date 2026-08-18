"""analyzer.py —— v2 分析器入口与数据契约（schemaVersion 2，任务书 §4/§5 Phase B）。

用法：python analyzer.py <image_path>
- stdout 只输出一行 UTF-8 JSON（schema v2）。
- 日志写 stderr。
- 输入错误输出 {"error": ...} 并以非零码退出（受控错误，不挂住 Node）。

所有未识别值必须是 null（不允许用 0 冒充）；置信度限定 [0,1]；
scene.name 只能来自固定枚举 gameplay/results/songSelect/pause/fail/unknown。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import cv2

from quality import ImageError, load_validated, check_quality
import scenes
from ocr import extract_results_fields, get_status


def empty_scene():
    return {
        "name": "unknown",
        "confidence": 0.0,
        "candidates": {name: 0.0 for name in scenes.SCENE_NAMES},
        "evidence": [],
    }


def empty_field():
    return {"value": None, "confidence": 0.0}


def analyze(image_path):
    """核心分析：输入路径 -> schema v2 dict。输入错误抛 ImageError。"""
    image = load_validated(image_path)
    height, width = image.shape[:2]
    frame_quality = check_quality(image)
    warnings = list(frame_quality["warnings"])

    scene = empty_scene()
    gameplay = {
        "circleCandidates": 0,
        "combo": empty_field(),
        "health": empty_field(),
    }
    results = {key: empty_field() for key in ("accuracy", "misses", "maxCombo", "score", "grade")}

    if not frame_quality["usable"]:
        # 黑屏/过曝/模糊：质量不可用，全部未知
        scene["name"] = "unknown"
        scene["confidence"] = 0.6
        scene["candidates"]["unknown"] = 0.6
        scene["evidence"] = warnings
        warnings.append("quality-unusable")
        return build_schema(width, height, frame_quality, scene, gameplay, results, warnings, ocr_status=get_status())

    classified = scenes.classify(image)
    scene.update(classified)

    # gameplay 基础字段：只有场景为 gameplay 时才填 circleCandidates
    if scene["name"] == "gameplay":
        feats = scenes.compute_features(image)
        gameplay["circleCandidates"] = feats["circles"]
        gameplay["combo"] = {"value": None, "confidence": 0.0}
        gameplay["health"] = {"value": None, "confidence": 0.0}

    # 结算页字段：仅 results 场景尝试 OCR（OCR 未就绪时保持 null）
    if scene["name"] == "results":
        extracted = extract_results_fields(image, width, height)
        for key in ("accuracy", "misses", "maxCombo", "score", "grade"):
            results[key] = extracted.get(key, empty_field())
        if not get_status().get("ready"):
            warnings.append("ocr-unavailable-fields-null")

    return build_schema(width, height, frame_quality, scene, gameplay, results, warnings, ocr_status=get_status())


def build_schema(width, height, frame_quality, scene, gameplay, results, warnings, ocr_status=None):
    return {
        "schemaVersion": 2,
        "frame": {"width": width, "height": height, "quality": frame_quality},
        "scene": scene,
        "gameplay": gameplay,
        "results": results,
        "timingMs": {"total": 0},
        "warnings": warnings,
        "ocr": ocr_status or get_status(),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing image path"}, ensure_ascii=False))
        sys.exit(2)
    image_path = sys.argv[1]
    try:
        result = analyze(image_path)
        print(json.dumps(result, ensure_ascii=False))
    except ImageError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
    except Exception as error:  # 兜底：受控错误，不抛堆栈
        print(json.dumps({"error": f"internal: {type(error).__name__}: {str(error)[:200]}"}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
