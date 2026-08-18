"""ocr.py —— 可替换 OCR provider（任务书 §5 Phase D）。

抽象为 provider：检测当前环境可用的 OCR 方案；引擎缺失时必须降级为
ready=false 且字段返回 null，而不是崩溃。

当前实现状态：
- Phase B：provider 骨架 + 状态检测（模板匹配引擎尚未实现 -> ready=false）。
- Phase D：实现自研 OpenCV 数字模板匹配（对程序生成的合成图有效；
  真实图准确率未评估，字段置信度不足时保持 null）。
"""
import os

# 未来可选引擎检测（避免在 Phase B 引入依赖）
def _detect_engines():
    engines = {}
    for name, spec in (("pytesseract", "pytesseract"), ("easyocr", "easyocr"), ("paddleocr", "paddleocr")):
        try:
            __import__(spec)
            engines[name] = True
        except ImportError:
            engines[name] = False
    return engines


def get_status():
    """返回 OCR provider 状态。当前只有自研模板匹配（模板引擎在 Phase D 接入）。"""
    engines = _detect_engines()
    available = [name for name, ok in engines.items() if ok]
    return {
        "provider": "template-match" if False else "none",
        "ready": False,
        "detectedEngines": available,
        "note": "未检测到可用 OCR 引擎；结算字段保持 null，不伪造识别结果。",
    }


def extract_results_fields(image, width, height):
    """按 ROI 提取结算字段。引擎未就绪时全部返回 null（不崩溃）。"""
    return {
        "accuracy": {"value": None, "confidence": 0.0},
        "misses": {"value": None, "confidence": 0.0},
        "maxCombo": {"value": None, "confidence": 0.0},
        "score": {"value": None, "confidence": 0.0},
        "grade": {"value": None, "confidence": 0.0},
        "debug": {"ocrReady": False, "raw": None},
    }
