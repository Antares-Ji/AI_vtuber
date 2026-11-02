"""Read saved frames only: no capture, window/input, network or model calls.

Angles are image-relative (right=0, down=90), not game headings. A rotated
minimap requires the native same-frame projection before authorizing travel.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def hud(texts):
    instructions = [r for r in texts if isinstance(r.get("box"), list)
                    and len(r["box"]) == 4 and r["box"][0] < 640
                    and r["box"][1] < 540
                    and re.match(r"^(前往|前去|寻找|跟随|尝试|抵达|与.+对话)", r.get("text", ""))]
    if len(instructions) != 1:
        return None
    row = instructions[0]
    x, y, w, h = row["box"]
    readings = [r for r in texts if len(r.get("box", [])) == 4
                and x - 30 <= r["box"][0] < x + min(w, 220)
                and y + h - 8 <= r["box"][1] < y + h + 85]
    focused = [r for r in readings if r.get("source") == "quest_distance_crop"]
    values = {int(m[1]) for r in (focused or readings)
              if (m := re.fullmatch(r"\s*(\d{1,5})\s*(?:m|米)\s*", r.get("text", ""), re.I))}
    return {"stage": row["text"], "meters": next(iter(values))} if len(values) == 1 else None


def angle_delta(a, b):
    return abs((a - b + 180) % 360 - 180)


def observe(image, templates, threshold=0.8, match_channels=1):
    if match_channels not in (1, 3):
        raise ValueError('match_channels must be 1 or 3')
    height, width = image.shape[:2]
    scale = min(width / 1920, 1)
    x, y, w, h = [round(v * scale) for v in (62, 19, 212, 212)]
    if x + w > width or y + h > height:
        raise ValueError("minimap_roi_outside_frame")
    crop = image[y:y+h, x:x+w]
    if match_channels == 1:
        crop = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    peaks, candidates = [], []
    for name, original in templates:
        # BGI scales template assets with the capture AssetScale.
        template = cv2.resize(original, None, fx=scale, fy=scale) if scale != 1 else original
        if match_channels == 1 and template.ndim == 3:
            template = cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)
        elif match_channels == 3 and template.ndim == 2:
            template = cv2.cvtColor(template, cv2.COLOR_GRAY2BGR)
        th, tw = template.shape[:2]
        scores = cv2.matchTemplate(crop, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(scores)
        peaks.append({"template": name, "score": float(score), "position": [x+loc[0], y+loc[1]]})
        # At most two production matches per template, matching the native cap.
        for _ in range(2):
            _, score, _, (px, py) = cv2.minMaxLoc(scores)
            if score < threshold:
                break
            cx, cy = x + px + tw/2, y + py + th/2
            nearby = [c for c in candidates if name not in c["templates"]
                      and abs(c["center"][0]-cx) <= 14 and abs(c["center"][1]-cy) <= 14]
            if len(nearby) == 1:
                nearby[0]["templates"].append(name)
            else:
                candidates.append({"center": [cx, cy], "templates": [name]})
            # Match the pinned native helper's >= .5 IoU suppression.
            for sy in range(max(0,py-th//3-1), min(scores.shape[0],py+th//3+2)):
                for sx in range(max(0,px-tw//3-1), min(scores.shape[1],px+tw//3+2)):
                    overlap = (tw-abs(sx-px)) * (th-abs(sy-py))
                    if overlap / (2*tw*th-overlap) >= .5:
                        scores[sy,sx] = -1
    result = {"roi": [x,y,w,h], "matchChannels": match_channels, "peaks": peaks, "matchCount": len(candidates),
              "highestNcc": max(p["score"] for p in peaks), "accepted": False,
              "imageBearingDegrees": None, "gameBearingDegrees": None,
              "gameBearingReason": "same_frame_projection_required"}
    if len(candidates) == 1:
        cx, cy = candidates[0]["center"]
        dx, dy = cx-(x+w/2), cy-(y+h/2)
        radius = math.hypot(dx, dy)
        result["candidate"] = candidates[0]
        result["accepted"] = 12*scale <= radius <= min(w,h)/2
        if result["accepted"]:
            result["imageBearingDegrees"] = math.degrees(math.atan2(dy, dx))
    return result


def replay(root, limit, session=None, exclude_session=None, quest=None, manifest_path=None):
    if limit <= 0:
        raise ValueError('limit must be positive')
    manifest_path = manifest_path or ROOT / "scripts/genshin/assets/minimap-candidates.source.json"
    manifest = read_json(manifest_path)
    match_channels = manifest.get('matchChannels', 1)
    templates = []
    for spec in manifest["templates"]:
        path = ROOT / "scripts/genshin/assets" / spec["file"]
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != spec["sha256"]:
            raise ValueError("Template SHA256 mismatch: " + spec["file"])
        templates.append((spec["file"], cv2.imdecode(np.frombuffer(raw, np.uint8),
                         cv2.IMREAD_COLOR if match_channels == 3 else cv2.IMREAD_GRAYSCALE)))
    entries, seen = [], set()
    for file in sorted(root.glob("*/step-*.json"), key=lambda p:p.stat().st_mtime):
        data = read_json(file)
        request = data.get("request", {})
        sid = data.get("trainingSessionId") or request.get("trainingSessionId")
        if session and sid != session:
            continue
        if exclude_session and sid == exclude_session:
            continue
        if quest and data.get('decision', {}).get('quest') != quest:
            continue
        image = Path(data.get("image") or file.parent / request.get("image", "missing.png"))
        if not image.is_file():
            continue
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        if data.get("observation", {}).get("scene") != "world":
            continue
        entries.append({"evidence": str(file), "image": str(image), "sha256": digest,
                        "at": request.get("capturedAt", data.get("at")), "session": sid,
                        "quest": data.get('decision', {}).get('quest'),
                        "hud": hud(request.get("texts", []))})
    rows, pairs = [], []
    for entry in entries[-limit:]:
        image = cv2.imdecode(np.fromfile(entry["image"], np.uint8), cv2.IMREAD_COLOR)
        result = {**entry, **observe(image, templates, manifest["productionThreshold"], match_channels)}
        if rows:
            previous = rows[-1]
            if result["hud"] and result["hud"] == previous["hud"] and result["session"] == previous["session"]:
                delta = angle_delta(result["imageBearingDegrees"], previous["imageBearingDegrees"]) if result["accepted"] and previous["accepted"] else None
                pairs.append({"before": previous["evidence"], "after": result["evidence"],
                              "imageAngleDelta": delta, "within15Degrees": delta <= 15 if delta is not None else None})
        rows.append(result)
    hits = sum(r["accepted"] for r in rows)
    comparable = [p for p in pairs if p["imageAngleDelta"] is not None]
    eligible = [r for r in rows if r['hud'] and 8 < r['hud']['meters'] <= 1500]
    eligible_hits = sum(r['accepted'] for r in eligible)
    summary = {"frames": len(rows), "hits": hits, "hitRate": hits/len(rows) if rows else 0,
               "highestNcc": max((r['highestNcc'] for r in rows), default=None),
               "sameHudAdjacentPairs": len(pairs), "angleComparablePairs": len(comparable),
               "stableImagePairs": sum(p["within15Degrees"] for p in comparable),
               "hudEligibleFrames": len(eligible), "hudEligibleHits": eligible_hits,
               "hudEligibleHitRate": eligible_hits/len(eligible) if eligible else 0,
               "gameBearingStability": "unverified_without_projection", "deploymentGatePassed": False}
    return {"kind": "offline_minimap_replay", "inputOrNetworkCalls": 0, "source": manifest,
            "filters": {"session": session, "excludeSession": exclude_session, "quest": quest, "limit": limit},
            "summary": summary, "frames": rows, "stabilityPairs": pairs,
            "limitations": ["World-scene classification and HUD come from saved observations, not new inference.",
                            "Image-relative angles cannot certify world bearing on a rotated minimap.",
                            "Template hits are not human-labelled target accuracy; replay never authorizes gameplay."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT / "runtime/genshin/story")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--session")
    parser.add_argument("--exclude-session")
    parser.add_argument("--quest")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "runtime/genshin/minimap-replay.json")
    args = parser.parse_args()
    result = replay(args.root, args.limit, args.session, args.exclude_session, args.quest, args.manifest)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), **result["summary"]}, ensure_ascii=False))
