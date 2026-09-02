/**
 * training-analyzer.js —— Phase F：基于结构化 observation/session 的训练建议
 *
 * 输入只能是结构化记录（不读原始图）：
 *   { mapTitle, accuracy, misses, maxCombo, score, mods, at }
 *
 * 原则（任务书 §5 Phase F）：
 *  - 只有 accuracy/miss/combo 时，不能武断断言是 aim、读图还是手速问题
 *  - 原因不确定时给"对照实验"建议（同图降速、无 Mod、重复三次取分布）
 *  - 单局只给初步建议；至少三局同谱面数据才能谈趋势
 *  - 每条建议必须有 evidence（具体数值）
 */
const CATEGORIES = Object.freeze(["accuracy", "consistency", "aim", "reading", "speed", "insufficient-data"]);

function clampNumber(value, min, max) {
  // 明确把 null/undefined/空字符串判为缺失：Number(null) 和 Number("") 都会得到 0，
  // 若不拦截会把未知数据误写成 0。缺失值返回 null（不发布）。
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

function normalizeObservation(raw = {}) {
  const normalized = {
    mapTitle: String(raw.mapTitle || "未知谱面").slice(0, 120),
    at: raw.at || null,
    mods: Array.isArray(raw.mods) ? raw.mods.slice(0, 8) : [],
  };
  const accuracy = clampNumber(raw.accuracy, 0, 100);
  const misses = clampNumber(raw.misses, 0, Number.MAX_SAFE_INTEGER);
  const maxCombo = clampNumber(raw.maxCombo, 0, Number.MAX_SAFE_INTEGER);
  const score = clampNumber(raw.score, 0, Number.MAX_SAFE_INTEGER);
  if (accuracy !== null) normalized.accuracy = accuracy;
  if (misses !== null) normalized.misses = misses;
  if (maxCombo !== null) normalized.maxCombo = maxCombo;
  if (score !== null) normalized.score = score;
  return normalized;
}

function suggestion(category, text, evidence, confidence, nextMeasurement) {
  return {
    category,
    text,
    evidence: [...new Set(evidence.filter(Boolean))].slice(0, 4),
    confidence: clampNumber(confidence, 0, 1) ?? 0.5,
    nextMeasurement,
  };
}

/**
 * 分析一组（单局或多局）记录，返回建议列表。
 * @param {Array} observations 结构化记录数组
 * @returns {{suggestions: Array, summary: object}}
 */
function analyzeObservations(observations = []) {
  const items = observations.map(normalizeObservation).filter(item => item.mapTitle);
  if (!items.length) {
    return {
      suggestions: [suggestion("insufficient-data", "还没有可分析的成绩记录。", [], 0.6, "记录一次结算成绩（至少包含 accuracy 与 miss）")],
      summary: { count: 0 },
    };
  }

  const suggestions = [];
  const latest = items[items.length - 1];
  const byMap = groupByMap(items);
  const mapEntries = Object.entries(byMap);

  // ---------- 单局初步建议 ----------
  if (typeof latest.accuracy === "number") {
    if (latest.accuracy < 90) {
      suggestions.push(suggestion(
        "consistency",
        "先降速练习节奏与读图，目标稳定到 95% 以上再逐步提速。",
        [`accuracy=${latest.accuracy.toFixed(2)}`],
        0.8,
        "下一局同谱面降速后记录 accuracy 与 miss"
      ));
    } else if (latest.accuracy < 96) {
      suggestions.push(suggestion(
        "consistency",
        "重点检查偏早或偏晚的击打时机，把不稳定区间拆成小段重复练习。",
        [`accuracy=${latest.accuracy.toFixed(2)}`],
        0.7,
        "记录 miss 的时间点分布，观察是否集中在特定段落"
      ));
    }
  }

  if (typeof latest.misses === "number" && latest.misses >= 5) {
    suggestions.push(suggestion(
      "insufficient-data",
      "miss 较多时先记录 miss 时间点与所在段落；仅凭 miss 数量无法区分是读图、手速还是瞄准问题，不要急着下结论。",
      [`misses=${latest.misses}`],
      0.75,
      "记录每次 miss 的大致时间点/段落，累积后再分类"
    ));
  }

  const hasMods = (latest.mods || []).some(mod => /HR|DT/i.test(mod));
  if (hasMods && typeof latest.accuracy === "number") {
    suggestions.push(suggestion(
      "reading",
      "带 HR/DT 的成绩与无 Mod 对照：确认失误是否由视野或速度变化引起。",
      [`mods=${latest.mods.join("+")}`, `accuracy=${latest.accuracy.toFixed(2)}`],
      0.65,
      "同一谱面无 Mod 打一次，对比 accuracy 与 miss"
    ));
  }

  // ---------- 多局趋势（至少三局同一谱面） ----------
  for (const [mapTitle, group] of mapEntries) {
    if (group.length < 3) continue;
    const accuracies = group.filter(item => typeof item.accuracy === "number").map(item => item.accuracy);
    if (accuracies.length >= 3) {
      const mean = accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length;
      const variance = accuracies.reduce((sum, value) => sum + (value - mean) ** 2, 0) / accuracies.length;
      const firstHalf = accuracies.slice(0, Math.ceil(accuracies.length / 2));
      const secondHalf = accuracies.slice(Math.ceil(accuracies.length / 2));
      const firstMean = firstHalf.reduce((sum, value) => sum + value, 0) / firstHalf.length;
      const secondMean = secondHalf.reduce((sum, value) => sum + value, 0) / secondHalf.length;
      const trend = secondMean - firstMean;
      if (trend >= 1.0) {
        suggestions.push(suggestion(
          "accuracy",
          `同谱面最近 ${accuracies.length} 局 accuracy 呈上升趋势（+${trend.toFixed(2)}），保持当前练习方式。`,
          [`map=${mapTitle}`, `n=${accuracies.length}`, `mean=${mean.toFixed(2)}`, `delta=${trend.toFixed(2)}`],
          0.7,
          "继续记录同谱面成绩，确认趋势稳定"
        ));
      } else if (variance > 2.0) {
        suggestions.push(suggestion(
          "consistency",
          `同谱面 ${accuracies.length} 局成绩波动较大（方差 ${variance.toFixed(2)}），先追求稳定再追求峰值。`,
          [`map=${mapTitle}`, `n=${accuracies.length}`, `variance=${variance.toFixed(2)}`],
          0.7,
          "同谱面再打三局，观察波动是否收敛"
        ));
      }
    }
  }

  if (!suggestions.length) {
    suggestions.push(suggestion(
      "insufficient-data",
      "当前数据还不足以给出稳定建议；先积累同一谱面的多局成绩。",
      [`count=${items.length}`],
      0.5,
      "同谱面无 Mod 重复记录三局（accuracy、miss、combo）"
    ));
  }

  return {
    suggestions,
    summary: {
      count: items.length,
      maps: mapEntries.map(([title, group]) => ({ mapTitle: title, count: group.length })),
      latest: latest,
    },
  };
}

function groupByMap(items) {
  const groups = {};
  for (const item of items) {
    const key = item.mapTitle;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

module.exports = { analyzeObservations, normalizeObservation, CATEGORIES, suggestion };
