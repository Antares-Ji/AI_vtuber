"""Detect likely text-label regions in a game screenshot.

This does not read or alter text. It finds bright, compact glyph groups and
returns their bounding boxes and centres as JSON, so a caller can inspect a
preview before deciding whether a mouse click is appropriate.
"""
import argparse
import json
import sys

import cv2
import numpy as np


def detect(image):
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    background = cv2.GaussianBlur(gray, (0, 0), max(9, width // 100))
    contrast = cv2.subtract(gray, background)
    bright = cv2.inRange(gray, 150, 255)
    local = cv2.inRange(contrast, 20, 255)
    binary = cv2.bitwise_and(bright, local)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((3, 5), np.uint8))
    binary = cv2.dilate(binary, np.ones((3, max(9, width // 120)), np.uint8), iterations=1)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 7), np.uint8))

    count, _, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    candidates = []
    for index in range(1, count):
        x, y, w, h, area = (int(value) for value in stats[index])
        ratio = w / max(h, 1)
        if w < max(18, width // 120) or h < 8 or h > height * 0.12:
            continue
        if ratio < 0.65 or ratio > 24 or area < w * h * 0.08:
            continue
        region = contrast[y:y + h, x:x + w]
        score = round(float(np.mean(region)) * min(1.0, area / (w * h) * 3), 2)
        candidates.append({
            "box": {"x": x, "y": y, "width": w, "height": h},
            "center": {"x": x + w // 2, "y": y + h // 2},
            "score": score,
        })
    return sorted(candidates, key=lambda item: item["score"], reverse=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--preview", help="write an annotated preview image")
    args = parser.parse_args()
    image = cv2.imread(args.image, cv2.IMREAD_COLOR)
    if image is None:
        print(json.dumps({"error": "image could not be decoded"}, ensure_ascii=False))
        sys.exit(1)
    candidates = detect(image)
    if args.preview:
        preview = image.copy()
        for number, item in enumerate(candidates):
            box = item["box"]
            cv2.rectangle(preview, (box["x"], box["y"]), (box["x"] + box["width"], box["y"] + box["height"]), (0, 255, 255), 2)
            cv2.putText(preview, str(number), (box["x"], max(20, box["y"] - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2)
        cv2.imwrite(args.preview, preview)
    print(json.dumps({"image": args.image, "count": len(candidates), "candidates": candidates}, ensure_ascii=False))


if __name__ == "__main__":
    main()
