const emotionExpressions = {
  shy: "脸红", happy: "比心", excited: "比心", focused: "前倾", annoyed: "QQ人",
  concerned: "前倾", sad: "圈圈", grateful: "比心", proud: "比心", playful: "QQ人", relieved: "脸红",
  curious: "前倾", nostalgic: "脸红", surprised: "QQ人", lonely: "圈圈", hopeful: "比心",
  disappointed: "圈圈", embarrassed: "脸红", protective: "前倾", admiring: "比心", wary: "前倾",
  neutral: null
};
let pixiApp;
let model;
let modelOffset = { x: 0, y: 0 };
let modelBaseSize = null;

function fitModel() {
  if (!model || !pixiApp) return;
  const { width, height } = pixiApp.screen;
  const baseWidth = Math.max(1, Number(modelBaseSize?.width || model.width));
  const baseHeight = Math.max(1, Number(modelBaseSize?.height || model.height));
  const scale = Math.min(width / baseWidth, height / baseHeight) * 0.78;
  model.scale.set(scale);
  model.x = Math.min(width - 40, Math.max(40, width / 2 + modelOffset.x));
  model.y = Math.min(height - 20, Math.max(height * 0.35, height * 0.94 + modelOffset.y));
  model.anchor.set(0.5, 1);
}

export async function startLive2D({ container, modelPath }) {
  const engine = window.PIXI?.live2d;
  if (!engine?.Live2DModel || !engine?.Live2DPlugin) throw new Error("Cubism 5 运行库未准备好");
  window.PIXI.extensions.add(engine.Live2DPlugin);
  pixiApp = new window.PIXI.Application();
  await pixiApp.init({ resizeTo: container, preference: "webgl", backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
  container.append(pixiApp.canvas);
  model = await engine.Live2DModel.from(modelPath, {
    // This model uses 4096px texture atlases. HTML image sources are more
    // compatible than ImageBitmap sources with the Live2D WebGL upload path.
    textureOptions: { lod: false, preferCreateImageBitmap: false }
  });
  pixiApp.stage.addChild(model);
  modelBaseSize = { width: model.width, height: model.height };
  await model.expression("watermark-off");
  fitModel();
  enableModelDrag(pixiApp.canvas);
  window.addEventListener("resize", fitModel);
  return model;
}

function enableModelDrag(canvas) {
  let drag = null;
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", event => {
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag || !model || !pixiApp) return;
    modelOffset.x += event.clientX - drag.x;
    modelOffset.y += event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    const { width, height } = pixiApp.screen;
    model.x = Math.min(width - 40, Math.max(40, width / 2 + modelOffset.x));
    model.y = Math.min(height - 20, Math.max(height * 0.35, height * 0.94 + modelOffset.y));
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
  const expression = emotionExpressions[emotion] || null;
  if (!model?.internalModel?.coreModel) return;
  const coreModel = model.internalModel.coreModel;
  ["Param125", "Param130", "Param132", "Param131", "Param136", "Param133", "Param134", "Param135"].forEach(id => coreModel.setParameterValueById(id, 0));
  const parameters = {
    "脸红": ["Param130"],
    "比心": ["Param135"],
    "前倾": ["Param132"],
    "QQ人": ["Param131", "Param136"]
    ,"圈圈": ["Param125"]
  }[expression] || [];
  parameters.forEach(id => coreModel.setParameterValueById(id, Math.min(1, Math.max(0.25, intensity))));
}

export function setLive2DMouth(open) {
  if (!model?.internalModel?.coreModel) return;
  model.internalModel.coreModel.setParameterValueById("ParamMouthOpenY", open ? 0.72 : 0.08);
}
