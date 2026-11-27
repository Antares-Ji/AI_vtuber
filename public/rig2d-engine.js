/**
 * Open Rig2D Skeletal Mesh + 2.5D Parallax + 2nd-Order Spring Physics Engine for PixiJS 8.
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

function expApproach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
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

    // Per-layer cached center for local facial transforms (eyes/brows/mouth)
    this.layerCenters = this.layers.map(layer => {
      const [x0, y0, x1, y1] = layer.bbox || [0, 0, 0, 0];
      return { cx: (x0 + x1) * 0.5, cy: (y0 + y1) * 0.5, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    });

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

    // Procedural blink & gaze
    this.blinkTimer = 2.6;
    this.blinkPhase = -1;
    this.blinkValue = 0.0; // 0 = open, 1 = closed
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

    // Active one-shot motion
    this.activeMotion = null; // { name, elapsed, duration }

    // 2nd-order damped spring state for hair & skirt chains
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
          prevWorldX: bone.x,
          prevWorldY: bone.y,
          prevParentRot: 0,
          initialized: false
        };
      });
    this.springByBoneIndex = new Map(this.springs.map(s => [s.boneIndex, s]));

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

    // 4. Auto-blink state machine
    if (this.blinkPhase < 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 0;
        this.blinkTimer = 2.4 + Math.abs(Math.sin(this.time * 13.7)) * 3.2;
      }
      this.blinkValue = 0;
    } else {
      this.blinkPhase += dt / 0.16;
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blinkValue = 0;
      } else {
        this.blinkValue = Math.sin(this.blinkPhase * Math.PI);
      }
    }

    // 5. Gaze saccades / mouse follow
    if (this.mouseFollow) {
      this.gazeTarget.x = this.pointer.x;
      this.gazeTarget.y = this.pointer.y;
    } else {
      this.gazeTimer -= dt;
      if (this.gazeTimer <= 0) {
        this.gazeTimer = 1.6 + Math.abs(Math.cos(this.time * 5.3)) * 2.4;
        const s = 0.52 / persona.gazeSharpness;
        this.gazeTarget.x = Math.sin(this.time * 2.13) * s;
        this.gazeTarget.y = Math.cos(this.time * 1.47) * (s * 0.45);
      }
    }
    this.gazeCurrent.x = expApproach(this.gazeCurrent.x, this.gazeTarget.x, 7.0, dt);
    this.gazeCurrent.y = expApproach(this.gazeCurrent.y, this.gazeTarget.y, 7.0, dt);

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

    // 7. Compute per-bone target local delta angles (radians) & root/torso translation
    const breath = Math.sin(this.time * Math.PI * 2 * persona.breathRate);
    const sway = Math.sin(this.time * 0.92) * persona.bodySwayScale;
    const talkCadence = speaking ? Math.sin(this.time * 10.5) * this.mouthLevel * persona.gestureEnergy : 0;

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

    // Core body breathing, sway, and emotion lean — pure cohesive FK rotation (no disconnected joint shifts!)
    const bounceY = motionName === "happy_bounce" ? -Math.abs(Math.sin(motionPhase * Math.PI * 3)) * 14 * motionEnv : 0;
    const bowLean = motionName === "bow" ? 6.5 * motionEnv : 0;
    const leanIn = motionName === "lean_in" ? 3.5 * motionEnv : 0;

    setBoneShift("hips", sway * 2.2, breath * -1.5 + bounceY);
    setBoneRot("hips", sway * 0.9);
    setBoneRot("spine", sway * 1.1 + this.expr.bodyLean * 2.2 + bowLean * 0.55 + leanIn * 0.5);
    setBoneRot("chest", -sway * 0.4 + this.expr.bodyLean * 1.6 + bowLean * 0.45 + talkCadence * 0.9);
    setBoneRot("neck", this.expr.headTilt * 2.5 + persona.headTiltBiasDeg * 0.35 + bowLean * 0.35);

    const thinkTilt = motionName === "think" ? 7.0 * motionEnv : 0;
    const headTiltDeg =
      this.expr.headTilt * 5.2 +
      persona.headTiltBiasDeg +
      sway * 1.2 +
      talkCadence * 2.0 +
      thinkTilt +
      (this.mouseFollow ? this.pointer.x * 4.5 : 0);
    setBoneRot("head", headTiltDeg);

    // 2.5D head yaw/pitch drivers for subtle facial-feature parallax only (never slides head off neck!)
    this.headYaw = clamp(
      this.gazeCurrent.x * 0.65 + sway * 0.18 + (this.mouseFollow ? this.pointer.x * 0.40 : 0),
      -1, 1
    );
    this.headPitch = clamp(
      this.expr.headPitch * 0.7 + this.gazeCurrent.y * 0.40 + talkCadence * 0.20 + (bowLean > 0 ? -bowLean * 0.06 : 0),
      -1, 1
    );

    // Graceful anatomically seated 2D arm poses (shoulders stay 100% locked inside shoulder sockets!)
    const armPose = motionName || basePreset.armPose || "idle";
    const armBreath = breath * 1.6;
    let lUpper = -armBreath, lLower = -armBreath * 0.6, rUpper = armBreath, rLower = armBreath * 0.6;

    if (armPose === "wave" || (motionName === "wave")) {
      const env = motionName === "wave" ? motionEnv : 0.72;
      rUpper = -26 * env;
      rLower = (-22 + Math.sin(this.time * 10.5) * 14) * env;
      lUpper = -4 * env;
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

    // 8. Forward kinematics pass 1 (non-spring structural bones) + spring physics integration
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

          const breeze = Math.sin(this.time * 1.55 + (spring.windPhase || 0)) * 0.045 * spring.gravityScale;
          const externalDrive = (-linVelX * 0.0022 - angVelParent * 0.32) * spring.inertia + breeze;
          const gravityRestoring = -pb.rot * 0.45 * spring.gravityScale;
          const acc = -spring.stiffness * (spring.angle - gravityRestoring) - spring.damping * spring.vel + externalDrive * spring.stiffness;
          spring.vel += acc * dt;
          spring.angle += spring.vel * dt;
          const maxRad = (spring.maxAngleDeg || 15) * DEG2RAD;
          if (spring.angle > maxRad) {
            spring.angle = maxRad;
            spring.vel *= -0.25;
          } else if (spring.angle < -maxRad) {
            spring.angle = -maxRad;
            spring.vel *= -0.25;
          }
          wb.rot = pb.rot + deltaAngles[i] + spring.angle;
        } else {
          wb.rot = pb.rot + deltaAngles[i];
        }
      }
      wb.cos = Math.cos(wb.rot);
      wb.sin = Math.sin(wb.rot);
    }

    // 9. Skin every layer mesh with LBS + 2.5D parallax + facial micro-transforms
    const effectiveEyeOpen = clamp(this.expr.eyeOpen * (1.0 - this.blinkValue), 0.0, 1.2);
    const closedAlpha = effectiveEyeOpen < 0.28 ? clamp((0.28 - effectiveEyeOpen) / 0.20, 0, 1) : 0;
    const openEyeScaleY = clamp(effectiveEyeOpen, 0.08, 1.15);

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

    for (let li = 0; li < this.layers.length; li += 1) {
      const layer = this.layers[li];
      const state = this.layerStates[li];
      const restPos = layer.mesh.positions;
      const weights = layer.mesh.weights;
      const out = state.positions;
      const center = this.layerCenters[li];
      const vCount = weights.length;

      const pxShift = this.headYaw * (layer.parallaxX || 0) * 14.0;
      const pyShift = this.headPitch * (layer.parallaxY || 0) * 10.0;

      // Determine layer alpha & local facial rest-space adjustments
      let alpha = 1.0;
      let localScaleY = 1.0;
      let localShiftX = 0.0;
      let localShiftY = 0.0;
      let localRot = 0.0;

      if (layer.role === "eye_closed") {
        alpha = closedAlpha;
      } else if (layer.role === "eye_open" || layer.role === "eye_sclera" || layer.role === "eye_iris") {
        alpha = 1.0 - closedAlpha * 0.95;
        localScaleY = openEyeScaleY;
        if (layer.role === "eye_iris") {
          localShiftX = this.gazeCurrent.x * 7.5;
          localShiftY = this.gazeCurrent.y * 4.5;
        }
      } else if (layer.role === "brow") {
        localShiftY = -this.expr.browY * 9.5;
        const sideSign = layer.side === "left" ? 1 : -1;
        localRot = this.expr.browAngle * 0.24 * sideSign;
      } else if (layer.role === "mouth") {
        alpha = mouthAlphas[layer.id] ?? 0;
        if (layer.id === "mouth_open") {
          localScaleY = 0.85 + m * 0.32;
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

      for (let v = 0; v < vCount; v += 1) {
        let vx = restPos[v * 2];
        let vy = restPos[v * 2 + 1];

        // Apply facial local deform around feature center BEFORE bone skinning
        if (localScaleY !== 1.0 || localShiftX !== 0.0 || localShiftY !== 0.0 || hasLocalRot) {
          let fx = vx - center.cx;
          let fy = (vy - center.cy) * localScaleY;
          if (hasLocalRot) {
            const rfx = fx * lCos - fy * lSin;
            const rfy = fx * lSin + fy * lCos;
            fx = rfx;
            fy = rfy;
          }
          vx = center.cx + fx + localShiftX;
          vy = center.cy + fy + localShiftY;
        }

        // Linear Blend Skinning across weighted bones
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
