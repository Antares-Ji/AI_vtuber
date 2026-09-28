"""Strict, current-frame deployment currency recognition (no input actions)."""
import re


def parse_cost(text):
    """Unreadable or ambiguous OCR remains unknown, never zero."""
    if not isinstance(text, str):
        return None
    match = re.fullmatch(r'DP([0-9]{1,2})', ''.join(text.split()))
    return int(match[1]) if match else None


def affordable(balance, cost):
    return (type(balance) is int and type(cost) is int
            and 0 <= balance <= 99 and 0 <= cost <= 99 and balance >= cost)


def cost_context(frame, box, font_path='C:/Windows/Fonts/arial.ttf'):
    """Keep final OCR input at 600x240; callers must use scale=1."""
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    x1, y1, x2, y2 = box
    digits = Image.fromarray(cv2.cvtColor(
        cv2.resize(frame[y1:y2, x1:x2], (270, 195)), cv2.COLOR_BGR2GRAY))
    digits = digits.point(lambda p: 0 if p > 195 else 255)
    context = Image.new('L', (600, 240), 255)
    context.paste(digits, (250, 0))
    ImageDraw.Draw(context).text((15, 35), 'DP',
        font=ImageFont.truetype(font_path, 145), fill=0)
    return cv2.cvtColor(np.array(context), cv2.COLOR_GRAY2BGR)


def read_cost(frame, box, ocr, label):
    canvas = cost_context(frame, box)
    return parse_cost(ocr(canvas, (0, 0, 600, 240), label, scale=1))


def card_cost_box(portrait_x):
    """Current portrait center anchors the fee strip in a 1600x1024 tray.

    This crop is deliberately narrow to exclude adjacent cards. OCR failure
    blocks affordability; there is no historical/base-cost fallback.
    """
    center = int(portrait_x)
    return (max(0, center - 5), 878, min(1600, center + 50), 919)
