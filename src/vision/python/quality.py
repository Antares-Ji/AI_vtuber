"""quality.py —— 图像质量检查：解码验证、尺寸限制、亮度、模糊、黑屏。

输入安全（任务书 §5 Phase B）：限制像素总数、验证解码结果、
拒绝超大/空/损坏文件。所有失败以 ImageError 抛出，由 analyzer 转为受控 JSON。
"""
import os

import cv2

MAX_PIXELS = 4_000_000      # 约 2000x2000，防止超大图拖垮分析
MIN_DIMENSION = 32          # 小于此尺寸的图没有分析价值
BLACK_BRIGHTNESS = 0.04
BLUR_MIN = 12.0             # Laplacian 方差阈值，低于视为模糊
BLUR_NOISE_MAX = 800.0      # Laplacian 方差阈值，高于视为高频噪声（如随机噪点）


class ImageError(Exception):
    """受控的图像输入错误。"""


def load_validated(image_path):
    """解码并验证图像。失败抛 ImageError（不抛 OSError/cv2 原生异常）。"""
    if not os.path.exists(image_path):
        raise ImageError("file-not-found")
    if os.path.getsize(image_path) == 0:
        raise ImageError("empty-file")
    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None:
        raise ImageError("decode-failed")
    height, width = image.shape[:2]
    if height < MIN_DIMENSION or width < MIN_DIMENSION:
        raise ImageError("too-small")
    if height * width > MAX_PIXELS:
        raise ImageError("too-many-pixels")
    return image


def check_quality(image):
    """亮度 / 模糊 / 黑屏 / 高频噪声检查。返回 {brightness, blur, usable, warnings}。"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    brightness = float(gray.mean() / 255.0)
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    warnings = []
    if brightness < BLACK_BRIGHTNESS:
        warnings.append("black-screen")
    elif brightness > 0.97:
        warnings.append("overexposed")
    if blur < BLUR_MIN:
        warnings.append("blurry")
    elif blur > BLUR_NOISE_MAX:
        warnings.append("high-frequency-noise")
    usable = (brightness >= BLACK_BRIGHTNESS and brightness <= 0.97
              and BLUR_MIN <= blur <= BLUR_NOISE_MAX)
    return {
        "brightness": round(brightness, 3),
        "blur": round(blur, 3),
        "usable": usable,
        "warnings": warnings,
    }
