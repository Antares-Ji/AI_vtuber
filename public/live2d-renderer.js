import { Rig2DPixiStage } from "./rig2d-engine.js";

const emotionExpressions = {
  shy: "脸红", happy: "比心", excited: "比心", focused: "前倾", annoyed: "QQ人",
  concerned: "前倾", sad: "圈圈", grateful: "比心", proud: "比心", playful: "QQ人", relieved: "脸红",
  curious: "前倾", nostalgic: "脸红", surprised: "QQ人", lonely: "圈圈", hopeful: "比心",
  disappointed: "圈圈", embarrassed: "脸红", protective: "前倾", admiring: "比心", wary: "前倾",
  neutral: null
};

let pixiApp = null;
let stageContainer = null;
let cubismModel = null;
let rig2dStage = null;
let activeBackend = null; // "rig2d" | "cubism5"
let activeModelPath = null;
let modelOffset = { x: 0, y: 0 };
let modelBaseSize = null;
let currentEmotion = { name: "neutral", intensity: 1 };
let currentPersonaId = "sui";
let mouseFollowEnabled = false;
let dragInitialized = false;
let resizeBound = false;
let tickerBound = false;

function isRig2DPath(modelPath) {
  return String(modelPath || "").split(/[?#]/)[0].endsWith(".rig2d.json");
}

function fitModel() {
  if (!pixiApp) return;
  const { width, height } = pixiApp.screen;

  if (activeBackend === "rig2d" && rig2dStage) {
    const baseWidth = Math.max(1, rig2dStage.baseWidth);
    const baseHeight = Math.max(1, rig2dStage.baseHeight);
    const scale = Math.min(width / baseWidth, height / baseHeight) * 0.86;
    rig2dStage.container.scale.set(scale);
    const scaledW = baseWidth * scale;
    const scaledH = baseHeight * scale;
    const cx = Math.min(width - 40, Math.max(40, width / 2 + modelOffset.x));
    const bottomY = Math.min(height - 10, Math.max(height * 0.45, height * 0.96 + modelOffset.y));
    rig2dStage.container.x = cx - scaledW * 0.5;
    rig2dStage.container.y = bottomY - scaledH;
    return;
  }

  if (activeBackend === "cubism5" && cubismModel) {
    const baseWidth = Math.max(1, Number(modelBaseSize?.width || cubismModel.width));
    const baseHeight = Math.max(1, Number(modelBaseSize?.height || cubismModel.height));
    const scale = Math.min(width / baseWidth, height / baseHeight) * 0.78;
    cubismModel.scale.set(scale);
    cubismModel.x = Math.min(width - 40, Math.max(40, width / 2 + modelOffset.x));
    cubismModel.y = Math.min(height - 20, Math.max(height * 0.35, height * 0.94 + modelOffset.y));
    cubismModel.anchor.set(0.5, 1);
  }
}

async function ensurePixiApp(container) {
  if (pixiApp) return pixiApp;
  stageContainer = container;
  pixiApp = new window.PIXI.Application();
  await pixiApp.init({
    resizeTo: container,
    preference: "webgl",
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  });
  container.append(pixiApp.canvas);

  if (!tickerBound) {
    tickerBound = true;
    pixiApp.ticker.add(ticker => {
      if (activeBackend === "rig2d" && rig2dStage) {
        rig2dStage.update(ticker.deltaMS / 1000);
      }
    });
  }
  if (!dragInitialized) {
    dragInitialized = true;
    enableModelDrag(pixiApp.canvas);
  }
  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener("resize", fitModel);
  }
  return pixiApp;
}

function clearActiveModel() {
  if (rig2dStage) {
    pixiApp?.stage.removeChild(rig2dStage.container);
    rig2dStage.destroy();
    rig2dStage = null;
  }
  if (cubismModel) {
    pixiApp?.stage.removeChild(cubismModel);
    try { cubismModel.destroy(); } catch {}
    cubismModel = null;
  }
  activeBackend = null;
  modelBaseSize = null;
}

async function mountModel(modelPath) {
  const pathStr = String(modelPath || "");
  if (!pathStr) throw new Error("未提供有效的模型路径");

  if (isRig2DPath(pathStr)) {
    const cacheBustUrl = pathStr.includes("?") ? `${pathStr}&t=${Date.now()}` : `${pathStr}?t=${Date.now()}`;
    const response = await fetch(cacheBustUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`无法加载 Rig2D 模型 (${response.status})`);
    const modelData = await response.json();
    const nextStage = new Rig2DPixiStage(window.PIXI, modelData, pathStr);
    await nextStage.loadTextures();

    clearActiveModel();
    rig2dStage = nextStage;
    activeBackend = "rig2d";
    activeModelPath = pathStr;
    pixiApp.stage.addChild(rig2dStage.container);

    rig2dStage.controller.setPersona(currentPersonaId);
    rig2dStage.controller.setEmotion(currentEmotion.name, currentEmotion.intensity);
    rig2dStage.controller.setMouseFollow(mouseFollowEnabled);
    fitModel();
    return rig2dStage;
  }

  // Legacy Cubism 5 (.model3.json / .moc3) fallback path preserved cleanly
  const engine = window.PIXI?.live2d;
  if (!engine?.Live2DModel || !engine?.Live2DPlugin) throw new Error("Cubism 5 运行库未准备好");
  if (!window.__cubism5PluginAdded) {
    window.PIXI.extensions.add(engine.Live2DPlugin);
    window.__cubism5PluginAdded = true;
  }
  const nextCubism = await engine.Live2DModel.from(pathStr, {
    // This model uses 4096px texture atlases. HTML image sources are more
    // compatible than ImageBitmap sources with the Live2D WebGL upload path.
    textureOptions: { lod: false, preferCreateImageBitmap: false }
  });
  clearActiveModel();
  cubismModel = nextCubism;
  activeBackend = "cubism5";
  activeModelPath = pathStr;
  pixiApp.stage.addChild(cubismModel);
  modelBaseSize = { width: cubismModel.width, height: cubismModel.height };
  try { await cubismModel.expression("watermark-off"); } catch {}
  fitModel();
  return cubismModel;
}

export async function startLive2D({ container, modelPath, personaId = "sui" }) {
  currentPersonaId = personaId || currentPersonaId;
  await ensurePixiApp(container);
  const instance = await mountModel(modelPath);
  if (typeof window !== "undefined") {
    window.__rig2dDebug = () => getLive2DState();
  }
  return instance;
}

export async function switchLive2DModel(modelPath) {
  if (!modelPath || modelPath === activeModelPath) return activeModelPath;
  if (!pixiApp && stageContainer) await ensurePixiApp(stageContainer);
  if (!pixiApp) return null;
  await mountModel(modelPath);
  return activeModelPath;
}

function enableModelDrag(canvas) {
  let drag = null;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", event => {
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (activeBackend === "rig2d" && rig2dStage) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        rig2dStage.controller.setPointer(nx, ny);
      }
    }
    if (!drag || !pixiApp) return;
    modelOffset.x += event.clientX - drag.x;
    modelOffset.y += event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    fitModel();
  });
  const stop = event => {
    if (!drag) return;
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
}

export function setLive2DEmotion(emotion, intensity = 1) {
  currentEmotion = { name: emotion || "neutral", intensity };
  if (activeBackend === "rig2d" && rig2dStage) {
    rig2dStage.controller.setEmotion(currentEmotion.name, intensity);
    return;
  }
  const expression = emotionExpressions[emotion] || null;
  if (!cubismModel?.internalModel?.coreModel) return;
  const coreModel = cubismModel.internalModel.coreModel;
  ["Param125", "Param130", "Param132", "Param131", "Param136", "Param133", "Param134", "Param135"]
    .forEach(id => coreModel.setParameterValueById(id, 0));
  const parameters = {
    "脸红": ["Param130"],
    "比心": ["Param135"],
    "前倾": ["Param132"],
    "QQ人": ["Param131", "Param136"],
    "圈圈": ["Param125"]
  }[expression] || [];
  parameters.forEach(id => coreModel.setParameterValueById(id, Math.min(1, Math.max(0.25, intensity))));
}

export function setLive2DMouth(openOrLevel) {
  if (activeBackend === "rig2d" && rig2dStage) {
    rig2dStage.controller.setMouth(openOrLevel);
    return;
  }
  if (!cubismModel?.internalModel?.coreModel) return;
  const val = typeof openOrLevel === "number"
    ? Math.min(1, Math.max(0.08, 0.08 + openOrLevel * 0.84))
    : (openOrLevel ? 0.72 : 0.08);
  cubismModel.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", val);
}

export function setLive2DPersona(personaId) {
  if (!personaId) return;
  currentPersonaId = personaId;
  if (activeBackend === "rig2d" && rig2dStage) {
    rig2dStage.controller.setPersona(personaId);
  }
}

export function triggerLive2DMotion(motionName) {
  if (activeBackend === "rig2d" && rig2dStage) {
    rig2dStage.controller.triggerMotion(motionName);
  }
}

export function setLive2DMouseFollow(enabled) {
  mouseFollowEnabled = Boolean(enabled);
  if (activeBackend === "rig2d" && rig2dStage) {
    rig2dStage.controller.setMouseFollow(mouseFollowEnabled);
  }
}

export function getLive2DState() {
  return {
    backend: activeBackend,
    modelPath: activeModelPath,
    personaId: currentPersonaId,
    emotion: currentEmotion,
    mouseFollow: mouseFollowEnabled,
    rig2d: rig2dStage ? rig2dStage.controller.snapshot() : null
  };
}
