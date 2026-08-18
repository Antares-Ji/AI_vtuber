"""features.py —— 圆形、边缘、颜色、布局特征（与场景分类解耦的底层特征）。

所有特征只返回数值与简短标签，不负责场景判定（判定在 scenes.py）。
"""
import cv2
import numpy as np


def circle_candidates(gray, width, height):
    """霍夫圆候选数量（上限 100）。"""
    blurred = cv2.GaussianBlur(gray, (7, 7), 1.4)
    circles = cv2.HoughCircles(
        blurred, cv2.HOUGH_GRADIENT, dp=1.2, minDist=max(18, width // 40),
        param1=100, param2=30, minRadius=max(8, width // 120), maxRadius=max(28, width // 14)
    )
    return 0 if circles is None else min(100, len(circles[0]))


def edge_density(gray):
    """Canny 边缘像素占比。"""
    edges = cv2.Canny(gray, 70, 150)
    return float((edges > 0).mean())


def brightness(gray):
    """灰度均值（0..1）。"""
    return float(gray.mean() / 255.0)


def saturated_ratio(image):
    """高饱和像素占比（用于识别强调色区域，不作为唯一依据）。"""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1].astype(np.float32) / 255.0
    return float((sat > 0.55).mean())


def dark_overlay_ratio(gray, baseline_mean=None):
    """暗化程度：相对基线亮度的降低比例（pause/fail 覆盖层特征）。"""
    current = float(gray.mean() / 255.0)
    if baseline_mean is None:
        return 0.0
    if baseline_mean <= 0.01:
        return 0.0
    return round(max(0.0, min(1.0, (baseline_mean - current) / baseline_mean)), 3)


def horizontal_stripes(image, min_stripes=3):
    """检测细水平条状结构（songSelect 列表特征）。

    对灰度图做行方向投影，统计"细亮带"（高度 <= 10% 图高）的数量，
    粗块（如桌面图标）不计入，避免与列表条混淆。
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height = gray.shape[0]
    row_mean = gray.mean(axis=1)  # (H,)
    kernel = np.ones(9) / 9.0
    smoothed = np.convolve(row_mean, kernel, mode="same")
    max_band_height = max(4, int(0.10 * height))
    bands = 0
    in_band = False
    band_start = 0
    threshold = smoothed.mean() + 3.0
    for y, value in enumerate(smoothed):
        if value > threshold:
            if not in_band:
                in_band = True
                band_start = y
        elif in_band:
            if y - band_start <= max_band_height:
                bands += 1
            in_band = False
    if in_band and len(smoothed) - band_start <= max_band_height:
        bands += 1
    return bands


def layout_box_count(image, min_area_ratio=0.02):
    """矩形区域候选数量（按色块轮廓，粗略布局复杂度）。"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    total = image.shape[0] * image.shape[1]
    count = 0
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w * h >= total * min_area_ratio and w > 10 and h > 10:
            count += 1
    return min(50, count)
