import cv2
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def analyze(image_path):
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError("image could not be decoded")
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (7, 7), 1.4)
    edges = cv2.Canny(blurred, 70, 150)
    circles = cv2.HoughCircles(
        blurred, cv2.HOUGH_GRADIENT, dp=1.2, minDist=max(18, width // 40),
        param1=100, param2=30, minRadius=max(8, width // 120), maxRadius=max(28, width // 14)
    )
    circle_count = 0 if circles is None else min(100, len(circles[0]))
    brightness = float(gray.mean() / 255.0)
    edge_density = float((edges > 0).mean())
    gameplay_confidence = min(1.0, circle_count / 8.0 + edge_density * 1.6)
    scene = "osu-gameplay" if gameplay_confidence >= 0.55 else "unknown-or-menu"
    return {
        "scene": scene,
        "confidence": round(gameplay_confidence, 3),
        "width": width,
        "height": height,
        "circleCandidates": circle_count,
        "brightness": round(brightness, 3),
        "edgeDensity": round(edge_density, 3),
        "note": "第一版使用圆形候选与边缘密度判断；结算数据请配合 telemetry 接口。"
    }


if __name__ == "__main__":
    try:
        print(json.dumps(analyze(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
