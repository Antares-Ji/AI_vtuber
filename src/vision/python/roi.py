"""roi.py —— 归一化 ROI 与坐标转换（任务书 §5 Phase C）。

所有 ROI 使用相对坐标 [0,1]，与分辨率无关；不同 skin 的颜色不作为唯一依据。
"""
import cv2
import numpy as np


def pixel_box(x0, y0, x1, y1, width, height):
    """归一化坐标 -> 像素坐标（自动裁剪越界）。"""
    px0 = max(0, int(x0 * width))
    py0 = max(0, int(y0 * height))
    px1 = min(width, int(x1 * width))
    py1 = min(height, int(y1 * height))
    if px1 - px0 < 4 or py1 - py0 < 4:
        return None
    return px0, py0, px1, py1


def crop(image, x0, y0, x1, y1):
    """按归一化坐标裁剪（返回 None 表示 ROI 太小）。"""
    height, width = image.shape[:2]
    box = pixel_box(x0, y0, x1, y1, width, height)
    if box is None:
        return None
    px0, py0, px1, py1 = box
    return image[py0:py1, px0:px1]


def roi_mean(image, x0, y0, x1, y1):
    region = crop(image, x0, y0, x1, y1)
    if region is None or region.size == 0:
        return None
    return float(region.mean())


def white_ratio(gray, x0, y0, x1, y1, threshold=210):
    """ROI 内接近白色的像素占比。"""
    region = crop(gray, x0, y0, x1, y1)
    if region is None or region.size == 0:
        return 0.0
    return float((region >= threshold).mean())


def color_ratio(image, x0, y0, x1, y1, channel, min_value, max_value=None):
    """ROI 内指定通道在 [min_value, max_value] 的像素占比。

    channel: 0=B, 1=G, 2=R（BGR 顺序）。
    """
    region = crop(image, x0, y0, x1, y1)
    if region is None or region.size == 0:
        return 0.0
    channel_data = region[:, :, channel].astype(np.float32)
    if max_value is None:
        mask = channel_data >= min_value
    else:
        mask = (channel_data >= min_value) & (channel_data <= max_value)
    return float(mask.mean())


def green_ratio(image, x0, y0, x1, y1):
    """绿色像素占比（G 通道高、R/B 相对低）。"""
    region = crop(image, x0, y0, x1, y1)
    if region is None or region.size == 0:
        return 0.0
    b = region[:, :, 0].astype(np.float32)
    g = region[:, :, 1].astype(np.float32)
    r = region[:, :, 2].astype(np.float32)
    mask = (g >= 90) & (g > r * 1.35) & (g > b * 1.15)
    return float(mask.mean())


def red_ratio(image, x0, y0, x1, y1):
    """红色像素占比（R 通道高、G/B 相对低；BGR 语义）。"""
    region = crop(image, x0, y0, x1, y1)
    if region is None or region.size == 0:
        return 0.0
    b = region[:, :, 0].astype(np.float32)
    g = region[:, :, 1].astype(np.float32)
    r = region[:, :, 2].astype(np.float32)
    mask = (r >= 80) & (r > g * 1.35) & (r > b * 1.35)
    return float(mask.mean())


def yellow_ratio(image, x0, y0, x1, y1):
    """黄色像素占比（R/G 均高、B 低；grade 区域特征）。"""
    region = crop(image, x0, y0, x1, y1)
    if region is None or region.size == 0:
        return 0.0
    b = region[:, :, 0].astype(np.float32)
    g = region[:, :, 1].astype(np.float32)
    r = region[:, :, 2].astype(np.float32)
    mask = (r >= 120) & (g >= 90) & (b < r * 0.75)
    return float(mask.mean())


def relative_center_brightness(gray, x0, y0, x1, y1):
    """中心区域亮度相对整图亮度的差值（卡片/菜单块检测）。"""
    center = crop(gray, x0, y0, x1, y1)
    if center is None or center.size == 0:
        return 0.0
    whole = float(gray.mean() / 255.0)
    center_mean = float(center.mean() / 255.0)
    return round(center_mean - whole, 3)


def normalize(value, low=0.0, high=1.0):
    """裁剪到 [0,1]。"""
    return max(0.0, min(1.0, (value - low) / (high - low) if high > low else 0.0))
