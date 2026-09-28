const $ = selector => document.querySelector(selector);

function metricCard(label, metric, suffix = "ms") {
  if (!metric?.samples) return `<div class="metric"><b>暂无样本</b><small>${label}</small></div>`;
  return `<div class="metric"><b>${metric.p50}${suffix}</b><small>${label} · P95 ${metric.p95}${suffix} · ${metric.samples}次</small></div>`;
}

async function loadRuntimeHealth() {
  try {
    const [healthResponse, modulesResponse] = await Promise.all([fetch("/api/health"), fetch("/api/modules")]);
    if (!healthResponse.ok || !modulesResponse.ok) throw new Error("运行指标接口不可用");
    const health = await healthResponse.json();
    const modulePayload = await modulesResponse.json();
    const latency = health.latency || {};
    $("#runtimeMetrics").innerHTML = [
      metricCard("本地 LLM 首 Token", latency.llm_ttft_local),
      metricCard("云端 LLM 首 Token", latency.llm_ttft_cloud),
      metricCard("GPT-SoVITS 首字节", latency.tts_first_byte || latency.tts),
      metricCard("ASR 完整识别", latency.asr_total || latency.asr),
      metricCard("流式回答完成", latency.reply_stream_total),
      metricCard("客户端语音排队", latency.client_tts_queue_wait),
      metricCard("客户端首 PCM", latency.client_tts_first_pcm),
      metricCard("客户端播放完成", latency.client_tts_playback_end),
      metricCard("用户打断确认", latency.client_barge_in_abort)
    ].join("");
    const modules = modulePayload.modules || {};
    $("#moduleStatus").innerHTML = Object.values(modules).map(module => `<div class="module ${module.ready ? "" : "off"}"><b>${module.ready ? "已就绪" : "未就绪"}</b><small>${module.role} · ${module.node}</small></div>`).join("");
    $("#runtimeNote").textContent = `服务已运行 ${health.uptimeSeconds}s；这里显示本次进程的 P50/P95，刷新页面即可更新。`;
  } catch (error) {
    $("#runtimeNote").textContent = error.message;
  }
}

$("#run").addEventListener("click", async () => {
  $("#run").disabled = true; $("#status").textContent = " 正在分别测试…";
  try {
    const response = await fetch("/api/diagnostics/compare-brains", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: $("#prompt").value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "测试失败");
    const direct = result.directDeepSeek, dual = result.dualLayer;
    $("#directMetrics").textContent = `首 Token ${direct.firstTokenMs} ms · 完成 ${direct.totalMs} ms · ${direct.model}`;
    $("#directReply").textContent = direct.text;
    $("#dualMetrics").textContent = `可感知响应 ${dual.acknowledgementMs ?? dual.firstTokenMs} ms · 首 Token ${dual.firstTokenMs} ms · 完成 ${dual.totalMs} ms · ${dual.route}/${dual.model}`;
    $("#preface").textContent = dual.preface ? `等待话术：${dual.preface}` : "本地直接回答，无等待话术";
    $("#dualReply").textContent = dual.text;
    $("#status").textContent = " 测试完成";
    await loadRuntimeHealth();
  } catch (error) { $("#status").textContent = ` ${error.message}`; }
  finally { $("#run").disabled = false; }
});

void loadRuntimeHealth();
