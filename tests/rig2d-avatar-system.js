const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  AVATARS_DIR,
  LEGACY_CUBISM_PATH,
  safeAvatarModelPath,
  listAvailableAvatars,
  resolveActiveAvatar
} = require("../src/avatars/registry");

function loadRig2DController() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "rig2d-engine.js"), "utf8")
    .replace(/export\s+class\s+/g, "class ");
  const sandbox = { Math, Map, Set, Float32Array, Uint32Array, Number, Object, Array, console };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nglobalThis.__exports = { Rig2DController };`, sandbox, { filename: "rig2d-engine.js" });
  return sandbox.__exports.Rig2DController;
}

async function testRig2DControllerMath() {
  const Rig2DController = loadRig2DController();

  // Load real generated model if published, otherwise use compact synthetic fixture
  const defaultPublished = path.join(AVATARS_DIR, "jisui-tidal-draft", "model.rig2d.json");
  let modelData;
  if (fs.existsSync(defaultPublished)) {
    modelData = JSON.parse(fs.readFileSync(defaultPublished, "utf8"));
  } else {
    modelData = {
      schemaVersion: "rig2d-v1",
      id: "unit-fixture",
      name: "Fixture",
      canvas: { width: 512, height: 768, anchorX: 0.5, anchorY: 0.945 },
      bones: [
        { id: "root", parent: null, x: 256, y: 720, tipX: 256, tipY: 430, length: 290, restAngle: -1.57 },
        { id: "hips", parent: "root", x: 256, y: 430, tipX: 256, tipY: 360, length: 70, restAngle: -1.57 },
        { id: "chest", parent: "hips", x: 256, y: 300, tipX: 256, tipY: 240, length: 60, restAngle: -1.57 },
        { id: "head", parent: "chest", x: 256, y: 180, tipX: 256, tipY: 90, length: 90, restAngle: -1.57 },
        { id: "hair_bang_c", parent: "head", x: 256, y: 110, tipX: 256, tipY: 180, length: 70, restAngle: 1.57 }
      ],
      layers: [
        {
          id: "hair_bang_c", group: "FrontHair", displayName: "中刘海", texture: "layers/hair_bang_c.png",
          zOrder: 126, parentBone: "hair_bang_c", role: "hair", side: "center", parallaxX: 0.45, parallaxY: 0.3,
          bbox: [220, 100, 290, 180], pivot: [256, 110], alphaCoverage: 0.5,
          mesh: {
            positions: [220, 100, 290, 100, 290, 180, 220, 180],
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            indices: [0, 1, 2, 0, 2, 3],
            weights: [[[3, 1.0]], [[3, 1.0]], [[4, 1.0]], [[4, 1.0]]]
          }
        },
        {
          id: "mouth_open", group: "FaceMouth", displayName: "大张嘴", texture: "layers/mouth_open.png",
          zOrder: 107, parentBone: "head", role: "mouth", side: "center", parallaxX: 0.3, parallaxY: 0.2,
          bbox: [240, 200, 272, 220], pivot: [256, 180], alphaCoverage: 0.5,
          mesh: {
            positions: [240, 200, 272, 200, 272, 220, 240, 220],
            uvs: [0, 0, 1, 0, 1, 1, 0, 1],
            indices: [0, 1, 2, 0, 2, 3],
            weights: [[[3, 1.0]], [[3, 1.0]], [[3, 1.0]], [[3, 1.0]]]
          }
        }
      ],
      physics: [
        { bone: "hair_bang_c", stiffness: 90, damping: 9, gravityScale: 0.6, inertia: 0.45, maxAngleDeg: 11, windPhase: 0.2 }
      ],
      variants: { sui: { id: "sui", textures: {}, profile: {} }, ge: { id: "ge", textures: {}, profile: {} } },
      expressions: { neutral: { browY: 0, eyeOpen: 1, mouthSmile: 0.1 }, happy: { browY: 0.25, eyeOpen: 0.92, mouthSmile: 0.95, blush: 0.3 } },
      motions: { wave: { durationMs: 1200 }, cross_arms: { durationMs: 1200 } }
    };
  }

  const ctrl = new Rig2DController(modelData);

  // 1. Continuous lip-sync & boolean compatibility
  ctrl.setMouth(0.85);
  for (let i = 0; i < 20; i += 1) ctrl.step(0.016);
  assert(ctrl.mouthLevel > 0.7, `expected continuous mouth level > 0.7, got ${ctrl.mouthLevel}`);
  const mouthOpenIdx = ctrl.layers.findIndex(l => l.id === "mouth_open");
  if (mouthOpenIdx >= 0) {
    assert(ctrl.layerStates[mouthOpenIdx].alpha > 0.5, "mouth_open layer must become visible at high RMS");
  }
  ctrl.setMouth(false);
  for (let i = 0; i < 30; i += 1) ctrl.step(0.016);
  assert(ctrl.mouthLevel < 0.05, "setMouth(false) must close mouth smoothly");

  // 2. Sui <-> Ge smooth persona crossfade
  assert(ctrl.geBlend < 0.05, "starts in sui persona");
  ctrl.setPersona("ge");
  for (let i = 0; i < 45; i += 1) ctrl.step(0.016);
  assert(ctrl.geBlend > 0.9, `expected geBlend > 0.9 after transition, got ${ctrl.geBlend}`);

  // 3. Emotion + Motion + Physics produce finite non-NaN mesh vertices
  ctrl.setEmotion("happy", 1.0);
  ctrl.triggerMotion("wave");
  for (let i = 0; i < 40; i += 1) ctrl.step(0.016);
  for (const ls of ctrl.layerStates) {
    for (let i = 0; i < ls.positions.length; i += 1) {
      assert(Number.isFinite(ls.positions[i]), `NaN vertex detected in layer ${ls.id}`);
    }
  }
  assert.equal(ctrl.snapshot().emotion, "happy");
}

function testAvatarRegistrySafety() {
  assert.equal(safeAvatarModelPath(LEGACY_CUBISM_PATH), LEGACY_CUBISM_PATH);
  assert.equal(safeAvatarModelPath("/avatars/../etc/passwd"), null, "path traversal must be rejected");
  assert.equal(safeAvatarModelPath("/avatars/does-not-exist/model.rig2d.json"), null);

  const list = listAvailableAvatars();
  assert(list.some(item => item.modelPath === LEGACY_CUBISM_PATH), "legacy Cubism fallback must always remain listed");

  const resolved = resolveActiveAvatar({});
  assert(typeof resolved === "string" && resolved.length > 0);
}

async function main() {
  testAvatarRegistrySafety();
  await testRig2DControllerMath();
  console.log("Rig2D avatar system tests passed: kinematics, continuous lip-sync, Sui/Ge crossfade, physics, and registry safety.");
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
