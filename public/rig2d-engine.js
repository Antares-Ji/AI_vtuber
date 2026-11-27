/**
 * Open Rig2D Skeletal Mesh + 2.5D Perspective Head + Multi-Segment Cascaded Physics Engine for PixiJS 8.
 *
 * Clean-room Live2D-grade techniques integrated:
 *   1. 3-segment cascaded pendulum physics (S-curve wave lag on hair, outer skirt hem, and wide sleeve drapes).
 *   2. 9-axis coordinated head-to-body follow-through springs + 2.5D cylindrical/spherical head foreshortening (chin-pinned).
 *   3. Blink jelly eye-bounce oscillator + interior pupil gaze tracking + smile-eye crescent & mouth-corner micro-warp.
 *   4. Inertial arm/wrist follow-through lag + subtle volume-preserving ribcage breathing expansion.
 *   5. Natural double-blink & organic multi-frequency idle life + smooth 450ms Sui/Ge crossfade.
 *
 * Exports:
 *   - Rig2DController: pure headless kinematics, physics, 22-emotion, continuous RMS lip-sync,
 *     7 full-body motions, and Sui/Ge dual-persona state machine (zero DOM/Pixi dependency).
 *   - Rig2DPixiStage: PixiJS 8 native Mesh renderer with shared-geometry smooth Sui/Ge crossfade.
 */

const DEG2RAD = Math.PI / 180;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function smoothstep(edge0, edge1, x) {
  if (Math.abs(edge1 - edge0) < 1e-6) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function expApproach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function stepOscillator(state, target, stiffness, damping, impulse, maxAbs, dt) {
  const acc = -stiffness * (state.pos - target) - damping * state.vel + impulse;
  state.vel += acc * dt;
  state.pos += state.vel * dt;
  if (state.pos > maxAbs) {
    state.pos = maxAbs;
    state.vel *= -0.25;
  } else if (state.pos < -maxAbs) {
    state.pos = -maxAbs;
    state.vel *= -0.25;
  }
  return state.pos;
}

export class Rig2DController {
  constructor(modelData) {
    this.data = modelData;
    this.canvas = modelData.canvas || { width: 1024, height: 1536, anchorX: 0.5, anchorY: 0.945 };
    this.bones = (modelData.bones || []).map((b, idx) => ({ ...b, index: idx }));
    this.boneIndexById = new Map(this.bones.map(b => [b.id, b.index]));
    this.boneLocalOffsets = this.bones.map(b => {
      if (b.parent && this.boneIndexById.has(b.parent)) {
        const p = this.bones[this.boneIndexById.get(b.parent)];
        return { dx: b.x - p.x, dy: b.y - p.y, parentIndex: p.index };
      }
      return { dx: b.x, dy: b.y, parentIndex: -1 };
    });

    this.layers = modelData.layers || [];
    this.expressions = modelData.expressions || {};
    this.motions = modelData.motions || {};
    this.variants = modelData.variants || {};

    // Per-layer cached geometry metrics for local facial warps, 2.5D head perspective, and S-curve waves
    this.layerCenters = this.layers.map(layer => {
      const [x0, y0, x1, y1] = layer.bbox || [0, 0, 0, 0];
      return {
        x0, y0, x1, y1,
        cx: (x0 + x1) * 0.5,
        cy: (y0 + y1) * 0.5,
        w: Math.max(1, x1 - x0),
        h: Math.max(1, y1 - y0)
      };
    });

    // Detect if model has dedicated iris layers or crisp merged open-eye layers
    this.hasSeparateIris = this.layers.some(l => l.role === "eye_iris");

    // Precompute head metrics for chin-pinned 2.5D cylindrical/spherical head foreshortening
    const headLayerIdx = this.layers.findIndex(l => l.id === "head_base");
    const headBone = this.bones[this.boneIndexById.get("head") ?? -1];
    if (headLayerIdx >= 0) {
      const hc = this.layerCenters[headLayerIdx];
      this.headMetrics = {
        cx: headBone ? headBone.x : hc.cx,
        cy: hc.y0 + hc.h * 0.56,
        halfW: Math.max(40, hc.w * 0.44),
        halfH: Math.max(45, hc.h * 0.46),
        chinY: headBone ? Math.min(hc.y1, headBone.y + 4) : hc.y1
      };
    } else {
      this.headMetrics = {
        cx: headBone ? headBone.x : this.canvas.width * 0.5,
        cy: headBone ? headBone.y - 60 : this.canvas.height * 0.2,
        halfW: 80,
        halfH: 90,
        chinY: headBone ? headBone.y : this.canvas.height * 0.25
      };
    }

    // Precompute arm axes for sleeve drape secondary wave (strictly below shoulder cuff!)
    this.armAxes = {};
    for (const side of ["left", "right"]) {
      const upId = side === "left" ? "arm_l_upper" : "arm_r_upper";
      const loId = side === "left" ? "arm_l_lower" : "arm_r_lower";
      const bUp = this.bones[this.boneIndexById.get(upId) ?? -1];
      const bLo = this.bones[this.boneIndexById.get(loId) ?? -1];
      if (bUp && bLo) {
        const ax = bLo.x - bUp.x;
        const ay = bLo.y - bUp.y;
        const lenSq = Math.max(16, ax * ax + ay * ay);
        this.armAxes[side] = { x: bUp.x, y: bUp.y, ax, ay, lenSq, len: Math.sqrt(lenSq) };
      }
    }

    // Precompute unified torso ribcage & skirt-hem vertical bounds
    const bChest = this.bones[this.boneIndexById.get("chest") ?? -1];
    const bSpine = this.bones[this.boneIndexById.get("spine") ?? -1];
    const bHips = this.bones[this.boneIndexById.get("hips") ?? -1];
    const bSkL = this.bones[this.boneIndexById.get("skirt_l") ?? -1];
    const bSkC = this.bones[this.boneIndexById.get("skirt_c") ?? -1];
    const bSkR = this.bones[this.boneIndexById.get("skirt_r") ?? -1];
    this.torsoMetrics = {
      cx: bHips ? bHips.x : this.canvas.width * 0.5,
      chestY: bChest ? bChest.y : this.canvas.height * 0.28,
      spineY: bSpine ? bSpine.y : this.canvas.height * 0.34,
      hipsY: bHips ? bHips.y : this.canvas.height * 0.40,
      skirtBotY: (bSkL || bSkC || bSkR)
        ? Math.max(bSkL?.tipY || 0, bSkC?.tipY || 0, bSkR?.tipY || 0) + 36
        : this.canvas.height * 0.72
    };

    // Runtime state
    this.time = 0;
    this.emotionName = "neutral";
    this.emotionIntensity = 1.0;
    this.personaId = "sui";
    this.geBlend = 0.0; // 0 = sui, 1 = ge
    this.mouthTarget = 0.0;
    this.mouthLevel = 0.0;
    this.mouseFollow = false;
    this.pointer = { x: 0, y: 0 };

    // Optional manual 9-axis override (for workbench testing) & wind gust impulse
    this.headOverride = null; // { yaw, pitch, tilt } in [-1..1]
    this.windGust = 0.0;

    // Procedural blink (with natural occasional double-blink) & gaze
    this.blinkTimer = 2.4;
    this.blinkPhase = -1;
    this.blinkValue = 0.0; // 0 = open, 1 = closed
    this.pendingDoubleBlink = false;
    this.prevEyeOpen = 1.0;
    this.eyeBounce = { pos: 0, vel: 0 }; // Jelly eye rebound physics (inspired by Live2D eye/pupil physics)

    this.gazeTimer = 1.8;
    this.gazeTarget = { x: 0, y: 0 };
    this.gazeCurrent = { x: 0, y: 0 };

    // Smoothed expression channels
    this.expr = {
      browY: 0, browAngle: 0, eyeOpen: 1, eyeSquint: 0,
      mouthSmile: 0.15, blush: 0, sparkle: 0,
      headTilt: 0, headPitch: 0, bodyLean: 0
    };
    this.headYaw = 0;
    this.headPitch = 0;
    this.headTiltNorm = 0;
    this.prevHeadYaw = 0;
    this.prevHeadPitch = 0;

    // 9-axis head-to-body follow-through oscillators (inspired by X1/Y1/Z1 coupled inertia)
    this.bodyFollowX = { pos: 0, vel: 0 };
    this.bodyFollowY = { pos: 0, vel: 0 };
    this.bodyFollowZ = { pos: 0, vel: 0 };

    // Inertial arm follow-through (inspired by hand/arm delayed lag chains)
    this.armInertia = { upper: { pos: 0, vel: 0 }, lower: { pos: 0, vel: 0 } };
    this.prevSway = 0;

    // Wide hanging sleeve drape 3-segment pendulums (left & right)
    this.sleeveChains = {
      left: { segs: [{ pos: 0, vel: 0 }, { pos: 0, vel: 0 }, { pos: 0, vel: 0 }], prevRot: 0 },
      right: { segs: [{ pos: 0, vel: 0 }, { pos: 0, vel: 0 }, { pos: 0, vel: 0 }], prevRot: 0 }
    };

    // Active one-shot motion
    this.activeMotion = null; // { name, elapsed, duration }

    // 3-segment cascaded pendulum physics chains for hair & skirt
    this.springs = (modelData.physics || [])
      .filter(p => this.boneIndexById.has(p.bone))
      .map(p => {
        const bIdx = this.boneIndexById.get(p.bone);
        const bone = this.bones[bIdx];
        return {
          ...p,
          boneIndex: bIdx,
          angle: 0,
          vel: 0,
          segs: [
            { pos: 0, vel: 0 },
            { pos: 0, vel: 0 },
            { pos: 0, vel: 0 }
          ],
          prevWorldX: bone.x,
          prevWorldY: bone.y,
          prevParentRot: 0,
          initialized: false
        };
      });
    this.springByBoneIndex = new Map(this.springs.map(s => [s.boneIndex, s]));
    this.springByBoneId = new Map(this.springs.map(s => [s.bone, s]));

    // World transforms per bone (reused every frame)
    this.worldBones = this.bones.map(b => ({ x: b.x, y: b.y, rot: 0, cos: 1, sin: 0 }));

    // Output layer states (positions Float32Array + alpha)
    this.layerStates = this.layers.map(layer => ({
      id: layer.id,
      positions: new Float32Array(layer.mesh.positions),
      alpha: 1.0
    }));

    this.step(0.016);
  }

  setEmotion(emotion, intensity = 1.0) {
    const key = this.expressions[emotion] ? emotion : "neutral";
    this.emotionName = key;
    this.emotionIntensity = clamp(Number.isFinite(intensity) ? intensity : 1.0, 0.15, 1.25);
  }

  setMouth(value) {
    if (typeof value === "boolean") {
      this.mouthTarget = value ? 0.72 : 0.0;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      this.mouthTarget = clamp(value, 0.0, 1.0);
    } else {
      this.mouthTarget = 0.0;
    }
  }

  setPersona(personaId) {
    if (personaId === "ge" || personaId === "sui") {
      this.personaId = personaId;
    }
  }

  triggerMotion(name) {
    if (!name || name === "idle") {
      this.activeMotion = null;
      return;
    }
    const spec = this.motions[name];
    const duration = Math.max(0.5, ((spec && spec.durationMs) || 1800) / 1000);
    this.activeMotion = { name, elapsed: 0, duration };
  }

  setPointer(normX, normY) {
    this.pointer.x = clamp(normX, -1, 1);
    this.pointer.y = clamp(normY, -1, 1);
  }

  setMouseFollow(enabled) {
    this.mouseFollow = Boolean(enabled);
  }

  setHeadOverride(yaw = 0, pitch = 0, tilt = 0) {
    this.headOverride = {
      yaw: clamp(Number(yaw) || 0, -1, 1),
      pitch: clamp(Number(pitch) || 0, -1, 1),
      tilt: clamp(Number(tilt) || 0, -1, 1)
    };
  }

  clearHeadOverride() {
    this.headOverride = null;
  }

  triggerWindGust(strength = 1.0) {
    this.windGust = clamp(this.windGust + strength, -2.0, 2.5);
  }

  _personaProfile() {
    const sui = this.variants.sui?.profile || {
      browYOffset: 0.08, browAngleOffset: 0.06, eyeOpenScale: 1.02,
      gazeSharpness: 0.75, headTiltBiasDeg: 2.4, bodySwayScale: 1.05, gestureEnergy: 1.0, breathRate: 0.28
    };
    const ge = this.variants.ge?.profile || {
      browYOffset: -0.14, browAngleOffset: -0.24, eyeOpenScale: 0.89,
      gazeSharpness: 1.15, headTiltBiasDeg: -2.8, bodySwayScale: 0.78, gestureEnergy: 0.85, breathRate: 0.23
    };
    const g = this.geBlend;
    return {
      browYOffset: lerp(sui.browYOffset ?? 0, ge.browYOffset ?? 0, g),
      browAngleOffset: lerp(sui.browAngleOffset ?? 0, ge.browAngleOffset ?? 0, g),
      eyeOpenScale: lerp(sui.eyeOpenScale ?? 1, ge.eyeOpenScale ?? 0.9, g),
      gazeSharpness: lerp(sui.gazeSharpness ?? 0.8, ge.gazeSharpness ?? 1.1, g),
      headTiltBiasDeg: lerp(sui.headTiltBiasDeg ?? 2, ge.headTiltBiasDeg ?? -2.5, g),
      bodySwayScale: lerp(sui.bodySwayScale ?? 1, ge.bodySwayScale ?? 0.8, g),
      gestureEnergy: lerp(sui.gestureEnergy ?? 1, ge.gestureEnergy ?? 0.85, g),
      breathRate: lerp(sui.breathRate ?? 0.28, ge.breathRate ?? 0.23, g)
    };
  }

  step(rawDt) {
    const dt = clamp(Number.isFinite(rawDt) ? rawDt : 0.016, 0.001, 0.05);
    this.time += dt;
    this.windGust = expApproach(this.windGust, 0, 2.2, dt);

    // 1. Persona transition (450ms smooth crossfade)
    const targetGe = this.personaId === "ge" ? 1.0 : 0.0;
    this.geBlend = expApproach(this.geBlend, targetGe, 7.5, dt);
    const persona = this._personaProfile();

    // 2. Smooth continuous mouth lip-sync (fast attack, natural release)
    const mouthRate = this.mouthTarget > this.mouthLevel ? 24.0 : 14.0;
    this.mouthLevel = expApproach(this.mouthLevel, this.mouthTarget, mouthRate, dt);
    const speaking = this.mouthLevel > 0.05;

    // 3. Smooth 22-emotion channels blended with persona bias
    const basePreset = this.expressions[this.emotionName] || this.expressions.neutral || {};
    const k = this.emotionIntensity;
    const targets = {
      browY: (basePreset.browY || 0) * k + persona.browYOffset,
      browAngle: (basePreset.browAngle || 0) * k + persona.browAngleOffset,
      eyeOpen: clamp((basePreset.eyeOpen ?? 1.0) * persona.eyeOpenScale, 0.55, 1.18),
      eyeSquint: (basePreset.eyeSquint || 0) * k,
      mouthSmile: (basePreset.mouthSmile || 0) * k,
      blush: clamp((basePreset.blush || 0) * k, 0, 1),
      sparkle: clamp((basePreset.sparkle || 0) * k, 0, 1),
      headTilt: (basePreset.headTilt || 0) * k,
      headPitch: (basePreset.headPitch || 0) * k,
      bodyLean: (basePreset.bodyLean || 0) * k
    };
    for (const field of Object.keys(this.expr)) {
      this.expr[field] = expApproach(this.expr[field], targets[field], 8.5, dt);
    }

    // 4. Auto-blink state machine (with organic ~18% double-blink + jelly eyelid/pupil rebound)
    if (this.blinkPhase < 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 0;
        if (this.pendingDoubleBlink) {
          this.pendingDoubleBlink = false;
          this.blinkTimer = 2.6 + Math.abs(Math.sin(this.time * 11.3)) * 3.0;
        } else {
          const triggerDouble = Math.abs(Math.sin(this.time * 7.91)) > 0.82;
          this.pendingDoubleBlink = triggerDouble;
          this.blinkTimer = triggerDouble ? 0.14 : (2.3 + Math.abs(Math.sin(this.time * 13.7)) * 3.1);
        }
      }
      this.blinkValue = 0;
    } else {
      // Slightly faster close, softer cushioned open (like natural human blink)
      const dur = this.blinkPhase < 0.45 ? 0.12 : 0.18;
      this.blinkPhase += dt / dur;
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blinkValue = 0;
      } else {
        this.blinkValue = Math.sin(this.blinkPhase * Math.PI);
      }
    }

    // 5. Gaze saccades / mouse follow
    if (this.headOverride) {
      this.gazeTarget.x = this.headOverride.yaw * 0.9;
      this.gazeTarget.y = this.headOverride.pitch * 0.7;
    } else if (this.mouseFollow) {
      this.gazeTarget.x = this.pointer.x;
      this.gazeTarget.y = this.pointer.y;
    } else {
      this.gazeTimer -= dt;
      if (this.gazeTimer <= 0) {
        this.gazeTimer = 1.5 + Math.abs(Math.cos(this.time * 5.3)) * 2.3;
        const s = 0.56 / persona.gazeSharpness;
        this.gazeTarget.x = Math.sin(this.time * 2.13) * s;
        this.gazeTarget.y = Math.cos(this.time * 1.47) * (s * 0.45);
      }
    }
    this.gazeCurrent.x = expApproach(this.gazeCurrent.x, this.gazeTarget.x, 8.5, dt);
    this.gazeCurrent.y = expApproach(this.gazeCurrent.y, this.gazeTarget.y, 8.5, dt);

    // 6. Active one-shot motion envelope
    let motionName = null;
    let motionEnv = 0;
    let motionPhase = 0;
    if (this.activeMotion) {
      this.activeMotion.elapsed += dt;
      if (this.activeMotion.elapsed >= this.activeMotion.duration) {
        this.activeMotion = null;
      } else {
        motionName = this.activeMotion.name;
        motionPhase = this.activeMotion.elapsed / this.activeMotion.duration;
        motionEnv = Math.sin(motionPhase * Math.PI);
      }
    }

    // 7. Organic idle drift + 9-axis head drivers + damped body follow-through springs
    const breath = Math.sin(this.time * Math.PI * 2 * persona.breathRate);
    const sway = (Math.sin(this.time * 0.88) * 0.75 + Math.sin(this.time * 0.41 + 1.1) * 0.25) * persona.bodySwayScale;
    const talkCadence = speaking ? Math.sin(this.time * 10.5) * this.mouthLevel * persona.gestureEnergy : 0;
    const idleYawDrift = Math.sin(this.time * 0.47) * 0.22 + Math.sin(this.time * 0.19 + 0.8) * 0.12;
    const idlePitchDrift = Math.cos(this.time * 0.37) * 0.14;

    const bowLean = motionName === "bow" ? 6.5 * motionEnv : 0;
    const leanIn = motionName === "lean_in" ? 3.5 * motionEnv : 0;
    const thinkTilt = motionName === "think" ? 7.0 * motionEnv : 0;

    const targetYaw = this.headOverride
      ? this.headOverride.yaw
      : clamp(
          this.gazeCurrent.x * 0.55 + idleYawDrift + sway * 0.16 + (this.mouseFollow ? this.pointer.x * 0.52 : 0),
          -1, 1
        );
    const targetPitch = this.headOverride
      ? this.headOverride.pitch
      : clamp(
          this.expr.headPitch * 0.65 + this.gazeCurrent.y * 0.35 + idlePitchDrift +
          talkCadence * 0.22 + (bowLean > 0 ? -bowLean * 0.08 : 0) + (this.mouseFollow ? this.pointer.y * 0.42 : 0),
          -1, 1
        );
    const targetTiltNorm = this.headOverride
      ? this.headOverride.tilt
      : clamp((this.mouseFollow ? this.pointer.x * 0.36 : 0) + sway * 0.12, -1, 1);

    this.prevHeadYaw = this.headYaw;
    this.prevHeadPitch = this.headPitch;
    this.headYaw = expApproach(this.headYaw, targetYaw, 9.5, dt);
    this.headPitch = expApproach(this.headPitch, targetPitch, 9.5, dt);
    this.headTiltNorm = expApproach(this.headTiltNorm, targetTiltNorm, 8.5, dt);

    const headYawVel = (this.headYaw - this.prevHeadYaw) / dt;
    const headPitchVel = (this.headPitch - this.prevHeadPitch) / dt;

    // 9-axis head -> body lag springs (shoulders & spine softly follow head turn ~120ms behind!)
    stepOscillator(this.bodyFollowX, this.headYaw, 28.0, 7.6, 0, 1.25, dt);
    stepOscillator(this.bodyFollowY, this.headPitch, 26.0, 7.4, 0, 1.25, dt);
    stepOscillator(this.bodyFollowZ, this.headTiltNorm + this.headYaw * 0.32, 24.0, 7.2, 0, 1.25, dt);

    // Inertial arm lag driven by body sway acceleration
    const swayVel = (sway - this.prevSway) / dt;
    this.prevSway = sway;
    stepOscillator(this.armInertia.upper, -this.bodyFollowZ.pos * 1.4, 34.0, 7.2, -swayVel * 3.8, 4.0, dt);
    stepOscillator(this.armInertia.lower, this.armInertia.upper.pos * 1.15, 22.0, 5.8, -this.armInertia.upper.vel * 0.9, 6.5, dt);

    const deltaAngles = new Float32Array(this.bones.length);
    const extraOffsetX = new Float32Array(this.bones.length);
    const extraOffsetY = new Float32Array(this.bones.length);

    const setBoneRot = (id, deg) => {
      const idx = this.boneIndexById.get(id);
      if (idx !== undefined) deltaAngles[idx] += deg * DEG2RAD;
    };
    const setBoneShift = (id, ox, oy) => {
      const idx = this.boneIndexById.get(id);
      if (idx !== undefined) {
        extraOffsetX[idx] += ox;
        extraOffsetY[idx] += oy;
      }
    };

    // Core body breathing, 9-axis follow-through, and emotion lean — pure cohesive FK rotation
    const bounceY = motionName === "happy_bounce" ? -Math.abs(Math.sin(motionPhase * Math.PI * 3)) * 14 * motionEnv : 0;

    setBoneShift("hips", sway * 2.2 + this.bodyFollowX.pos * 3.2, breath * -1.4 + this.bodyFollowY.pos * 1.6 + bounceY);
    setBoneRot("hips", sway * 0.85 - this.bodyFollowZ.pos * 0.9);
    setBoneRot("spine", sway * 1.05 + this.expr.bodyLean * 2.1 + this.bodyFollowZ.pos * 1.8 + bowLean * 0.55 + leanIn * 0.5);
    setBoneRot("chest", -sway * 0.35 + this.expr.bodyLean * 1.5 + this.bodyFollowZ.pos * 1.6 + bowLean * 0.45 + talkCadence * 0.9);
    setBoneRot("neck", this.expr.headTilt * 2.4 + persona.headTiltBiasDeg * 0.35 + this.headTiltNorm * 3.0 + bowLean * 0.35);

    const headTiltDeg =
      this.expr.headTilt * 5.0 +
      persona.headTiltBiasDeg +
      sway * 1.1 +
      talkCadence * 2.0 +
      thinkTilt +
      this.headTiltNorm * 6.8 +
      this.headYaw * 1.8;
    setBoneRot("head", headTiltDeg);

    // Graceful anatomically seated 2D arm poses + subtle inertial follow-through
    const armPose = motionName || basePreset.armPose || "idle";
    const armBreath = breath * 1.55;
    const armLagUp = this.armInertia.upper.pos;
    const armLagLo = this.armInertia.lower.pos;
    let lUpper = -armBreath + armLagUp * 0.55;
    let lLower = -armBreath * 0.6 + armLagLo * 0.65;
    let rUpper = armBreath + armLagUp * 0.55;
    let rLower = armBreath * 0.6 + armLagLo * 0.65;

    if (armPose === "wave" || (motionName === "wave")) {
      const env = motionName === "wave" ? motionEnv : 0.72;
      rUpper = -26 * env + armLagUp * 0.25;
      rLower = (-22 + Math.sin(this.time * 10.5) * 14) * env;
      lUpper = -4 * env + armLagUp * 0.4;
    } else if (armPose === "cheer" || motionName === "happy_bounce") {
      const env = motionName ? motionEnv : 0.70;
      lUpper = 16 * env;
      lLower = 14 * env;
      rUpper = -16 * env;
      rLower = -14 * env;
    } else if (armPose === "shy") {
      lUpper = -7;
      lLower = -12;
      rUpper = 7;
      rLower = 12;
    } else if (armPose === "think") {
      const env = motionName === "think" ? motionEnv : 0.72;
      rUpper = -16 * env;
      rLower = -28 * env;
      lUpper = -4 * env;
      lLower = -8 * env;
    } else if (armPose === "cross_arms") {
      const env = motionName === "cross_arms" ? motionEnv : 0.72;
      lUpper = -10 * env;
      lLower = -18 * env;
      rUpper = 10 * env;
      rLower = 18 * env;
    } else if (armPose === "bow") {
      const env = motionName === "bow" ? motionEnv : 0.65;
      lUpper = -6 * env;
      lLower = -8 * env;
      rUpper = 6 * env;
      rLower = 8 * env;
    } else if (speaking) {
      lUpper += talkCadence * 3.0;
      lLower += talkCadence * 4.0;
      rUpper -= talkCadence * 3.0;
      rLower -= talkCadence * 4.0;
    }

    setBoneRot("arm_l_upper", lUpper);
    setBoneRot("arm_l_lower", lLower);
    setBoneRot("arm_r_upper", rUpper);
    setBoneRot("arm_r_lower", rLower);

    // Subtle leg counter-sway so feet stay anchored visually
    setBoneRot("leg_l_upper", -sway * 1.1);
    setBoneRot("leg_l_lower", sway * 0.7);
    setBoneRot("leg_r_upper", -sway * 1.1);
    setBoneRot("leg_r_lower", sway * 0.7);

    // Update 3-segment cascaded sleeve drape pendulums (driven by arm rotation + head/body sway + wind)
    for (const [side, rotDeg] of [["left", lUpper + lLower * 0.7], ["right", rUpper + rLower * 0.7]]) {
      const chain = this.sleeveChains[side];
      const rotRad = rotDeg * DEG2RAD;
      const armAngVel = (rotRad - chain.prevRot) / dt;
      chain.prevRot = rotRad;
      const breeze = (Math.sin(this.time * 1.4 + (side === "left" ? 0.5 : 2.1)) * 0.04 + this.windGust * 0.14);
      const drive0 = (-armAngVel * 0.22 - swayVel * 0.14 - headYawVel * 0.05) + breeze;
      const prev0 = chain.segs[0].vel;
      stepOscillator(chain.segs[0], breeze * 0.5, 52.0, 8.2, drive0 * 28.0, 0.24, dt);
      const acc0 = (chain.segs[0].vel - prev0) / dt;
      const prev1 = chain.segs[1].vel;
      stepOscillator(chain.segs[1], chain.segs[0].pos * 0.85, 38.0, 6.8, -acc0 * 0.35 + breeze * 8.0, 0.30, dt);
      const acc1 = (chain.segs[1].vel - prev1) / dt;
      stepOscillator(chain.segs[2], chain.segs[1].pos * 0.9, 28.0, 5.8, -acc1 * 0.32 + breeze * 6.0, 0.36, dt);
    }

    // 8. Forward kinematics pass + 3-segment cascaded spring physics integration
    for (let i = 0; i < this.bones.length; i += 1) {
      const { dx, dy, parentIndex } = this.boneLocalOffsets[i];
      const wb = this.worldBones[i];
      const spring = this.springByBoneIndex.get(i);

      if (parentIndex < 0) {
        wb.x = dx + extraOffsetX[i];
        wb.y = dy + extraOffsetY[i];
        wb.rot = deltaAngles[i];
      } else {
        const pb = this.worldBones[parentIndex];
        const rx = dx * pb.cos - dy * pb.sin;
        const ry = dx * pb.sin + dy * pb.cos;
        wb.x = pb.x + rx + extraOffsetX[i];
        wb.y = pb.y + ry + extraOffsetY[i];

        if (spring) {
          if (!spring.initialized) {
            spring.prevWorldX = wb.x;
            spring.prevWorldY = wb.y;
            spring.prevParentRot = pb.rot;
            spring.initialized = true;
          }
          const linVelX = (wb.x - spring.prevWorldX) / dt;
          const angVelParent = (pb.rot - spring.prevParentRot) / dt;
          spring.prevWorldX = wb.x;
          spring.prevWorldY = wb.y;
          spring.prevParentRot = pb.rot;

          const phase = spring.windPhase || 0;
          const breeze = (Math.sin(this.time * 1.55 + phase) * 0.042 + Math.sin(this.time * 2.9 + phase * 1.7) * 0.015) * spring.gravityScale
            + this.windGust * 0.15 * spring.gravityScale;
          const yawKick = spring.bone.startsWith("hair") ? -headYawVel * 0.055 * spring.inertia : -headYawVel * 0.025 * spring.inertia;
          const externalDrive = (-linVelX * 0.0022 - angVelParent * 0.34) * spring.inertia + yawKick + breeze;
          const gravityRestoring = -pb.rot * 0.45 * spring.gravityScale;
          const maxRad = (spring.maxAngleDeg || 8.5) * DEG2RAD;

          // Segment 0 (root pendulum)
          const k0 = spring.stiffness || 70;
          const d0 = spring.damping || 9.0;
          const prevV0 = spring.segs[0].vel;
          stepOscillator(spring.segs[0], gravityRestoring, k0, d0, externalDrive * k0, maxRad, dt);
          const acc0 = (spring.segs[0].vel - prevV0) / dt;

          // Segment 1 (mid cascaded wave with phase delay)
          const prevV1 = spring.segs[1].vel;
          stepOscillator(spring.segs[1], spring.segs[0].pos * 0.85, k0 * 0.76, d0 * 0.82, -acc0 * 0.34 + breeze * k0 * 0.25, maxRad * 1.25, dt);
          const acc1 = (spring.segs[1].vel - prevV1) / dt;

          // Segment 2 (tip whip wave with silky S-curve lag)
          stepOscillator(spring.segs[2], spring.segs[1].pos * 0.9, k0 * 0.58, d0 * 0.74, -acc1 * 0.30 + breeze * k0 * 0.20, maxRad * 1.45, dt);

          spring.angle = spring.segs[0].pos;
          spring.vel = spring.segs[0].vel;
          wb.rot = pb.rot + deltaAngles[i] + spring.angle;
        } else {
          wb.rot = pb.rot + deltaAngles[i];
        }
      }
      wb.cos = Math.cos(wb.rot);
      wb.sin = Math.sin(wb.rot);
    }

    // 9. Jelly eye bounce spring driven by eye-open rate of change (inspired by Live2D eye/pupil physics)
    const rawEyeOpen = clamp(this.expr.eyeOpen * (1.0 - this.blinkValue), 0.0, 1.2);
    const eyeOpenVel = (rawEyeOpen - this.prevEyeOpen) / dt;
    this.prevEyeOpen = rawEyeOpen;
    // Only kick jelly bounce on opening / widening (positive dEyeOpen/dt) so closed blink stays crisp
    const eyeImpulse = eyeOpenVel > 0.2 ? clamp(eyeOpenVel * 3.8, 0, 22.0) : 0;
    stepOscillator(this.eyeBounce, 0, 210.0, 15.5, eyeImpulse, 0.14, dt);

    const closedAlpha = rawEyeOpen < 0.28 ? clamp((0.28 - rawEyeOpen) / 0.20, 0, 1) : 0;
    const openEyeScaleY = clamp(rawEyeOpen + (1 - closedAlpha) * this.eyeBounce.pos * 0.45, 0.08, 1.18);

    // Continuous 4-state mouth blending weights
    const m = this.mouthLevel;
    const smileW = clamp(this.expr.mouthSmile, 0, 1);
    const mouthAlphas = {
      mouth_closed: clamp(1 - m * 5.0, 0, 1) * (1 - smileW * 0.85),
      mouth_smile: clamp(1 - m * 4.5, 0, 1) * (smileW * 0.95),
      mouth_half: clamp(1 - Math.abs(m - 0.36) * 3.0, 0, 1) * clamp(m * 6.0, 0, 1),
      mouth_open: clamp((m - 0.42) / 0.36, 0, 1)
    };
    const totalMouth = mouthAlphas.mouth_closed + mouthAlphas.mouth_smile + mouthAlphas.mouth_half + mouthAlphas.mouth_open;
    if (totalMouth < 0.05) mouthAlphas.mouth_closed = 1;

    // 10. Skin every layer mesh with LBS + 2.5D head perspective + 3-segment wave lag + micro-expressions
    const hm = this.headMetrics;
    const tm = this.torsoMetrics;
    const skL = this.springByBoneId.get("skirt_l");
    const skR = this.springByBoneId.get("skirt_r");

    for (let li = 0; li < this.layers.length; li += 1) {
      const layer = this.layers[li];
      const state = this.layerStates[li];
      const restPos = layer.mesh.positions;
      const weights = layer.mesh.weights;
      const out = state.positions;
      const center = this.layerCenters[li];
      const vCount = weights.length;

      const pxShift = this.headYaw * (layer.parallaxX || 0) * 14.5;
      const pyShift = this.headPitch * (layer.parallaxY || 0) * 10.5;

      // Determine layer alpha & local facial rest-space adjustments
      let alpha = 1.0;
      let localScaleX = 1.0;
      let localScaleY = 1.0;
      let localShiftX = 0.0;
      let localShiftY = 0.0;
      let localRot = 0.0;

      const isHeadBase = layer.id === "head_base";
      const isOpenEye = layer.role === "eye_open" || layer.role === "eye_sclera";
      const isEyeIris = layer.role === "eye_iris";
      const isMouth = layer.role === "mouth";
      const isHair = layer.role === "hair";
      const isUnifiedBody = layer.role === "unified_body";
      const isArmFull = layer.role === "arm_full";
      const sideSign = layer.side === "left" ? -1 : layer.side === "right" ? 1 : 0;

      if (layer.role === "eye_closed") {
        alpha = closedAlpha;
        localScaleX = 1.0 - sideSign * this.headYaw * 0.06;
      } else if (isOpenEye || isEyeIris) {
        alpha = 1.0 - closedAlpha * 0.95;
        localScaleY = openEyeScaleY;
        // 2.5D perspective foreshortening: far eye subtly narrows as head turns!
        localScaleX = 1.0 - sideSign * this.headYaw * 0.075;
        if (isEyeIris) {
          localShiftX = this.gazeCurrent.x * 7.5;
          localShiftY = this.gazeCurrent.y * 4.5 - this.eyeBounce.pos * 12.0;
        }
      } else if (layer.role === "brow") {
        localShiftY = -this.expr.browY * 9.5 - this.eyeBounce.pos * 6.0;
        localScaleX = 1.0 - sideSign * this.headYaw * 0.06;
        const browSign = layer.side === "left" ? 1 : -1;
        localRot = this.expr.browAngle * 0.24 * browSign;
      } else if (isMouth) {
        alpha = mouthAlphas[layer.id] ?? 0;
        localScaleX = 1.0 - Math.abs(this.headYaw) * 0.04;
        if (layer.id === "mouth_open") {
          localScaleY = 0.85 + m * 0.34;
        }
      } else if (layer.id === "fx_blush") {
        alpha = this.expr.blush;
      } else if (layer.id === "fx_sparkle") {
        alpha = this.expr.sparkle * (0.76 + 0.24 * Math.sin(this.time * 5.8));
      }

      state.alpha = clamp(alpha, 0, 1);

      const hasLocalRot = Math.abs(localRot) > 1e-4;
      const lCos = hasLocalRot ? Math.cos(localRot) : 1;
      const lSin = hasLocalRot ? Math.sin(localRot) : 0;

      // Pre-resolve hair spring chain if this is a hair layer
      const hairSpring = isHair ? this.springByBoneId.get(layer.parentBone) : null;
      const hairBone = isHair ? this.bones[this.boneIndexById.get(layer.parentBone) ?? -1] : null;
      const armAxis = isArmFull ? this.armAxes[layer.side] : null;
      const sleeveChain = isArmFull ? this.sleeveChains[layer.side] : null;

      for (let v = 0; v < vCount; v += 1) {
        let vx = restPos[v * 2];
        let vy = restPos[v * 2 + 1];

        // A. Chin-pinned 2.5D spherical/cylindrical head-turn foreshortening on head_base
        if (isHeadBase) {
          const jawPin = smoothstep(hm.chinY - 2, hm.chinY - hm.halfH * 0.55, vy);
          if (jawPin > 1e-4) {
            const nx = clamp((vx - hm.cx) / hm.halfW, -1.25, 1.25);
            const ny = clamp((vy - hm.cy) / hm.halfH, -1.25, 1.25);
            vx += (this.headYaw * (1.0 - 0.38 * nx * nx) * 5.2 - this.headYaw * nx * nx * 2.2) * jawPin;
            vy += (-this.headYaw * nx * 1.8 + this.headPitch * (1.0 - 0.28 * ny * ny) * 4.4) * jawPin;
          }
        }

        // B. Local facial expression + jelly pupil tracking + smile-eye crescent + mouth-corner curve
        if (localScaleX !== 1.0 || localScaleY !== 1.0 || localShiftX !== 0.0 || localShiftY !== 0.0 || hasLocalRot || isOpenEye || isMouth) {
          let fx = vx - center.cx;
          let fy = vy - center.cy;
          const nfx = fx / Math.max(1, center.w * 0.5);
          const nfy = fy / Math.max(1, center.h * 0.5);

          // Interior pupil gaze tracking & jelly eye-bounce on merged open eyes (outer rim pinned!)
          if (isOpenEye && !this.hasSeparateIris) {
            const radial = Math.hypot(nfx, nfy);
            const innerW = 1.0 - smoothstep(0.28, 0.92, radial);
            fx += this.gazeCurrent.x * 3.8 * innerW;
            fy += (this.gazeCurrent.y * 2.4 - this.eyeBounce.pos * 10.0) * innerW;
          }

          // Smile-eye crescent lift on lower half of open eye (inspired by EyeSquint / EyeSmile)
          if (isOpenEye && this.expr.eyeSquint > 0.02 && nfy > 0.05) {
            const lowerW = smoothstep(0.05, 0.95, nfy) * (1.0 - 0.42 * nfx * nfx);
            fy -= this.expr.eyeSquint * 4.8 * lowerW;
          }

          // Mouth corner smile / frown curvature (inspired by ParamMouthForm)
          if (isMouth && Math.abs(this.expr.mouthSmile) > 0.04) {
            const cornerW = smoothstep(0.25, 1.0, Math.abs(nfx));
            fy -= this.expr.mouthSmile * 3.0 * cornerW;
          }

          fx *= localScaleX;
          fy *= localScaleY;
          if (hasLocalRot) {
            const rfx = fx * lCos - fy * lSin;
            const rfy = fx * lSin + fy * lCos;
            fx = rfx;
            fy = rfy;
          }
          vx = center.cx + fx + localShiftX;
          vy = center.cy + fy + localShiftY;
        }

        // C. 3-segment cascaded S-curve wave on hair (root pinned 100%, mid & tips ripple smoothly!)
        if (isHair && hairSpring && hairBone) {
          const spanY = Math.max(40, center.y1 - hairBone.y);
          const tHair = clamp((vy - hairBone.y) / spanY, 0, 1);
          if (tHair > 0.08) {
            const waveX = (
              (hairSpring.segs[1].pos - hairSpring.segs[0].pos) * (tHair * tHair) * 105.0 +
              (hairSpring.segs[2].pos - hairSpring.segs[1].pos) * (tHair * tHair * tHair) * 145.0
            );
            const waveY = Math.abs(hairSpring.segs[2].pos) * (tHair * tHair) * 14.0;
            vx += waveX;
            vy -= waveY;
          }
        }

        // D. Unified body: gentle volume-preserving ribcage breath + 3-segment outer skirt hem wave
        if (isUnifiedBody) {
          // Subtle ribcage breath (zero at shoulders & waist so joints stay 100% locked!)
          const ribEnv = smoothstep(tm.chestY - 12, tm.chestY + 26, vy) * (1.0 - smoothstep(tm.spineY - 10, tm.hipsY - 18, vy));
          if (ribEnv > 1e-3) {
            const dxRib = vx - tm.cx;
            vx += dxRib * (breath * 0.012 * ribEnv);
            vy += breath * -1.2 * ribEnv;
          }
          // Cascaded outer flared skirt-hem wave (strictly outside inner leg column!)
          if (skL && skR && vy > tm.hipsY + 24 && vy < tm.skirtBotY) {
            const distX = Math.abs(vx - tm.cx);
            const flareW = smoothstep(58, 150, distX);
            const vT = clamp((vy - (tm.hipsY + 24)) / Math.max(80, tm.skirtBotY - tm.hipsY - 24), 0, 1);
            const vOut = 1.0 - smoothstep(0.84, 1.0, vT);
            const sk = vx < tm.cx ? skL : skR;
            const hemWave = flareW * vOut * (
              (sk.segs[1].pos - sk.segs[0].pos) * (vT * vT) * 70.0 +
              (sk.segs[2].pos - sk.segs[1].pos) * (vT * vT * vT) * 105.0
            );
            vx += hemWave;
          }
        }

        // E. Wide hanging sleeve drape S-curve wave (strictly below upper sleeve t > 0.55 so shoulder is 100% locked!)
        if (isArmFull && armAxis && sleeveChain) {
          const rxA = vx - armAxis.x;
          const ryA = vy - armAxis.y;
          const tArm = (rxA * armAxis.ax + ryA * armAxis.ay) / armAxis.lenSq;
          if (tArm > 0.52) {
            const lowerW = smoothstep(0.52, 1.45, tArm);
            // Hanging drape distance below arm centerline gets extra silk sway
            const cross = (rxA * armAxis.ay - ryA * armAxis.ax) / armAxis.len;
            const drapeBoost = 0.45 + 0.55 * smoothstep(10, 95, Math.abs(cross));
            const sWave = lowerW * drapeBoost * (
              sleeveChain.segs[1].pos * 24.0 +
              sleeveChain.segs[2].pos * 34.0
            );
            vx += sWave;
            vy += Math.abs(sleeveChain.segs[2].pos) * lowerW * 4.0;
          }
        }

        // F. Linear Blend Skinning across weighted bones
        const vw = weights[v];
        let sx = 0;
        let sy = 0;
        for (let kIdx = 0; kIdx < vw.length; kIdx += 1) {
          const bIdx = vw[kIdx][0];
          const wVal = vw[kIdx][1];
          const restBone = this.bones[bIdx];
          const wb = this.worldBones[bIdx];
          const rx = vx - restBone.x;
          const ry = vy - restBone.y;
          sx += (wb.x + rx * wb.cos - ry * wb.sin) * wVal;
          sy += (wb.y + rx * wb.sin + ry * wb.cos) * wVal;
        }

        out[v * 2] = sx + pxShift;
        out[v * 2 + 1] = sy + pyShift;
      }
    }
  }

  snapshot() {
    return {
      modelId: this.data.id,
      name: this.data.name,
      personaId: this.personaId,
      geBlend: Number(this.geBlend.toFixed(3)),
      emotion: this.emotionName,
      mouthLevel: Number(this.mouthLevel.toFixed(3)),
      activeMotion: this.activeMotion?.name || "idle",
      headYaw: Number(this.headYaw.toFixed(3)),
      headPitch: Number(this.headPitch.toFixed(3)),
      eyeBounce: Number(this.eyeBounce.pos.toFixed(4)),
      boneCount: this.bones.length,
      layerCount: this.layers.length,
      bones: this.worldBones.map((wb, i) => ({ id: this.bones[i].id, x: wb.x, y: wb.y, rot: wb.rot }))
    };
  }
}

function loadHtmlImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load texture: ${url}`));
    img.src = url;
  });
}

function resolveRelativeUrl(baseModelUrl, relPath) {
  const base = new URL(baseModelUrl, window.location.href);
  return new URL(relPath, base).href;
}

export class Rig2DPixiStage {
  constructor(PIXI, modelData, baseUrl) {
    this.PIXI = PIXI;
    this.baseUrl = baseUrl;
    this.controller = new Rig2DController(modelData);
    this.container = new PIXI.Container();
    this.container.sortableChildren = true;
    this.meshEntries = [];
    this.destroyed = false;
  }

  async loadTextures() {
    const { PIXI } = this;
    const geOverrides = this.controller.data.variants?.ge?.textures || {};
    const sorted = this.controller.layers
      .map((layer, index) => ({ layer, index }))
      .sort((a, b) => a.layer.zOrder - b.layer.zOrder);

    // Preload all PNG textures in parallel via HTMLImageElement (WebGL safe)
    const loadTasks = sorted.map(async ({ layer, index }) => {
      const baseImg = await loadHtmlImage(resolveRelativeUrl(this.baseUrl, layer.texture));
      const baseTex = PIXI.Texture.from(baseImg);
      let geTex = null;
      if (geOverrides[layer.id]) {
        try {
          const geImg = await loadHtmlImage(resolveRelativeUrl(this.baseUrl, geOverrides[layer.id]));
          geTex = PIXI.Texture.from(geImg);
        } catch {
          geTex = null;
        }
      }
      return { layer, index, baseTex, geTex };
    });

    const loaded = await Promise.all(loadTasks);
    if (this.destroyed) return;

    for (const { layer, index, baseTex, geTex } of loaded) {
      const state = this.controller.layerStates[index];
      const geometry = new PIXI.MeshGeometry({
        positions: state.positions,
        uvs: new Float32Array(layer.mesh.uvs),
        indices: new Uint32Array(layer.mesh.indices)
      });

      const baseMesh = new PIXI.Mesh({ geometry, texture: baseTex });
      baseMesh.zIndex = layer.zOrder * 2;
      this.container.addChild(baseMesh);

      let geMesh = null;
      if (geTex) {
        // Shares exact same MeshGeometry for zero-cost, 100% pixel-aligned Sui <-> Ge crossfade!
        geMesh = new PIXI.Mesh({ geometry, texture: geTex });
        geMesh.zIndex = layer.zOrder * 2 + 1;
        geMesh.alpha = 0;
        this.container.addChild(geMesh);
      }

      this.meshEntries.push({ index, geometry, baseMesh, geMesh });
    }
    this.syncMeshes();
  }

  update(dtSeconds) {
    if (this.destroyed) return;
    this.controller.step(dtSeconds);
    this.syncMeshes();
  }

  syncMeshes() {
    const geBlend = this.controller.geBlend;
    for (const entry of this.meshEntries) {
      const state = this.controller.layerStates[entry.index];
      const posBuffer = entry.geometry.getBuffer("aPosition");
      if (posBuffer) {
        posBuffer.data = state.positions;
        posBuffer.update();
      }
      if (entry.geMesh) {
        entry.baseMesh.alpha = state.alpha * (1 - geBlend);
        entry.geMesh.alpha = state.alpha * geBlend;
        entry.baseMesh.visible = entry.baseMesh.alpha > 0.005;
        entry.geMesh.visible = entry.geMesh.alpha > 0.005;
      } else {
        entry.baseMesh.alpha = state.alpha;
        entry.baseMesh.visible = state.alpha > 0.005;
      }
    }
  }

  get baseWidth() {
    return this.controller.canvas.width;
  }

  get baseHeight() {
    return this.controller.canvas.height;
  }

  destroy() {
    this.destroyed = true;
    this.container.destroy({ children: true, texture: true, textureSource: true });
    this.meshEntries = [];
  }
}
