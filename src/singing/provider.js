const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_CATALOG_PATH = path.join(ROOT, "data", "singing-catalog.json");

function getSingingStatus({ catalogPath = DEFAULT_CATALOG_PATH } = {}) {
  const provider = process.env.SINGING_PROVIDER || "disabled";
  const modelPath = process.env.SINGING_MODEL_PATH || "";
  const localModelReady = Boolean(modelPath && fs.existsSync(modelPath));
  const remoteModelReady = Boolean(process.env.SINGING_BASE_URL);
  const modelReady = localModelReady || remoteModelReady;
  const voiceAuthorized = Boolean(process.env.SINGING_VOICE_AUTHORIZATION_REFERENCE);
  const catalog = readCatalog(catalogPath);
  const authorizedTracks = catalog.tracks.filter(track => validateTrackAuthorization(track).ok);
  const engineConfigured = provider !== "disabled" && Boolean(process.env.SINGING_BASE_URL || modelReady);
  const assetsReady = engineConfigured && modelReady && voiceAuthorized && authorizedTracks.length > 0;
  // Configured assets are not an executable singing pipeline by themselves.
  const renderAdapterReady = false;
  return {
    provider,
    engineConfigured,
    modelReady,
    localModelReady,
    remoteModelReady,
    voiceAuthorized,
    modelPath: modelPath || null,
    catalogPath,
    authorizedTrackCount: authorizedTracks.length,
    assetsReady,
    renderAdapterReady,
    ready: assetsReady && renderAdapterReady,
    recommendedArchitecture: "singing-synthesis-provider (DiffSinger/authorized commercial engine) + score/MIDI + licensed voice model",
    speechTtsSeparate: true,
    blockers: [
      ...(!engineConfigured ? ["未配置歌声合成引擎"] : []),
      ...(!modelReady ? ["未找到合法可用的歌声模型"] : []),
      ...(!voiceAuthorized ? ["未登记歌声音色模型授权依据"] : []),
      ...(!authorizedTracks.length ? ["授权曲目清单为空"] : []),
      ...(!renderAdapterReady ? ["尚未实现歌声渲染与统一音频队列适配器"] : [])
    ]
  };
}

function readCatalog(filePath = DEFAULT_CATALOG_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { schemaVersion: parsed.schemaVersion || 1, tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [] };
  } catch {
    return { schemaVersion: 1, tracks: [] };
  }
}

function validateTrackAuthorization(track = {}, now = Date.now()) {
  const rights = track.rights || {};
  const required = ["composition", "lyrics", "arrangement", "performanceOutput"];
  const missing = required.filter(key => rights[key] !== true);
  const expired = track.expiresAt ? Date.parse(track.expiresAt) < now : false;
  const hasProof = Boolean(track.authorizationReference);
  return { ok: Boolean(track.id && track.title && !missing.length && !expired && hasProof), missing, expired, hasProof };
}

module.exports = { DEFAULT_CATALOG_PATH, getSingingStatus, readCatalog, validateTrackAuthorization };
