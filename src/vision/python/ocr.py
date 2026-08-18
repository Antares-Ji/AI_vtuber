"""ocr.py —— 可替换 OCR provider（任务书 §5 Phase D）。

方案：OpenCV 自研数字/字母模板匹配（无外部依赖，可离线运行）。
- 模板由 cv2.putText 渲染（与合成图同源），对合成图有效；
  真实图准确率未评估，字段置信度不足时保持 null，绝不把猜测写成事实。
- 字段规则：accuracy 0.00~100.00；misses/combo/score 非负整数；
  grade 固定枚举；只有"格式 + 场景 + OCR 置信度"三重检查通过才发布值。
- OCR 原文只进入 debug，不直接成为 observation 事实。

降级：引擎缺失时 ready=false 且字段全 null（当前模板引擎总是可用，
但对真实样本标注"未评估"）。
"""
import os
import re
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import roi as roi_mod

# ---------------- 模板 ---------------- #
TEMPLATE_W, TEMPLATE_H = 20, 28
DIGITS = "0123456789."
GRADES = ["SS", "S", "A", "B", "C", "D", "X"]
_TEMPLATE_CACHE = None
OCR_CONFIDENCE_MIN = 0.50
CHAR_CONFIDENCE_MIN = 0.42


def _render_char(char, scale=1.0, thickness=2):
    """用与合成图相同的字体渲染单字符模板（白字黑底），并二值化。

    二值化保持与掩码字符同一匹配域（抗锯齿灰阶与二值掩码直接比较会失真）。
    """
    canvas = np.zeros((TEMPLATE_H * 3, TEMPLATE_W * 3), np.uint8)
    cv2.putText(canvas, char, (TEMPLATE_W, TEMPLATE_H * 2), cv2.FONT_HERSHEY_SIMPLEX,
                scale, 255, thickness, cv2.LINE_AA)
    ys, xs = np.where(canvas > 0)
    if len(xs) == 0:
        return np.zeros((TEMPLATE_H, TEMPLATE_W), np.uint8)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    crop = canvas[y0:y1 + 1, x0:x1 + 1]
    _, binary = cv2.threshold(crop, 127, 255, cv2.THRESH_BINARY)
    return cv2.resize(binary, (TEMPLATE_W, TEMPLATE_H), interpolation=cv2.INTER_AREA)


def _templates():
    """多字号模板池：scale x thickness 组合，匹配时取最优。"""
    global _TEMPLATE_CACHE
    if _TEMPLATE_CACHE is not None:
        return _TEMPLATE_CACHE
    pool = []
    for scale in (1.0, 1.6, 2.2):
        for thickness in (2, 3, 6):
            for char in DIGITS + "SSABCD":
                pool.append((char, scale, thickness, _render_char(char, scale, thickness)))
    _TEMPLATE_CACHE = pool
    return pool


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
    engines = _detect_engines()
    available = [name for name, ok in engines.items() if ok]
    return {
        "provider": "template-match",
        "ready": True,
        "detectedEngines": available,
        "note": "自研 OpenCV 模板匹配：合成图可测；真实图准确率未评估（无真实样本）。",
    }


# ---------------- 识别核心 ---------------- #
def _mask_for(image, mode):
    """提取目标颜色/灰度掩码。mode: green | yellow | red | gray。"""
    b = image[:, :, 0].astype(np.float32)
    g = image[:, :, 1].astype(np.float32)
    r = image[:, :, 2].astype(np.float32)
    if mode == "green":
        return ((g >= 90) & (g > r * 1.35) & (g > b * 1.15)).astype(np.uint8) * 255
    if mode == "yellow":
        return ((r >= 120) & (g >= 90) & (b < r * 0.75)).astype(np.uint8) * 255
    if mode == "red":
        return ((r >= 130) & (r > g * 1.15) & (r > b * 1.15)).astype(np.uint8) * 255
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def _split_chars(binary):
    """垂直投影分割字符连通列，返回 (x0, x1) 列表。"""
    col_sum = (binary > 0).sum(axis=0)
    chars = []
    start = None
    for x, active in enumerate(col_sum):
        if active and start is None:
            start = x
        elif not active and start is not None:
            if x - start >= 3:
                chars.append((start, x))
            start = None
    if start is not None and len(col_sum) - start >= 3:
        chars.append((start, len(col_sum)))
    return chars


def _recognize_char(cell, templates):
    cell = cv2.resize(cell, (TEMPLATE_W, TEMPLATE_H), interpolation=cv2.INTER_AREA).astype(np.float32)
    best_char, best_score = "", 0.0
    for char, _scale, _thickness, template in templates:
        template = template.astype(np.float32)
        score = 1.0 - np.abs(cell - template).mean() / 255.0
        if score > best_score:
            best_char, best_score = char, score
    return best_char, best_score


def _recognize_text(binary, templates, allowed_chars=None):
    """识别一串字符，返回 (text, mean_confidence)。"""
    chars = []
    scores = []
    for x0, x1 in _split_chars(binary):
        block = binary[:, x0:x1]
        ys, xs = np.where(block > 0)
        if len(xs) == 0:
            continue
        cell = block[ys.min():ys.max() + 1, :]
        cell = cell[:, xs.min():xs.max() - xs.min() + 1]
        if cell.shape[1] > TEMPLATE_W * 4 or cell.shape[0] < 6:
            continue  # 过宽/过矮的连通块忽略（可能是整行文字）
        char, score = _recognize_char(cell, templates)
        if allowed_chars is not None and char not in allowed_chars:
            continue
        if score >= CHAR_CONFIDENCE_MIN:
            chars.append(char)
            scores.append(score)
    if not chars:
        return None, 0.0
    return "".join(chars), float(np.mean(scores))


# ---------------- 字段提取与校验 ---------------- #
def _read_roi(image, x0, y0, x1, y1, mode, allowed_chars):
    height, width = image.shape[:2]
    box = roi_mod.pixel_box(x0, y0, x1, y1, width, height)
    if box is None:
        return None, 0.0
    px0, py0, px1, py1 = box
    region = image[py0:py1, px0:px1]
    mask = _mask_for(region, mode)
    text, confidence = _recognize_text(mask, _templates(), allowed_chars)
    return text, confidence


def _validate_accuracy(text):
    if not text:
        return None
    # 串可能含末尾 %（被识别成数字）；用搜索提取最合理的两位小数数值
    match = re.search(r"\d{1,3}(?:\.\d{1,2})", text)
    if not match:
        return None
    value = float(match.group(0))
    return value if 0.0 <= value <= 100.0 else None


def _validate_int(text):
    if not text or not text.isdigit():
        return None
    return int(text)


def _validate_score(text):
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    if not digits:
        return None
    return int(digits)


def _validate_grade(text):
    if not text:
        return None
    upper = text.upper()
    for grade in GRADES:
        if upper.startswith(grade):
            return grade
    return None


def extract_results_fields(image, width, height):
    """按归一化 ROI 提取结算字段。任何字段失败都返回 null（不伪造）。

    布局（实测：putText org 是基线即字符下缘，数字列 x≈0.51 起）：
      acc     大号绿字  x 0.51~0.70  y 0.29~0.35
      misses  红字      x 0.51~0.55  y 0.44~0.47
      maxCombo 橙字     x 0.51~0.55  y 0.54~0.57
      score   白字      x 0.51~0.64  y 0.64~0.67
      grade   黄字      x 0.57~0.59  y 0.20~0.24
    数字统一用灰度 Otsu（亮数字 vs 暗卡片）；grade 用黄色掩码。
    """
    fields = {
        "accuracy": _read_roi(image, 0.40, 0.27, 0.72, 0.37, "gray", "0123456789."),
        "misses": _read_roi(image, 0.40, 0.42, 0.60, 0.49, "gray", "0123456789"),
        "maxCombo": _read_roi(image, 0.40, 0.52, 0.60, 0.59, "gray", "0123456789"),
        "score": _read_roi(image, 0.40, 0.62, 0.72, 0.69, "gray", "0123456789"),
        "grade": _read_roi(image, 0.53, 0.18, 0.88, 0.26, "yellow", "SSABCD"),
    }
    validators = {
        "accuracy": _validate_accuracy,
        "misses": _validate_int,
        "maxCombo": _validate_int,
        "score": _validate_score,
        "grade": _validate_grade,
    }
    raw_debug = {}
    output = {}
    for name, (raw, confidence) in fields.items():
        raw_debug[name] = {"raw": raw, "confidence": round(confidence, 3)}
        value = validators[name](raw) if raw else None
        if value is not None and confidence >= OCR_CONFIDENCE_MIN:
            output[name] = {"value": value, "confidence": round(confidence, 3)}
        else:
            output[name] = {"value": None, "confidence": 0.0}
    return {**output, "debug": {"ocrReady": True, "raw": raw_debug}}
