"""generate-fixtures.py —— Phase A：生成合成 osu 场景测试图 + manifest

只生成程序合成的图片，用于数据契约、分辨率适配、错误路径和场景分类测试；
合成图不得用于宣称真实识别准确率（任务书 §1/§6）。

注意：cv2 使用 BGR 通道顺序，所有颜色元组按 (B, G, R) 书写。

用法：runtime/vision-env/Scripts/python.exe tests/vision/generate-fixtures.py
输出：tests/fixtures/vision/*.png + tests/fixtures/vision/manifest.json
"""
import json
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "fixtures", "vision"))

# ---------- BGR 语义调色板 ----------
DARK_NAVY = (40, 22, 18)      # 深蓝背景（B 高）
LIGHT_BG = (226, 214, 210)    # 亮背景（近白）
CARD_BLUE = (78, 52, 48)      # 结算卡片（蓝灰）
GREEN_HEALTH = (90, 200, 60)  # 健康条/acc（G 高）
RED_FAIL = (34, 30, 110)      # 失败覆盖（R 高）
RED_TEXT = (160, 160, 255)
YELLOW_GRADE = (90, 220, 230)  # grade 黄（R/G 高、B 低）
ORANGE_TEXT = (150, 225, 235)
MISS_RED = (120, 120, 235)
TITLE_WHITE = (225, 205, 200)
LIST_BLUE = (92, 62, 56)
COVER_BLUE = (110, 76, 70)
MENU_BLUE = (66, 44, 40)
DESKTOP_BLUE = (120, 90, 70)
APP_BLUE = (170, 140, 120)


def render_text(img, text, org, scale=1.0, color=(255, 255, 255), thickness=2):
    # 字号随分辨率缩放（真实 osu 界面字号随窗口缩放）
    factor = img.shape[1] / 1280.0
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale * factor, color,
                max(1, int(thickness * factor)), cv2.LINE_AA)


def gameplay(width, height, n_circles, bright, combo_text="123x", seed=42):
    """游戏画面：深/亮背景 + 白色描边圆 + 顶部 combo + 左下血量条。"""
    rng = np.random.default_rng(seed)
    base = LIGHT_BG if bright else DARK_NAVY
    img = np.full((height, width, 3), base, np.uint8)
    for _ in range(n_circles):
        cx = int(width * (0.12 + 0.76 * rng.random()))
        cy = int(height * (0.18 + 0.62 * rng.random()))
        r = max(6, int(min(width, height) * (0.012 + 0.03 * rng.random())))
        cv2.circle(img, (cx, cy), r, (255, 255, 255), max(2, width // 320))
        cv2.circle(img, (cx, cy), r - 3, (20, 20, 20), -1)
    render_text(img, combo_text, (int(width * 0.78), int(height * 0.10)), 0.9, (255, 255, 255), 3)
    cv2.rectangle(img, (int(width * 0.03), int(height * 0.94)), (int(width * 0.30), int(height * 0.965)), GREEN_HEALTH, -1)
    return img


def results(width, height, acc="95.28", misses=3, combo=412, score="2,341,567", grade="S", seed=7):
    """结算页：中央卡片 + 大号绿色 acc + 右侧数字列（标签左、数字右，贴近真实布局）。"""
    rng = np.random.default_rng(seed)
    img = np.full((height, width, 3), (48, 28, 24), np.uint8)
    for _ in range(6):
        cv2.circle(img, (int(width * rng.random()), int(height * rng.random())),
                   int(min(width, height) * 0.05), (70, 46, 40), 3)
    x0, y0 = int(width * 0.15), int(height * 0.15)
    cw, ch = int(width * 0.7), int(height * 0.7)
    cv2.rectangle(img, (x0, y0), (x0 + cw, y0 + ch), CARD_BLUE, -1)
    label_x = x0 + int(width * 0.06)
    num_x = x0 + int(width * 0.36)   # 数字右对齐列起点
    render_text(img, "ACCURACY", (label_x, y0 + int(height * 0.09)), 0.7, TITLE_WHITE, 2)
    render_text(img, f"{acc}%", (num_x, y0 + int(height * 0.20)), 2.2, GREEN_HEALTH, 6)
    render_text(img, "miss", (label_x, y0 + int(height * 0.32)), 1.0, MISS_RED, 3)
    render_text(img, f"{misses}", (num_x, y0 + int(height * 0.32)), 1.0, MISS_RED, 3)
    render_text(img, "combo", (label_x, y0 + int(height * 0.42)), 1.0, ORANGE_TEXT, 3)
    render_text(img, f"{combo}", (num_x, y0 + int(height * 0.42)), 1.0, ORANGE_TEXT, 3)
    render_text(img, "score", (label_x, y0 + int(height * 0.52)), 1.0, TITLE_WHITE, 3)
    render_text(img, f"{score}", (num_x, y0 + int(height * 0.52)), 1.0, TITLE_WHITE, 3)
    render_text(img, grade, (x0 + int(width * 0.60), y0 + int(height * 0.09)), 1.6, YELLOW_GRADE, 5)
    return img


def song_select(width, height, seed=3):
    """选歌页：左侧封面块 + 右侧水平列表条 + 顶部标题。"""
    img = np.full((height, width, 3), (50, 30, 26), np.uint8)
    render_text(img, "SONG SELECT", (int(width * 0.06), int(height * 0.07)), 0.9, TITLE_WHITE, 3)
    cv2.rectangle(img, (int(width * 0.06), int(height * 0.16)), (int(width * 0.24), int(height * 0.60)), COVER_BLUE, -1)
    for i in range(5):
        y = int(height * (0.16 + i * 0.09))
        cv2.rectangle(img, (int(width * 0.30), y), (int(width * 0.90), y + int(height * 0.06)), LIST_BLUE, -1)
        render_text(img, f"track {i + 1}", (int(width * 0.33), y + int(height * 0.045)), 0.55, (235, 215, 210), 2)
    return img


def pause(width, height):
    """暂停：暗化背景 + 中央菜单块。"""
    img = gameplay(width, height, 5, False, "321x", seed=11)
    img = cv2.convertScaleAbs(img, alpha=0.45, beta=0)
    bw, bh = int(width * 0.5), int(height * 0.35)
    x0, y0 = int(width * 0.25), int(height * 0.32)
    overlay = img.copy()
    cv2.rectangle(overlay, (x0, y0), (x0 + bw, y0 + bh), MENU_BLUE, -1)
    cv2.addWeighted(overlay, 0.72, img, 0.28, 0, img)
    render_text(img, "PAUSED", (int(width * 0.36), int(height * 0.47)), 1.4, (255, 255, 255), 5)
    render_text(img, "RETRY", (int(width * 0.43), int(height * 0.60)), 0.8, TITLE_WHITE, 3)
    return img


def fail(width, height):
    """失败页：暗红覆盖 + 中央 FAILED + 重试按钮。"""
    img = gameplay(width, height, 4, False, "045x", seed=13)
    img = cv2.convertScaleAbs(img, alpha=0.5, beta=0)
    bw, bh = int(width * 0.44), int(height * 0.30)
    x0, y0 = int(width * 0.28), int(height * 0.35)
    overlay = img.copy()
    cv2.rectangle(overlay, (x0, y0), (x0 + bw, y0 + bh), RED_FAIL, -1)
    cv2.addWeighted(overlay, 0.75, img, 0.25, 0, img)
    render_text(img, "FAILED", (int(width * 0.33), int(height * 0.48)), 1.6, RED_TEXT, 6)
    cv2.rectangle(img, (int(width * 0.43), int(height * 0.58)), (int(width * 0.57), int(height * 0.66)), (90, 90, 200), -1)
    return img


def unknown(kind, width, height, seed=5):
    """负样本/未知：黑屏、噪声、纯渐变、桌面模拟。"""
    rng = np.random.default_rng(seed)
    if kind == "black":
        return np.zeros((height, width, 3), np.uint8)
    if kind == "noise":
        return rng.integers(0, 256, (height, width, 3), dtype=np.uint8)
    if kind == "gradient":
        axis = np.linspace(0, 1, width, dtype=np.float32)            # (width,)
        gray = np.tile(axis, (height, 1))                            # (height, width)
        img = np.stack([gray, gray, gray], axis=-1)                  # (height, width, 3)
        return (img * 200).astype(np.uint8)
    if kind == "desktop":
        img = np.full((height, width, 3), DESKTOP_BLUE, np.uint8)
        for i in range(4):
            x = int(width * (0.05 + i * 0.22))
            cv2.rectangle(img, (x, int(height * 0.30)), (x + int(width * 0.12), int(height * 0.52)), APP_BLUE, -1)
            render_text(img, f"app{i + 1}", (x + int(width * 0.02), int(height * 0.60)), 0.5, (245, 235, 235), 2)
        return img
    raise ValueError(f"unknown kind: {kind}")


FIXTURES = [
    # (id, resolution, builder, expected_scene, allowed_fields, expected_values)
    ("gp-1280-a", (1280, 720), lambda w, h: gameplay(w, h, 9, True), "gameplay",
     ["circleCandidates", "combo", "health"], {"circleCandidates": 9}),
    ("gp-1280-b", (1280, 720), lambda w, h: gameplay(w, h, 5, False), "gameplay",
     ["circleCandidates", "combo", "health"], {"circleCandidates": 5}),
    ("gp-1080-a", (1920, 1080), lambda w, h: gameplay(w, h, 12, False, "456x"), "gameplay",
     ["circleCandidates", "combo", "health"], {"circleCandidates": 12}),
    ("gp-1024-a", (1024, 600), lambda w, h: gameplay(w, h, 6, True, "078x"), "gameplay",
     ["circleCandidates", "combo", "health"], {"circleCandidates": 6}),
    ("rs-1280-a", (1280, 720), lambda w, h: results(w, h, "95.28", 3, 412, "2,341,567", "S"), "results",
     ["accuracy", "misses", "maxCombo", "score", "grade"],
     {"accuracy": "95.28", "misses": "3", "maxCombo": "412", "score": "2341567", "grade": "S"}),
    ("rs-1280-b", (1280, 720), lambda w, h: results(w, h, "87.45", 12, 98, "1,023,410", "A"), "results",
     ["accuracy", "misses", "maxCombo", "score", "grade"],
     {"accuracy": "87.45", "misses": "12", "maxCombo": "98", "score": "1023410", "grade": "A"}),
    ("rs-1080-a", (1920, 1080), lambda w, h: results(w, h, "99.12", 0, 1234, "3,000,000", "SS"), "results",
     ["accuracy", "misses", "maxCombo", "score", "grade"],
     {"accuracy": "99.12", "misses": "0", "maxCombo": "1234", "score": "3000000", "grade": "SS"}),
    ("ss-1280-a", (1280, 720), song_select, "songSelect", ["title"], {}),
    ("ss-1080-a", (1920, 1080), song_select, "songSelect", ["title"], {}),
    ("ps-1280-a", (1280, 720), pause, "pause", [], {}),
    ("ps-1024-a", (1024, 600), pause, "pause", [], {}),
    ("fl-1280-a", (1280, 720), fail, "fail", [], {}),
    ("fl-1080-a", (1920, 1080), fail, "fail", [], {}),
    ("uk-black", (1280, 720), lambda w, h: unknown("black", w, h), "unknown", [], {}),
    ("uk-noise", (1280, 720), lambda w, h: unknown("noise", w, h), "unknown", [], {}),
    ("uk-gradient", (1024, 600), lambda w, h: unknown("gradient", w, h), "unknown", [], {}),
    ("uk-desktop", (1280, 720), lambda w, h: unknown("desktop", w, h), "unknown", [], {}),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "note": "程序生成的合成测试图：用于数据契约、分辨率、错误路径与场景分类测试；不得用于宣称真实识别准确率。",
        "fixtures": [],
    }
    for fid, (width, height), builder, expected, allowed, values in FIXTURES:
        img = builder(width, height)
        path = os.path.join(OUT_DIR, f"{fid}.png")
        cv2.imwrite(path, img)
        manifest["fixtures"].append({
            "id": fid,
            "file": f"{fid}.png",
            "source": "synthetic",
            "resolution": f"{width}x{height}",
            "expectedScene": expected,
            "allowedFields": allowed,
            "expectedValues": values,
        })
        print(f"  generated {fid}: {width}x{height} -> {expected}")
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print(f"manifest: {manifest_path} ({len(manifest['fixtures'])} fixtures)")


if __name__ == "__main__":
    main()
