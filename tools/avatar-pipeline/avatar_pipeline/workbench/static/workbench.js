import { Rig2DPixiStage } from "/vendor/rig2d-engine.js";

const $ = sel => document.querySelector(sel);
const state = {
  jobs: [],
  currentJobId: null,
  modelData: null,
  overrides: {},
  pixiApp: null,
  stage: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  talkTimer: null,
  draggingBone: null
};

function toast(msg, error = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `show${error ? " error" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = ""; }, 3200);
}

async function api(url, opts = {}) {
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
  return data;
}

async function initPixi() {
  const mount = $("#pixiMount");
  state.pixiApp = new window.PIXI.Application();
  await state.pixiApp.init({
    resizeTo: mount,
    preference: "webgl",
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2)
  });
  mount.append(state.pixiApp.canvas);
  state.pixiApp.ticker.add(ticker => {
    if (state.stage) {
      state.stage.update(ticker.deltaMS / 1000);
      renderBoneOverlay();
    }
  });
  window.addEventListener("resize", fitStage);

  const wrap = $("#stageWrap");
  wrap.addEventListener("pointermove", event => {
    const rect = wrap.getBoundingClientRect();
    if (state.draggingBone) {
      const cx = (event.clientX - rect.left - state.offsetX) / state.scale;
      const cy = (event.clientY - rect.top - state.offsetY) / state.scale;
      state.overrides[state.draggingBone] = { x: Math.round(cx), y: Math.round(cy) };
      $("#saveJointsBtn").disabled = false;
      renderBoneOverlay();
      return;
    }
    if (state.stage) {
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      state.stage.controller.setPointer(nx, ny);
    }
  });
  window.addEventListener("pointerup", () => { state.draggingBone = null; });
}

function fitStage() {
  if (!state.stage || !state.pixiApp) return;
  const { width, height } = state.pixiApp.screen;
  const bw = state.stage.baseWidth;
  const bh = state.stage.baseHeight;
  state.scale = Math.min((width * 0.88) / bw, (height * 0.92) / bh);
  state.offsetX = (width - bw * state.scale) * 0.5;
  state.offsetY = (height - bh * state.scale) * 0.5;
  state.stage.container.scale.set(state.scale);
  state.stage.container.position.set(state.offsetX, state.offsetY);
}

function renderBoneOverlay() {
  const svg = $("#boneOverlay");
  if (!$("#showBonesToggle").checked || !state.stage || !state.modelData) {
    svg.innerHTML = "";
    return;
  }
  const bones = state.modelData.bones;
  const byId = new Map(bones.map(b => [b.id, b]));
  const parts = [];
  for (const b of bones) {
    const ov = state.overrides[b.id];
    const bx = (ov?.x ?? b.x) * state.scale + state.offsetX;
    const by = (ov?.y ?? b.y) * state.scale + state.offsetY;
    if (b.parent && byId.has(b.parent)) {
      const p = byId.get(b.parent);
      const pov = state.overrides[p.id];
      const px = (pov?.x ?? p.x) * state.scale + state.offsetX;
      const py = (pov?.y ?? p.y) * state.scale + state.offsetY;
      parts.push(`<line x1="${px}" y1="${py}" x2="${bx}" y2="${by}" stroke="rgba(120,210,255,0.65)" stroke-width="2" />`);
    }
  }
  for (const b of bones) {
    const ov = state.overrides[b.id];
    const bx = (ov?.x ?? b.x) * state.scale + state.offsetX;
    const by = (ov?.y ?? b.y) * state.scale + state.offsetY;
    const dirty = ov ? "dirty" : "";
    parts.push(`<circle data-bone="${b.id}" class="${dirty}" cx="${bx}" cy="${by}" r="5.5" fill="#4aa8e0" stroke="#08121d" stroke-width="1.5"><title>${b.id} (${Math.round(ov?.x ?? b.x)}, ${Math.round(ov?.y ?? b.y)})</title></circle>`);
  }
  svg.innerHTML = parts.join("");
  svg.querySelectorAll("circle[data-bone]").forEach(node => {
    node.addEventListener("pointerdown", e => {
      e.stopPropagation();
      state.draggingBone = node.dataset.bone;
    });
  });
}

async function loadJob(jobId) {
  state.currentJobId = jobId;
  const info = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  state.overrides = info.overrides || {};
  const modelUrl = `/api/jobs/${encodeURIComponent(jobId)}/model/model.rig2d.json?t=${Date.now()}`;
  const modelData = await (await fetch(modelUrl)).json();
  state.modelData = modelData;

  if (state.stage) {
    state.pixiApp.stage.removeChild(state.stage.container);
    state.stage.destroy();
    state.stage = null;
  }
  const rigStage = new Rig2DPixiStage(window.PIXI, modelData, modelUrl);
  await rigStage.loadTextures();
  rigStage.controller.setMouseFollow($("#mouseFollowToggle").checked);
  state.pixiApp.stage.addChild(rigStage.container);
  state.stage = rigStage;
  fitStage();

  $("#currentModelLabel").textContent = `${modelData.name} (${modelData.id})`;
  $("#publishBtn").disabled = false;
  $("#saveJointsBtn").disabled = Object.keys(state.overrides).length === 0;

  // Populate 22 emotions & 7 motions
  const emoSel = $("#emotionSelect");
  emoSel.innerHTML = Object.keys(modelData.expressions || {}).map(k => `<option value="${k}">${k}</option>`).join("");
  const motionBox = $("#motionButtons");
  motionBox.innerHTML = Object.entries(modelData.motions || {}).map(([k, v]) => `<button type="button" class="secondary small" data-motion="${k}" title="${v.description || k}">${k}</button>`).join("");
  motionBox.querySelectorAll("button[data-motion]").forEach(btn => {
    btn.onclick = () => state.stage?.controller.triggerMotion(btn.dataset.motion);
  });

  // PSD links
  const dl = $("#downloadPsdLink");
  if (modelData.psdFile) {
    dl.href = `/api/jobs/${encodeURIComponent(jobId)}/model/${encodeURIComponent(modelData.psdFile)}`;
    dl.download = `${modelData.id}.psd`;
    dl.hidden = false;
  } else {
    dl.hidden = true;
  }
  $("#uploadPsdLabel").hidden = false;

  // QA summary
  const qa = modelData.qa || info.manifest.stages?.stage5_qa || {};
  $("#qaSummary").textContent = qa.passed
    ? `QA 通过 · ${qa.stats?.layerCount || 0} 图层 · ${qa.stats?.boneCount || 0} 骨骼 · ${qa.stats?.triangleCount || 0} 三角面 · 歌形态贴图 ${qa.stats?.geVariantTextures || 0} 张`
    : `QA 告警 · ${(qa.errors || []).join("；")}`;
  $("#qaJson").textContent = JSON.stringify(qa, null, 2);
  renderJobList();
}

function renderJobList() {
  const box = $("#jobList");
  box.innerHTML = state.jobs.map(j => {
    const qaPassed = j.stages?.stage5_qa?.passed;
    const pub = j.publishedPath ? `已发布 ${j.publishedPath}` : "未发布";
    return `<button type="button" class="job-item ${j.jobId === state.currentJobId ? "active" : ""}" data-job="${j.jobId}">
      <strong>${j.name}</strong>
      <small>${j.provider} · ${qaPassed ? "QA通过" : "待检查"} · ${pub}</small>
      <small>${j.jobId}</small>
    </button>`;
  }).join("") || "<p style='color:#93a3bf;font-size:12px'>暂无任务，可在上方一键创建。</p>";
  box.querySelectorAll(".job-item").forEach(btn => {
    btn.onclick = () => void loadJob(btn.dataset.job);
  });
}

async function refreshJobs(selectFirst = false) {
  const data = await api("/api/jobs");
  state.jobs = data.jobs || [];
  renderJobList();
  if (selectFirst && state.jobs.length && !state.currentJobId) {
    await loadJob(state.jobs[0].jobId);
  }
}

$("#createForm").onsubmit = async event => {
  event.preventDefault();
  const btn = $("#createBtn");
  btn.disabled = true;
  btn.textContent = "生成与绑骨中…";
  try {
    const fd = new FormData(event.target);
    const res = await api("/api/jobs", { method: "POST", body: fd });
    toast(`生成完成：${res.manifest.jobId}`);
    await refreshJobs(false);
    await loadJob(res.manifest.jobId);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "开始生成并自动绑骨";
  }
};

$("#saveJointsBtn").onclick = async () => {
  if (!state.currentJobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.currentJobId)}/overrides`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overrides: state.overrides, publish: false })
    });
    toast("关节点已保存并完成秒级重绑！");
    await loadJob(state.currentJobId);
  } catch (err) {
    toast(err.message, true);
  }
};

$("#publishBtn").onclick = async () => {
  if (!state.currentJobId) return;
  try {
    const res = await api(`/api/jobs/${encodeURIComponent(state.currentJobId)}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    toast(`已发布到 AI_vtuber：${res.publicUrl}`);
    await refreshJobs(false);
  } catch (err) {
    toast(err.message, true);
  }
};

$("#uploadPsdInput").onchange = async event => {
  const file = event.target.files?.[0];
  if (!file || !state.currentJobId) return;
  const fd = new FormData();
  fd.append("psdFile", file);
  fd.append("publish", "false");
  try {
    await api(`/api/jobs/${encodeURIComponent(state.currentJobId)}/repack-psd`, { method: "POST", body: fd });
    toast("已导入编辑后的 PSD 并完成秒级重绑！");
    await loadJob(state.currentJobId);
  } catch (err) {
    toast(err.message, true);
  } finally {
    event.target.value = "";
  }
};

document.querySelectorAll(".persona-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".persona-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.stage?.controller.setPersona(btn.dataset.persona);
  };
});

$("#mouthSlider").oninput = () => {
  const val = Number($("#mouthSlider").value);
  $("#mouthVal").textContent = `开合度：${val.toFixed(2)}`;
  state.stage?.controller.setMouth(val);
};

$("#talkSimBtn").onclick = () => {
  if (state.talkTimer) {
    clearInterval(state.talkTimer);
    state.talkTimer = null;
    $("#talkSimBtn").textContent = "模拟说话口型";
    $("#mouthSlider").value = "0";
    $("#mouthVal").textContent = "开合度：0.00";
    state.stage?.controller.setMouth(0);
    return;
  }
  $("#talkSimBtn").textContent = "停止说话模拟";
  let t = 0;
  state.talkTimer = setInterval(() => {
    t += 0.12;
    const rms = Math.max(0, Math.min(1, 0.42 + Math.sin(t * 2.8) * 0.35 + Math.cos(t * 6.4) * 0.22));
    $("#mouthSlider").value = rms.toFixed(2);
    $("#mouthVal").textContent = `开合度：${rms.toFixed(2)}`;
    state.stage?.controller.setMouth(rms);
  }, 60);
};

$("#emotionSelect").onchange = () => {
  state.stage?.controller.setEmotion($("#emotionSelect").value, Number($("#emotionIntensity").value));
};
$("#emotionIntensity").oninput = () => {
  state.stage?.controller.setEmotion($("#emotionSelect").value, Number($("#emotionIntensity").value));
};
$("#mouseFollowToggle").onchange = () => {
  state.stage?.controller.setMouseFollow($("#mouseFollowToggle").checked);
};

function applyManualHeadAxis() {
  state.stage?.controller.setHeadOverride(
    Number($("#headYawSlider").value),
    Number($("#headPitchSlider").value),
    Number($("#headTiltSlider").value)
  );
}
$("#headYawSlider").oninput = applyManualHeadAxis;
$("#headPitchSlider").oninput = applyManualHeadAxis;
$("#headTiltSlider").oninput = applyManualHeadAxis;
$("#headResetBtn").onclick = () => {
  $("#headYawSlider").value = "0";
  $("#headPitchSlider").value = "0";
  $("#headTiltSlider").value = "0";
  state.stage?.controller.clearHeadOverride();
};
$("#windGustBtn").onclick = () => {
  state.stage?.controller.triggerWindGust(1.4);
};

$("#refreshJobsBtn").onclick = () => void refreshJobs(false);

async function boot() {
  const health = await api("/api/health");
  $("#statusBadge").textContent = health.openaiKeyConfigured
    ? "就绪 · GPT Image API 已配置"
    : "就绪 · 离线夹具模式（填 Key 可启 GPT Image）";
  if (health.openaiKeyConfigured) $("#providerSelect").value = "openai_gpt_image";
  await initPixi();
  await refreshJobs(true);
}

boot().catch(err => toast(err.message, true));
