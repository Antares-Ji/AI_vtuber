"""Canonical L2 28-layer specification, bone tree, physics, emotions, and Rig2D schemas."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from pydantic import BaseModel, Field


SCHEMA_VERSION = "rig2d-v1"
DEFAULT_CANVAS_WIDTH = 1024
DEFAULT_CANVAS_HEIGHT = 1536


@dataclass(frozen=True)
class LayerSpec:
    id: str
    group: str
    display_name: str
    z_order: int
    parent_bone: str
    bones: tuple[str, ...]
    parallax_x: float = 0.0
    parallax_y: float = 0.0
    role: str = "body"  # body | hair | skirt | eye_sclera | eye_iris | eye_open | eye_closed | brow | mouth | fx | accessory
    side: str = "center"  # left | right | center
    variant_capable: bool = False
    required: bool = True
    mesh_density: str = "medium"  # low | medium | high


# 28 canonical layers in bottom-to-top draw order (matching the approved L2 blueprint).
CANONICAL_LAYERS: tuple[LayerSpec, ...] = (
    LayerSpec("hair_back", "BackHair", "后发", 10, "hair_back_c", ("head", "hair_back_l", "hair_back_c", "hair_back_r"), -0.10, -0.06, "hair", "center", True, True, "high"),
    LayerSpec("cloth_back", "BackCloth", "后衣摆/披风", 20, "skirt_root", ("chest", "hips", "skirt_l", "skirt_c", "skirt_r"), -0.04, -0.02, "skirt", "center", True, False, "medium"),
    LayerSpec("leg_l_upper", "LowerBody", "左大腿", 30, "leg_l_upper", ("leg_l_upper",), 0.0, 0.0, "body", "left", False, False, "low"),
    LayerSpec("leg_l_lower_shoe", "LowerBody", "左小腿与鞋", 35, "leg_l_lower", ("leg_l_lower",), 0.0, 0.0, "body", "left", True, False, "low"),
    LayerSpec("leg_r_upper", "LowerBody", "右大腿", 31, "leg_r_upper", ("leg_r_upper",), 0.0, 0.0, "body", "right", False, False, "low"),
    LayerSpec("leg_r_lower_shoe", "LowerBody", "右小腿与鞋", 36, "leg_r_lower", ("leg_r_lower",), 0.0, 0.0, "body", "right", True, False, "low"),
    LayerSpec("torso_base", "Torso", "全身躯干/裙摆/双腿", 50, "chest", ("root", "hips", "spine", "chest", "neck", "skirt_l", "skirt_c", "skirt_r"), 0.0, 0.0, "unified_body", "center", True, True, "ultra"),
    LayerSpec("arm_l_upper", "Arms", "左上臂与袖", 52, "arm_l_upper", ("chest", "arm_l_upper", "arm_l_lower"), 0.0, 0.0, "arm_full", "left", True, True, "high"),
    LayerSpec("arm_l_lower_hand", "Arms", "左下臂与手", 54, "arm_l_lower", ("arm_l_lower",), 0.0, 0.0, "body", "left", False, False, "medium"),
    LayerSpec("arm_r_upper", "Arms", "右上臂与袖", 53, "arm_r_upper", ("chest", "arm_r_upper", "arm_r_lower"), 0.0, 0.0, "arm_full", "right", True, True, "high"),
    LayerSpec("arm_r_lower_hand", "Arms", "右下臂与手", 55, "arm_r_lower", ("arm_r_lower",), 0.0, 0.0, "body", "right", False, False, "medium"),
    LayerSpec("skirt_front", "LowerBody", "前裙摆/下装", 56, "skirt_root", ("hips", "skirt_root", "skirt_l", "skirt_c", "skirt_r"), 0.0, 0.0, "skirt", "center", True, False, "high"),
    LayerSpec("cloth_outer", "Torso", "领饰/外套配饰", 60, "chest", ("spine", "chest", "neck"), 0.0, 0.0, "accessory", "center", True, False, "medium"),
    LayerSpec("neck", "Head", "脖颈", 70, "neck", ("chest", "neck", "head"), 0.0, 0.0, "body", "center", False, True, "low"),
    LayerSpec("head_base", "Head", "脸底与双耳", 80, "head", ("head",), 0.0, 0.0, "body", "center", True, True, "medium"),
    LayerSpec("fx_blush", "FaceFX", "脸红贴图", 85, "head", ("head",), 0.05, 0.04, "fx", "center", False, True, "low"),
    LayerSpec("eye_l_sclera", "FaceEyes", "左眼睁眼", 90, "head", ("head",), 0.07, 0.05, "eye_sclera", "left", True, True, "low"),
    LayerSpec("eye_l_iris", "FaceEyes", "左眼瞳孔", 92, "head", ("head",), 0.09, 0.06, "eye_iris", "left", True, False, "low"),
    LayerSpec("eye_l_lid_open", "FaceEyes", "左眼上睫毛/睁眼", 94, "head", ("head",), 0.08, 0.05, "eye_open", "left", False, False, "low"),
    LayerSpec("eye_l_lid_closed", "FaceEyes", "左眼闭眼线", 96, "head", ("head",), 0.08, 0.05, "eye_closed", "left", True, True, "low"),
    LayerSpec("eye_r_sclera", "FaceEyes", "右眼睁眼", 91, "head", ("head",), 0.07, 0.05, "eye_sclera", "right", True, True, "low"),
    LayerSpec("eye_r_iris", "FaceEyes", "右眼瞳孔", 93, "head", ("head",), 0.09, 0.06, "eye_iris", "right", True, False, "low"),
    LayerSpec("eye_r_lid_open", "FaceEyes", "右眼上睫毛/睁眼", 95, "head", ("head",), 0.08, 0.05, "eye_open", "right", False, False, "low"),
    LayerSpec("eye_r_lid_closed", "FaceEyes", "右眼闭眼线", 97, "head", ("head",), 0.08, 0.05, "eye_closed", "right", True, True, "low"),
    LayerSpec("brow_l", "FaceBrows", "左眉", 100, "head", ("head",), 0.08, 0.06, "brow", "left", False, True, "low"),
    LayerSpec("brow_r", "FaceBrows", "右眉", 101, "head", ("head",), 0.08, 0.06, "brow", "right", False, True, "low"),
    LayerSpec("mouth_closed", "FaceMouth", "闭嘴", 105, "head", ("head",), 0.07, 0.05, "mouth", "center", False, True, "low"),
    LayerSpec("mouth_half", "FaceMouth", "半张嘴", 106, "head", ("head",), 0.07, 0.05, "mouth", "center", False, True, "low"),
    LayerSpec("mouth_open", "FaceMouth", "大张嘴", 107, "head", ("head",), 0.07, 0.05, "mouth", "center", False, True, "low"),
    LayerSpec("mouth_smile", "FaceMouth", "微笑嘴", 108, "head", ("head",), 0.07, 0.05, "mouth", "center", False, True, "low"),
    LayerSpec("fx_sparkle", "FaceFX", "情绪高光/星芒", 112, "head", ("head",), 0.11, 0.08, "fx", "center", False, True, "low"),
    LayerSpec("hair_side_l", "FrontHair", "左鬓角", 120, "hair_side_l", ("head", "hair_side_l"), 0.08, 0.05, "hair", "left", True, False, "medium"),
    LayerSpec("hair_side_r", "FrontHair", "右鬓角", 121, "hair_side_r", ("head", "hair_side_r"), 0.08, 0.05, "hair", "right", True, False, "medium"),
    LayerSpec("hair_bang_l", "FrontHair", "左刘海", 125, "hair_bang_l", ("head", "hair_bang_l"), 0.11, 0.07, "hair", "left", True, True, "medium"),
    LayerSpec("hair_bang_c", "FrontHair", "中刘海", 126, "hair_bang_c", ("head", "hair_bang_c"), 0.12, 0.08, "hair", "center", True, True, "medium"),
    LayerSpec("hair_bang_r", "FrontHair", "右刘海", 127, "hair_bang_r", ("head", "hair_bang_r"), 0.11, 0.07, "hair", "right", True, True, "medium"),
    LayerSpec("acc_head", "FrontHair", "头饰/发饰", 130, "acc_head", ("head", "acc_head"), 0.12, 0.08, "accessory", "center", True, False, "low"),
)

CANONICAL_LAYER_MAP: dict[str, LayerSpec] = {spec.id: spec for spec in CANONICAL_LAYERS}

# Default normalized (0..1) joint coordinates on canonical standing A-pose girl canvas (width=1024, height=1536).
CANONICAL_JOINTS_NORM: dict[str, tuple[float, float, str | None]] = {
    "root": (0.500, 0.945, None),
    "hips": (0.500, 0.560, "root"),
    "spine": (0.500, 0.475, "hips"),
    "chest": (0.500, 0.385, "spine"),
    "neck": (0.500, 0.312, "chest"),
    "head": (0.500, 0.235, "neck"),
    "arm_l_upper": (0.402, 0.372, "chest"),
    "arm_l_lower": (0.352, 0.485, "arm_l_upper"),
    "arm_r_upper": (0.598, 0.372, "chest"),
    "arm_r_lower": (0.648, 0.485, "arm_r_upper"),
    "leg_l_upper": (0.455, 0.575, "hips"),
    "leg_l_lower": (0.452, 0.755, "leg_l_upper"),
    "leg_r_upper": (0.545, 0.575, "hips"),
    "leg_r_lower": (0.548, 0.755, "leg_r_upper"),
    "skirt_root": (0.500, 0.540, "hips"),
    "skirt_l": (0.420, 0.620, "skirt_root"),
    "skirt_c": (0.500, 0.635, "skirt_root"),
    "skirt_r": (0.580, 0.620, "skirt_root"),
    "hair_bang_l": (0.440, 0.145, "head"),
    "hair_bang_c": (0.500, 0.135, "head"),
    "hair_bang_r": (0.560, 0.145, "head"),
    "hair_side_l": (0.392, 0.205, "head"),
    "hair_side_r": (0.608, 0.205, "head"),
    "hair_back_l": (0.415, 0.245, "head"),
    "hair_back_c": (0.500, 0.255, "head"),
    "hair_back_r": (0.585, 0.245, "head"),
    "acc_head": (0.388, 0.145, "head"),
}

# Tip positions (normalized) for computing bone segment skinning lengths.
BONE_TIPS_NORM: dict[str, tuple[float, float]] = {
    "root": (0.500, 0.560),
    "hips": (0.500, 0.475),
    "spine": (0.500, 0.385),
    "chest": (0.500, 0.312),
    "neck": (0.500, 0.235),
    "head": (0.500, 0.115),
    "arm_l_upper": (0.352, 0.485),
    "arm_l_lower": (0.308, 0.605),
    "arm_r_upper": (0.648, 0.485),
    "arm_r_lower": (0.692, 0.605),
    "leg_l_upper": (0.452, 0.755),
    "leg_l_lower": (0.448, 0.935),
    "leg_r_upper": (0.548, 0.755),
    "leg_r_lower": (0.552, 0.935),
    "skirt_root": (0.500, 0.690),
    "skirt_l": (0.365, 0.710),
    "skirt_c": (0.500, 0.715),
    "skirt_r": (0.635, 0.710),
    "hair_bang_l": (0.425, 0.235),
    "hair_bang_c": (0.500, 0.235),
    "hair_bang_r": (0.575, 0.235),
    "hair_side_l": (0.375, 0.395),
    "hair_side_r": (0.625, 0.395),
    "hair_back_l": (0.340, 0.545),
    "hair_back_c": (0.500, 0.560),
    "hair_back_r": (0.660, 0.545),
    "acc_head": (0.355, 0.125),
}

DEFAULT_PHYSICS_CHAINS: list[dict[str, Any]] = [
    {"bone": "hair_bang_l", "stiffness": 115.0, "damping": 12.0, "gravityScale": 0.45, "inertia": 0.30, "maxAngleDeg": 5.5, "windPhase": 0.0},
    {"bone": "hair_bang_c", "stiffness": 125.0, "damping": 12.5, "gravityScale": 0.40, "inertia": 0.26, "maxAngleDeg": 4.5, "windPhase": 0.7},
    {"bone": "hair_bang_r", "stiffness": 115.0, "damping": 12.0, "gravityScale": 0.45, "inertia": 0.30, "maxAngleDeg": 5.5, "windPhase": 1.4},
    {"bone": "hair_side_l", "stiffness": 82.0, "damping": 9.8, "gravityScale": 0.65, "inertia": 0.42, "maxAngleDeg": 8.0, "windPhase": 0.4},
    {"bone": "hair_side_r", "stiffness": 82.0, "damping": 9.8, "gravityScale": 0.65, "inertia": 0.42, "maxAngleDeg": 8.0, "windPhase": 1.9},
    {"bone": "hair_back_l", "stiffness": 58.0, "damping": 8.5, "gravityScale": 0.70, "inertia": 0.55, "maxAngleDeg": 8.5, "windPhase": 0.8},
    {"bone": "hair_back_c", "stiffness": 66.0, "damping": 9.2, "gravityScale": 0.65, "inertia": 0.48, "maxAngleDeg": 6.5, "windPhase": 1.6},
    {"bone": "hair_back_r", "stiffness": 58.0, "damping": 8.5, "gravityScale": 0.70, "inertia": 0.55, "maxAngleDeg": 8.5, "windPhase": 2.4},
    {"bone": "acc_head", "stiffness": 130.0, "damping": 12.0, "gravityScale": 0.35, "inertia": 0.25, "maxAngleDeg": 5.0, "windPhase": 1.1},
    {"bone": "skirt_l", "stiffness": 68.0, "damping": 9.0, "gravityScale": 0.65, "inertia": 0.50, "maxAngleDeg": 7.0, "windPhase": 0.3},
    {"bone": "skirt_c", "stiffness": 76.0, "damping": 9.8, "gravityScale": 0.55, "inertia": 0.40, "maxAngleDeg": 5.0, "windPhase": 1.3},
    {"bone": "skirt_r", "stiffness": 68.0, "damping": 9.0, "gravityScale": 0.65, "inertia": 0.50, "maxAngleDeg": 7.0, "windPhase": 2.3},
]

# Full 22-emotion mapping aligned with AI_vtuber emotion system.
EMOTION_PRESETS: dict[str, dict[str, Any]] = {
    "neutral":      {"browY": 0.0,  "browAngle": 0.0,   "eyeOpen": 1.0,  "eyeSquint": 0.0,  "mouthSmile": 0.15, "blush": 0.0,  "sparkle": 0.0,  "headTilt": 0.0,   "headPitch": 0.0,   "bodyLean": 0.0,   "armPose": "idle"},
    "happy":        {"browY": 0.25, "browAngle": -0.15, "eyeOpen": 0.92, "eyeSquint": 0.35, "mouthSmile": 0.95, "blush": 0.30, "sparkle": 0.55, "headTilt": 0.25,  "headPitch": 0.10,  "bodyLean": 0.15,  "armPose": "cheer"},
    "excited":      {"browY": 0.42, "browAngle": -0.20, "eyeOpen": 1.08, "eyeSquint": 0.20, "mouthSmile": 1.00, "blush": 0.35, "sparkle": 0.95, "headTilt": -0.20, "headPitch": 0.18,  "bodyLean": 0.30,  "armPose": "wave"},
    "shy":          {"browY": 0.15, "browAngle": 0.35,  "eyeOpen": 0.86, "eyeSquint": 0.15, "mouthSmile": 0.35, "blush": 0.90, "sparkle": 0.10, "headTilt": 0.38,  "headPitch": -0.18, "bodyLean": -0.15, "armPose": "shy"},
    "embarrassed":  {"browY": 0.20, "browAngle": 0.45,  "eyeOpen": 0.82, "eyeSquint": 0.25, "mouthSmile": 0.20, "blush": 1.00, "sparkle": 0.0,  "headTilt": -0.35, "headPitch": -0.22, "bodyLean": -0.20, "armPose": "shy"},
    "focused":      {"browY": -0.18,"browAngle": -0.28, "eyeOpen": 0.88, "eyeSquint": 0.18, "mouthSmile": 0.0,  "blush": 0.0,  "sparkle": 0.0,  "headTilt": -0.10, "headPitch": -0.08, "bodyLean": 0.35,  "armPose": "think"},
    "curious":      {"browY": 0.35, "browAngle": 0.10,  "eyeOpen": 1.08, "eyeSquint": 0.0,  "mouthSmile": 0.30, "blush": 0.05, "sparkle": 0.45, "headTilt": 0.45,  "headPitch": 0.08,  "bodyLean": 0.25,  "armPose": "think"},
    "annoyed":      {"browY": -0.32,"browAngle": -0.55, "eyeOpen": 0.78, "eyeSquint": 0.30, "mouthSmile": -0.45,"blush": 0.10, "sparkle": 0.0,  "headTilt": -0.18, "headPitch": -0.12, "bodyLean": -0.10, "armPose": "cross_arms"},
    "concerned":    {"browY": 0.18, "browAngle": 0.48,  "eyeOpen": 0.94, "eyeSquint": 0.08, "mouthSmile": -0.25,"blush": 0.0,  "sparkle": 0.0,  "headTilt": 0.20,  "headPitch": -0.15, "bodyLean": 0.20,  "armPose": "idle"},
    "sad":          {"browY": 0.10, "browAngle": 0.65,  "eyeOpen": 0.72, "eyeSquint": 0.12, "mouthSmile": -0.55,"blush": 0.0,  "sparkle": 0.0,  "headTilt": 0.22,  "headPitch": -0.32, "bodyLean": -0.22, "armPose": "idle"},
    "lonely":       {"browY": 0.08, "browAngle": 0.55,  "eyeOpen": 0.75, "eyeSquint": 0.10, "mouthSmile": -0.40,"blush": 0.0,  "sparkle": 0.0,  "headTilt": -0.20, "headPitch": -0.28, "bodyLean": -0.25, "armPose": "idle"},
    "disappointed": {"browY": -0.05,"browAngle": 0.42,  "eyeOpen": 0.74, "eyeSquint": 0.16, "mouthSmile": -0.50,"blush": 0.0,  "sparkle": 0.0,  "headTilt": -0.14, "headPitch": -0.25, "bodyLean": -0.18, "armPose": "idle"},
    "grateful":     {"browY": 0.22, "browAngle": 0.12,  "eyeOpen": 0.88, "eyeSquint": 0.30, "mouthSmile": 0.85, "blush": 0.45, "sparkle": 0.45, "headTilt": 0.18,  "headPitch": -0.12, "bodyLean": 0.22,  "armPose": "bow"},
    "proud":        {"browY": 0.28, "browAngle": -0.22, "eyeOpen": 0.90, "eyeSquint": 0.22, "mouthSmile": 0.75, "blush": 0.18, "sparkle": 0.65, "headTilt": -0.16, "headPitch": 0.22,  "bodyLean": -0.12, "armPose": "cross_arms"},
    "playful":      {"browY": 0.30, "browAngle": -0.10, "eyeOpen": 0.94, "eyeSquint": 0.28, "mouthSmile": 0.88, "blush": 0.22, "sparkle": 0.50, "headTilt": 0.40,  "headPitch": 0.10,  "bodyLean": 0.18,  "armPose": "wave"},
    "relieved":     {"browY": 0.12, "browAngle": 0.18,  "eyeOpen": 0.78, "eyeSquint": 0.38, "mouthSmile": 0.60, "blush": 0.25, "sparkle": 0.15, "headTilt": 0.12,  "headPitch": -0.06, "bodyLean": -0.08, "armPose": "idle"},
    "nostalgic":    {"browY": 0.14, "browAngle": 0.26,  "eyeOpen": 0.82, "eyeSquint": 0.18, "mouthSmile": 0.38, "blush": 0.18, "sparkle": 0.20, "headTilt": 0.26,  "headPitch": 0.08,  "bodyLean": -0.10, "armPose": "idle"},
    "surprised":    {"browY": 0.62, "browAngle": 0.05,  "eyeOpen": 1.15, "eyeSquint": 0.0,  "mouthSmile": 0.05, "blush": 0.12, "sparkle": 0.35, "headTilt": -0.12, "headPitch": 0.16,  "bodyLean": -0.28, "armPose": "cheer"},
    "hopeful":      {"browY": 0.26, "browAngle": 0.06,  "eyeOpen": 1.04, "eyeSquint": 0.10, "mouthSmile": 0.68, "blush": 0.16, "sparkle": 0.70, "headTilt": 0.14,  "headPitch": 0.16,  "bodyLean": 0.20,  "armPose": "cheer"},
    "protective":   {"browY": -0.22,"browAngle": -0.40, "eyeOpen": 0.92, "eyeSquint": 0.12, "mouthSmile": -0.15,"blush": 0.0,  "sparkle": 0.15, "headTilt": -0.08, "headPitch": -0.04, "bodyLean": 0.30,  "armPose": "cross_arms"},
    "admiring":     {"browY": 0.32, "browAngle": 0.08,  "eyeOpen": 1.06, "eyeSquint": 0.12, "mouthSmile": 0.78, "blush": 0.32, "sparkle": 0.88, "headTilt": 0.28,  "headPitch": 0.12,  "bodyLean": 0.22,  "armPose": "cheer"},
    "wary":         {"browY": -0.24,"browAngle": -0.36, "eyeOpen": 0.80, "eyeSquint": 0.22, "mouthSmile": -0.22,"blush": 0.0,  "sparkle": 0.0,  "headTilt": -0.22, "headPitch": -0.10, "bodyLean": -0.16, "armPose": "cross_arms"},
}

# Persona bias matching docs/persona/姬岁歌-岁人格设定.md & 姬岁歌-歌人格设定.md
# (Not a simple color filter: combines distinct textures + gaze + brow + posture + energy).
PERSONA_PROFILES: dict[str, dict[str, Any]] = {
    "sui": {
        "displayName": "姬岁歌 · 岁（听潮记岁）",
        "browYOffset": 0.08,
        "browAngleOffset": 0.06,
        "eyeOpenScale": 1.02,
        "gazeSharpness": 0.75,
        "headTiltBiasDeg": 2.4,
        "bodySwayScale": 1.05,
        "gestureEnergy": 1.0,
        "breathRate": 0.28,
        "transitionMs": 450,
    },
    "ge": {
        "displayName": "姬岁歌 · 歌（守潮成歌）",
        "browYOffset": -0.14,
        "browAngleOffset": -0.24,
        "eyeOpenScale": 0.89,
        "gazeSharpness": 1.15,
        "headTiltBiasDeg": -2.8,
        "bodySwayScale": 0.78,
        "gestureEnergy": 0.85,
        "breathRate": 0.23,
        "transitionMs": 450,
    },
}

MOTION_PRESETS: dict[str, dict[str, Any]] = {
    "idle":         {"durationMs": 1200, "loop": True,  "description": "自然待机呼吸与轻摆"},
    "wave":         {"durationMs": 2200, "loop": False, "description": "右手抬起向观众挥手打招呼"},
    "lean_in":      {"durationMs": 1800, "loop": False, "description": "身体微微前倾专注看弹幕或游戏"},
    "happy_bounce": {"durationMs": 1700, "loop": False, "description": "开心轻跳与双臂微抬"},
    "think":        {"durationMs": 2200, "loop": False, "description": "歪头抬手托腮思考"},
    "cross_arms":   {"durationMs": 2400, "loop": False, "description": "双臂抱胸，稳定果断站姿（适合歌人格）"},
    "bow":          {"durationMs": 1900, "loop": False, "description": "礼貌轻鞠躬致谢"},
}


class CanvasSpec(BaseModel):
    width: int = DEFAULT_CANVAS_WIDTH
    height: int = DEFAULT_CANVAS_HEIGHT
    anchorX: float = 0.5
    anchorY: float = 0.945


class BoneDef(BaseModel):
    id: str
    parent: str | None = None
    x: float
    y: float
    tipX: float
    tipY: float
    length: float
    restAngle: float = 0.0


class MeshData(BaseModel):
    positions: list[float] = Field(default_factory=list)
    uvs: list[float] = Field(default_factory=list)
    indices: list[int] = Field(default_factory=list)
    # Per vertex: list of [bone_index, weight], normalized to sum == 1.0
    weights: list[list[list[float]]] = Field(default_factory=list)


class LayerDef(BaseModel):
    id: str
    group: str
    displayName: str
    texture: str
    zOrder: int
    parentBone: str
    role: str
    side: str = "center"
    parallaxX: float = 0.0
    parallaxY: float = 0.0
    bbox: list[int] = Field(default_factory=lambda: [0, 0, 0, 0])
    pivot: list[float] = Field(default_factory=lambda: [0.0, 0.0])
    alphaCoverage: float = 0.0
    mesh: MeshData


class PhysicsDef(BaseModel):
    bone: str
    stiffness: float
    damping: float
    gravityScale: float
    inertia: float
    maxAngleDeg: float
    windPhase: float = 0.0


class VariantDef(BaseModel):
    id: str
    displayName: str
    textures: dict[str, str] = Field(default_factory=dict)
    profile: dict[str, Any] = Field(default_factory=dict)


class Rig2DModel(BaseModel):
    schemaVersion: Literal["rig2d-v1"] = SCHEMA_VERSION
    id: str
    name: str
    draft: bool = True
    characterBase: str = "jisui-draft"
    createdAt: str
    provider: str
    psdFile: str | None = "layered.psd"
    previewImage: str | None = "preview.png"
    canvas: CanvasSpec
    bones: list[BoneDef]
    layers: list[LayerDef]
    physics: list[PhysicsDef]
    variants: dict[str, VariantDef] = Field(default_factory=dict)
    expressions: dict[str, dict[str, Any]] = Field(default_factory=lambda: dict(EMOTION_PRESETS))
    motions: dict[str, dict[str, Any]] = Field(default_factory=lambda: dict(MOTION_PRESETS))
    qa: dict[str, Any] = Field(default_factory=dict)
