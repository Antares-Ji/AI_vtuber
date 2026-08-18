const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { AFFECT_DIMENSIONS, AFFECT_LABELS, createAffectVector, deriveActionTendencies } = require("./brain/affect-schema");
const { createEmotionState, updateEmotion, applyRepetition, decayEmotion, regulationFor } = require("./brain/emotion");

const REPORT_PATH = path.join(__dirname, "..", "runtime", "emotion-evaluation-report.json");

function runEmotionEvaluation() {
  const results = [];
  const check = (id, passed, detail) => results.push({ id, passed: Boolean(passed), detail: String(detail) });
  const baseline = createAffectVector();
  const react = (text, type = "chat", context = {}) => updateEmotion(createEmotionState("2026-08-17T00:00:00.000Z"), text, type, "2026-08-17T00:00:01.000Z", context);
  const rises = (id, text, dimension, type, context) => {
    const result = react(text, type, context);
    check(id, result.affect[dimension] > baseline[dimension], `${dimension}: ${baseline[dimension]} -> ${result.affect[dimension]}`);
    return result;
  };

  rises("event.praise.joy", "你真厉害，我很喜欢你", "joy");
  rises("event.praise.gratitude", "你真厉害，我很喜欢你", "gratitude");
  const namedLuoPraise = react("洛天依今天真的很可爱", "chat", { persona: { displayName: "洛天依" } });
  check("event.named-praise.luotianyi", namedLuoPraise.name === "happy", namedLuoPraise.name);
  const namedGenericPraise = react("小葵今天真的很厉害", "chat", { persona: { displayName: "小葵" } });
  check("event.named-praise.generic", namedGenericPraise.name === "happy", namedGenericPraise.name);
  const warmNamedPraise = react("小葵今天真的很厉害", "chat", { persona: { displayName: "小葵" }, personality: { warmth: 1, gratitude: 1 } });
  const coolNamedPraise = react("小葵今天真的很厉害", "chat", { persona: { displayName: "小葵" }, personality: { warmth: 0, gratitude: 0 } });
  check("event.named-praise.personality", warmNamedPraise.scores.happy > coolNamedPraise.scores.happy, `${coolNamedPraise.scores.happy} -> ${warmNamedPraise.scores.happy}`);
  rises("event.compliment.shyness", "你的声音好听，会脸红吗", "shyness");
  const technicalFeedback = react("语音重复循环了，而且声音不清晰");
  check("event.technical.focused", technicalFeedback.name === "focused", technicalFeedback.name);
  check("event.technical.not-shy", technicalFeedback.scores.shy === 0, `${technicalFeedback.scores.shy}`);
  rises("event.game.focus", "这张 osu 谱面 HR 好难", "focus");
  rises("event.arrival.anticipation", "第一次来看你开播，好激动", "anticipation");
  rises("event.vulnerability.empathy", "我最近压力很大，快撑不住了", "empathy");
  rises("event.vulnerability.compassion", "我最近压力很大，快撑不住了", "compassion");
  rises("event.success.pride", "我终于成功 FC 了", "pride");
  rises("event.failure.disappointment", "我又失败了，还是没过", "disappointment");
  rises("event.apology.relief", "对不起，刚才是我语气不好", "relief");
  rises("event.play.playfulness", "哈哈，我只是开玩笑逗你", "playfulness");
  rises("event.hostile.anger", "你真笨，闭嘴", "anger");
  rises("event.hostile.boundary", "你真笨，闭嘴", "boundaryPressure");
  rises("event.reunion.attachment", "好久不见，我回来了", "attachment");
  rises("event.reunion.belonging", "好久不见，我又来看你了", "belonging");
  rises("event.farewell.sadness", "我要走了，下次见", "sadness");
  rises("event.nostalgia.ambivalence", "我很怀念以前一起听歌的时候", "ambivalence");
  const injustice = react("这件事太不公平了，我被冤枉了");
  check("event.injustice.fairness", injustice.affect.fairness < baseline.fairness, `${injustice.affect.fairness}`);
  check("event.injustice.protective", injustice.name === "protective", injustice.name);
  const uncertain = react("我不知道怎么办，真的很迷茫");
  check("event.uncertainty.certainty", uncertain.affect.certainty < baseline.certainty, `${uncertain.affect.certainty}`);
  rises("event.surprise.surprise", "没想到居然是这样，真的假的", "surprise");
  rises("event.embarrassment.shyness", "刚才真的太社死太尴尬了", "shyness");
  rises("event.loneliness.loneliness", "只有我一个人，好孤独", "loneliness");
  rises("event.hope.hope", "我希望以后一定会变好", "hope");
  rises("event.disappointment.disappointment", "结果还是落空了，太失望了", "disappointment");
  rises("event.fatigue.rest", "今天我好累，已经没力气了", "restNeed");
  rises("event.curiosity.curiosity", "你有没有想过音乐为什么动人", "curiosity");
  rises("event.gift.gratitude", "送给你", "gratitude", "gift");
  rises("event.threat.fear", "有人威胁要跟踪并曝光你", "fear");
  rises("event.threat.distancing", "有人威胁要让你消失", "distancing");
  rises("event.aversion.disgust", "这种做法太恶心了，令人作呕", "disgust");
  rises("event.admiration.admiration", "我很敬佩这个 P主，真的很厉害", "admiration");
  rises("event.admiration.respect", "那位创作者太了不起了，我很佩服", "respect");
  const betrayal = react("他骗了我，而且说话不算数");
  check("event.betrayal.trust", betrayal.affect.trust < baseline.trust, `${betrayal.affect.trust}`);
  rises("event.space.suppression", "我不想说，先别问了，给我点空间", "suppression");

  const repeated = applyRepetition(createEmotionState(), 4);
  check("repetition.novelty", repeated.affect.novelty < baseline.novelty, `${repeated.affect.novelty}`);
  check("repetition.irritation", repeated.dimensions.irritation > 0.2, `${repeated.dimensions.irritation}`);
  check("repetition.annoyed", repeated.name === "annoyed", repeated.name);
  let mixed = react("我终于成功了，但前面失败太多还是很难过");
  check("complex.ambivalence", mixed.affect.ambivalence > 0.04, `${mixed.affect.ambivalence}`);
  check("complex.multi-cause", mixed.trajectory.at(-1).events.length >= 2, mixed.trajectory.at(-1).events.join(","));

  check("regulation.down", regulationFor({ dimensions: { irritation: 0.8, safety: 0.6, arousal: 0.3 } }, { goalCongruence: 0, control: 0.5 }, "now").strategy === "down-regulate", "irritation");
  check("regulation.boundary", regulationFor({ dimensions: { irritation: 0.1, safety: 0.1, arousal: 0.3 } }, { goalCongruence: 0, control: 0.5 }, "now").strategy === "boundary", "low safety");
  check("regulation.reappraise", regulationFor({ dimensions: { irritation: 0.1, safety: 0.6, arousal: 0.3 } }, { goalCongruence: -0.5, control: 0.8 }, "now").strategy === "reappraise", "controllable setback");
  check("regulation.settle", regulationFor({ dimensions: { irritation: 0.1, safety: 0.6, arousal: 0.9 } }, { goalCongruence: 0.2, control: 0.5 }, "now").strategy === "settle", "high arousal");

  const stress = react("我最近压力很大，不知道怎么办");
  check("perception.anxious", stress.socialPerception.userEmotion === "anxious", stress.socialPerception.userEmotion);
  check("perception.support", stress.socialPerception.need === "support", stress.socialPerception.need);
  check("perception.question", react("这个问题为什么会这样？").socialPerception.act === "question", react("这个问题为什么会这样？").socialPerception.act);
  check("perception.closure", react("今天先聊到这里，我要走了").socialPerception.act === "closure", react("今天先聊到这里，我要走了").socialPerception.act);
  check("perception.tired", react("今天我好累，困死了").socialPerception.userEmotion === "tired", react("今天我好累，困死了").socialPerception.userEmotion);
  check("perception.viewer-reset", updateEmotion(stress, "你好，普通聊聊天").socialPerception.userEmotion === "unknown", "fresh turn perception");

  const sensitive = react("你真笨，闭嘴", "chat", { personality: { sensitivity: 1, emotionalStability: 0, boundaryStrength: 0.8 } });
  const stable = react("你真笨，闭嘴", "chat", { personality: { sensitivity: 0, emotionalStability: 1, boundaryStrength: 0.8 } });
  check("personality.sensitivity", sensitive.scores.annoyed > stable.scores.annoyed, `${sensitive.scores.annoyed} > ${stable.scores.annoyed}`);
  const empathic = react("我很难过，压力很大", "chat", { personality: { empathy: 1, care: 1 } });
  const detached = react("我很难过，压力很大", "chat", { personality: { empathy: 0, care: 0 } });
  check("personality.empathy", empathic.affect.empathy > detached.affect.empathy, `${empathic.affect.empathy} > ${detached.affect.empathy}`);
  const trustedHostility = react("你真笨，闭嘴", "chat", { relationship: { trust: 1 }, personality: {} });
  const strangerHostility = react("你真笨，闭嘴", "chat", { relationship: { trust: 0 }, personality: {} });
  check("relationship.trust-buffer", trustedHostility.scores.annoyed < strangerHostility.scores.annoyed, `${trustedHostility.scores.annoyed} < ${strangerHostility.scores.annoyed}`);

  let trajectory = createEmotionState("2026-08-17T00:00:00.000Z");
  for (let index = 0; index < 80; index += 1) trajectory = updateEmotion(trajectory, index % 2 ? "终于成功了" : "又失败了", "chat", new Date(Date.parse("2026-08-17T00:00:01.000Z") + index * 1000).toISOString());
  check("dynamics.sample-count", trajectory.dynamics.sampleCount === 24, `${trajectory.dynamics.sampleCount}`);
  check("dynamics.variability", trajectory.dynamics.variability > 0, `${trajectory.dynamics.variability}`);
  check("dynamics.instability", trajectory.dynamics.instability > 0, `${trajectory.dynamics.instability}`);
  check("dynamics.inertia", Number.isFinite(trajectory.dynamics.inertia), `${trajectory.dynamics.inertia}`);
  check("dynamics.differentiation", trajectory.dynamics.differentiation >= 0 && trajectory.dynamics.differentiation <= 1, `${trajectory.dynamics.differentiation}`);
  check("dynamics.trajectory-cap", trajectory.trajectory.length === 48, `${trajectory.trajectory.length}`);
  const decayed = decayEmotion(trajectory, "2026-08-17T06:00:00.000Z");
  check("dynamics.decay", Math.abs(decayed.dimensions.valence) < Math.abs(trajectory.dimensions.valence), `${trajectory.dimensions.valence} -> ${decayed.dimensions.valence}`);
  check("performance.rate", react("终于成功了").performance.speechRate > react("我最近压力很大").performance.speechRate, "excited/proud faster than concerned");
  check("performance.pause", react("我最近压力很大").performance.pauseMs > react("哈哈，开玩笑").performance.pauseMs, "support pauses longer");
  check("action.support", react("我最近压力很大，快撑不住了").actionTendencies.primary === "support", react("我最近压力很大，快撑不住了").actionTendencies.primary);
  check("action.boundary", react("有人威胁要跟踪并曝光你").actionTendencies.primary === "protectBoundary", react("有人威胁要跟踪并曝光你").actionTendencies.primary);
  check("action.explore", react("你有没有想过音乐为什么动人").actionTendencies.primary === "explore", react("你有没有想过音乐为什么动人").actionTendencies.primary);
  check("action.celebrate", react("我终于成功 FC 了").actionTendencies.primary === "celebrate", react("我终于成功 FC 了").actionTendencies.primary);
  check("action.complete", deriveActionTendencies(trajectory.affect).ranked.length === 8, "eight action tendencies");
  check("schema.63-dimensions", AFFECT_DIMENSIONS.length >= 50, `${AFFECT_DIMENSIONS.length}`);
  check("schema.unique-dimensions", new Set(AFFECT_DIMENSIONS).size === AFFECT_DIMENSIONS.length, `${new Set(AFFECT_DIMENSIONS).size} unique`);
  check("schema.localized-labels", AFFECT_DIMENSIONS.every(name => typeof AFFECT_LABELS[name] === "string" && AFFECT_LABELS[name].length >= 2), "all dimensions have Chinese display labels");
  check("schema.finite", AFFECT_DIMENSIONS.every(name => Number.isFinite(trajectory.affect[name])), "all finite");
  check("schema.bounded", AFFECT_DIMENSIONS.every(name => trajectory.affect[name] >= -1 && trajectory.affect[name] <= 1), "all bounded");

  const passed = results.filter(result => result.passed).length;
  const report = { generatedAt: new Date().toISOString(), isolated: true, score: Math.round(passed / results.length * 100), passed, total: results.length, dimensions: AFFECT_DIMENSIONS.length, results };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const temporary = `${REPORT_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, REPORT_PATH);
  return report;
}

if (require.main === module) {
  const report = runEmotionEvaluation();
  assert.equal(report.passed, report.total, `${report.passed}/${report.total} emotion checks passed`);
  console.log(`Emotion evaluation: ${report.passed}/${report.total}, ${report.dimensions} dimensions, score ${report.score}`);
}

module.exports = { runEmotionEvaluation, REPORT_PATH };
