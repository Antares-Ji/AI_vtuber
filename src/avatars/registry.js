const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const AVATARS_DIR = path.join(PUBLIC_DIR, "avatars");
const LEGACY_CUBISM_PATH = "/live2d-web/miku-web.model3.json";

function safeAvatarModelPath(modelPath) {
  const clean = String(modelPath || "").split(/[?#]/)[0].trim();
  if (!clean) return null;
  if (clean === LEGACY_CUBISM_PATH) return LEGACY_CUBISM_PATH;
  const match = clean.match(/^\/avatars\/([a-zA-Z0-9_-]+)\/model\.rig2d\.json$/);
  if (!match) return null;
  const diskPath = path.join(AVATARS_DIR, match[1], "model.rig2d.json");
  if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) return null;
  return `/avatars/${match[1]}/model.rig2d.json`;
}

function listAvailableAvatars() {
  const items = [];
  if (fs.existsSync(AVATARS_DIR) && fs.statSync(AVATARS_DIR).isDirectory()) {
    const entries = fs.readdirSync(AVATARS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."));

    for (const entry of entries) {
      const modelFile = path.join(AVATARS_DIR, entry.name, "model.rig2d.json");
      if (!fs.existsSync(modelFile)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(modelFile, "utf8"));
        const psdPath = parsed.psdFile ? path.join(AVATARS_DIR, entry.name, parsed.psdFile) : null;
        const previewPath = parsed.previewImage ? path.join(AVATARS_DIR, entry.name, parsed.previewImage) : null;
        items.push({
          id: parsed.id || entry.name,
          name: parsed.name || entry.name,
          renderer: "rig2d-pixi8",
          schemaVersion: parsed.schemaVersion || "rig2d-v1",
          modelPath: `/avatars/${entry.name}/model.rig2d.json`,
          previewUrl: previewPath && fs.existsSync(previewPath) ? `/avatars/${entry.name}/${parsed.previewImage}` : null,
          psdUrl: psdPath && fs.existsSync(psdPath) ? `/avatars/${entry.name}/${parsed.psdFile}` : null,
          draft: parsed.draft !== false,
          provider: parsed.provider || "unknown",
          createdAt: parsed.createdAt || null,
          variants: Object.keys(parsed.variants || {}),
          motions: Object.keys(parsed.motions || {}),
          layerCount: Array.isArray(parsed.layers) ? parsed.layers.length : 0,
          boneCount: Array.isArray(parsed.bones) ? parsed.bones.length : 0,
          qaPassed: parsed.qa?.passed !== false,
          license: parsed.draft ? "original-draft" : "original-approved"
        });
      } catch {
        // Ignore malformed avatar manifests so one bad draft never breaks the stage.
      }
    }
  }

  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  items.push({
    id: "miku-cubism-legacy",
    name: "初音占位模型（Cubism 5 回退）",
    renderer: "live2d-local-preview",
    schemaVersion: "cubism5",
    modelPath: LEGACY_CUBISM_PATH,
    previewUrl: null,
    psdUrl: null,
    draft: false,
    provider: "cubism-moc3",
    createdAt: null,
    variants: [],
    motions: [],
    layerCount: 0,
    boneCount: 0,
    qaPassed: true,
    license: "local-preview-only"
  });

  return items;
}

function resolveActiveAvatar(runtimeSettings = {}) {
  const fromSettings = safeAvatarModelPath(runtimeSettings.activeAvatarPath);
  if (fromSettings) return fromSettings;

  if (process.env.LIVE2D_MODEL_PATH) {
    return process.env.LIVE2D_MODEL_PATH;
  }

  const available = listAvailableAvatars();
  const firstRig2d = available.find(item => item.renderer === "rig2d-pixi8");
  if (firstRig2d) return firstRig2d.modelPath;

  return LEGACY_CUBISM_PATH;
}

function describeAvatarPath(modelPath) {
  const all = listAvailableAvatars();
  const matched = all.find(item => item.modelPath === modelPath);
  if (matched) return matched;
  const isRig2d = String(modelPath || "").endsWith(".rig2d.json");
  return {
    id: isRig2d ? "custom-rig2d" : "custom-cubism",
    name: path.basename(String(modelPath || LEGACY_CUBISM_PATH)),
    renderer: isRig2d ? "rig2d-pixi8" : "live2d-local-preview",
    modelPath: modelPath || LEGACY_CUBISM_PATH,
    license: isRig2d ? "original-draft" : "local-preview-only"
  };
}

module.exports = {
  AVATARS_DIR,
  LEGACY_CUBISM_PATH,
  safeAvatarModelPath,
  listAvailableAvatars,
  resolveActiveAvatar,
  describeAvatarPath
};
