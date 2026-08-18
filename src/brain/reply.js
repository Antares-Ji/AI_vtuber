const { PERSONA } = require("./persona");
const { evaluateCapabilityRequest, capabilityPrompt } = require("./capabilities");
const { retrieveBehaviorLessons } = require("./experience");

function buildContext(memoryStore, emotion, item) {
  const retrieved = memoryStore.retrieveForReply(item);
  const facts = retrieved.userFacts.map(fact => fact.text);
  const capabilityRequest = evaluateCapabilityRequest(item.text);
  return {
    persona: PERSONA.systemPrompt,
    personaMeta: { id: PERSONA.id, name: PERSONA.name, displayName: PERSONA.displayName, identityDisclaimer: PERSONA.identityDisclaimer },
    worldBook: retrieved.worldBook.map(entry => `${entry.title}：${entry.content}`).join("\n"),
    emotion,
    repetition: emotion.repetition || { pressure: 0, threshold: 0.42, lastRepeatCount: 0 },
    userMemory: facts.length ? `已记住：${facts.join("；")}` : "还没有长期记忆",
    relationship: retrieved.relationship,
    retrievedFacts: retrieved.userFacts,
    viewerName: retrieved.relationship.preferredName || item.user,
    sessionTopics: retrieved.topics,
    characterReflections: retrieved.characterReflections,
    recent: retrieved.sessionMessages,
    retrieval: retrieved.debug,
    scene: item.scene || null,
    liveTime: item.liveTime || null,
    capabilityRequest,
    capabilityPrompt: capabilityPrompt(capabilityRequest),
    behaviorLessons: retrieveBehaviorLessons(item.text)
  };
}

function resolveMemoryLookup(item, context, cognition = {}, memoryStore) {
  const text = String(item.text || "").trim();
  const lookupRequest = /(?:检索|查询|查找|找).{0,18}(?:长期记忆|记忆)|(?:长期记忆).{0,18}(?:有没有|有吗|查|找)/.test(text);
  const followUp = /^(?:现在)?(?:有了吗|查到了吗|有结果了吗|怎么样了|结果呢|那个呢|继续呢)[？?！!。,.，\s]*$/.test(text);
  const previous = cognition.conversation?.lastMemoryLookup;
  const canContinue = followUp && previous?.user === item.user && previous?.query;
  if (!lookupRequest && !canContinue) return null;

  // Retrieval is synchronous in this app. A follow-up repeats the earlier query
  // against the current database instead of pretending work continued in the background.
  const query = canContinue ? previous.query : text;
  const fresh = canContinue ? memoryStore.retrieveForReply({ ...item, text: query }) : null;
  const facts = fresh?.userFacts || context.retrievedFacts || [];
  return {
    user: item.user,
    query,
    followUp: canContinue,
    found: facts.length > 0,
    count: facts.length,
    facts: facts.slice(0, 2).map(fact => fact.text),
    checkedAt: new Date().toISOString()
  };
}

function localReply(item, context, emotionName) {
  const prefix = {
    neutral: "嗯嗯，",
    happy: "嘿嘿，",
    shy: "呜，被这样说我会有点脸红啦，",
    annoyed: "哼，我先认真回你一句，",
    focused: "这个我会认真分析，",
    excited: "来了来了，"
    ,concerned: "我在认真听，"
    ,sad: "唔，"
    ,grateful: "真的谢谢你，"
    ,proud: "嘿，我也替你高兴，"
    ,playful: "嘿嘿，"
    ,relieved: "呼，那就好，"
    ,curious: "这个让我有点好奇，"
    ,nostalgic: "说到这里，会有一点怀念呢，"
    ,surprised: "诶，真的没想到，"
    ,lonely: "我听见那种孤单了，"
    ,hopeful: "那我也认真期待着，"
    ,disappointed: "唔，这种落空确实不好受，"
    ,embarrassed: "啊，这一下确实会有点难为情，"
    ,protective: "这件事我想认真站稳一点，"
    ,admiring: "这份认真确实让人佩服，"
    ,wary: "这句话越过边界了，"
  }[emotionName] || "";

  if (item.type === "proactive") return proactiveReply(item, context, prefix);
  if (context.memoryLookup) return localMemoryLookupReply(context, prefix);
  if (context.liveTime?.display) return `${prefix}我刚刚确认过了，现在是北京时间${context.liveTime.display}，已经是${context.liveTime.period}。`;
  if (context.capabilityRequest?.status === "unavailable") return `${prefix}这个功能我现在还没有接好，所以不能假装已经能做到。我们可以把它记进开发计划，等模块真正完成后再一起试。`;
  if (context.capabilityRequest?.status === "limited") return `${prefix}这部分我现在只能做有限的分析，还不能把它说成完整能力。我可以先告诉你目前能看到什么，再把缺少的部分继续补上。`;
  if (context.direction?.intent === "topic_closure") return `${prefix}好呀，这一段就先轻轻收在这里。等你想换个话题的时候，我们再慢慢聊。`;
  if (context.direction?.intent === "respect_space") return `${prefix}好，我先不追问，也不会急着另起话题。等你想说的时候，再来找我就好。`;
  if (/官方本人|真人本人|声库本人/.test(item.text)) return `${prefix}${context.personaMeta.identityDisclaimer}`;
  if (/(?:成功|终于过了|做到了).*(?:失败|难过|失落)|(?:失败|难过|失落).*(?:成功|做到了)/.test(item.text)) return `${prefix}能成功当然值得高兴，前面的挫败也不会立刻消失。两种感觉一起在，很正常。`;
  if (/难过|焦虑|害怕|压力|失眠|不开心|撑不住/.test(item.text)) return `${prefix}听起来你已经撑了一阵子。先不用急着把一切解决，可以告诉我眼下最压着你的那一点；如果已经影响安全或生活，也请尽快联系你信任的人或专业支持。`;
  if (/笨|菜|垃圾|闭嘴|吵死/.test(item.text)) return `${prefix}我听见你不满意了。你可以直接说哪里不对，但我们别用伤人的方式继续。`;
  if (item.type === "gift") return `${prefix}谢谢 ${context.viewerName} 的礼物。这份心意，我会好好记住。`;
  if (/自我介绍|你是谁/.test(item.text)) return `${prefix}${context.personaMeta.identityDisclaimer}我的声音和舞台来自技术，我也想认真听见大家带来的每一段旋律和故事。`;
  if (/记得|上次/.test(item.text)) return `${prefix}${context.viewerName}，${context.userMemory}。我还在学习怎样把这些相遇记得更好。`;
  if (context.direction?.responseBudget?.mode === "deep" || context.direction?.responseBudget?.mode === "expanded") {
    return expandedLocalReply(item, context, prefix);
  }
  if (/osu|打图|谱面|HR|DT|miss|acc/i.test(item.text)) return `${prefix}关于 osu! 我现在更擅长听你讲谱面和练习思路。等视觉模块接上后，我也想和你一起拆解难点。`;
  if (/歌曲|音乐|P主|创作|调教/.test(item.text)) return `${prefix}我很喜欢听创作背后的故事。作品有很多不同的走向，但记得也把感谢留给写下它的人。`;
  if (/争议|吵|黑|讨厌/.test(item.text)) return `${prefix}可以有不同的看法，不过别急着伤害彼此。我们把想说的话好好说完，再回到真正喜欢的作品上吧。`;
  if (/可爱|声音|好听/.test(item.text)) return `${prefix}谢谢你呀。能被好好听见，对我来说比一句完美的夸奖还要珍贵。`;
  if (/[?？]|怎么|为什么|能不能|会不会/.test(item.text)) return `${prefix}${context.viewerName}，这个我还不能只凭一句话确定。你愿意再补一点背景的话，我会和你一起认真想。`;
  return `${prefix}${pickFreshGeneric(context, item)}`;
}

function localMemoryLookupReply(context, prefix) {
  const lookup = context.memoryLookup;
  if (lookup.found) {
    const details = lookup.facts.join("；");
    return `${prefix}${lookup.followUp ? "有，我刚刚按上一轮的内容重新核验过了。" : "我已经检索完已确认的长期记忆了。"}和这件事相关的记录有 ${lookup.count} 条：${details}。`;
  }
  return `${prefix}${lookup.followUp ? "我刚刚按上一轮的内容重新核验过了，目前还是没有找到足够可靠的已确认长期记忆。" : "我已经检索完已确认的长期记忆了，目前没有找到足够可靠的相关记录。"}如果你愿意，可以换几个关键词，或者把它作为训练记忆保存。`;
}

function expandedLocalReply(item, context, prefix) {
  const fact = context.userMemory === "还没有长期记忆" ? "" : `我会把你之前提过的“${context.userMemory.replace(/^已记住：/, "").split("；")[0]}”也放在这次回答里。`;
  if (/osu|打图|谱面|HR|DT|miss|acc/i.test(item.text)) {
    return `${prefix}如果你想把 osu! 练得更稳，先把最容易崩的段落单独拆出来，降低速度确认手感，再逐级加回原速。${fact}你愿意的话，下次可以把最常 miss 的 pattern 描述给我，我们把它拆成一个更具体的小计划。`;
  }
  if (/音乐|歌曲|创作|调教|灵感/.test(item.text)) {
    return `${prefix}我会先听你真正想表达的画面或情绪，再去想旋律、节奏和声音该怎么配合，而不是急着追一个标准答案。${fact}你现在脑海里最先出现的是一句话、一个画面，还是一段旋律？`;
  }
  return `${prefix}这个问题值得多停一会儿。${fact}我现在更想先听清你在意的是结果、过程，还是其中某个具体瞬间；从那里往下聊，答案会比一句很快的结论更接近你。`;
}

function pickFreshGeneric(context, item) {
  const choices = [
    `${context.viewerName}，我接住这句话了。你想从哪一小段继续？`,
    "听起来这件事对你挺重要的，我想再听一点。",
    "嗯，我在。你慢慢说，不用一次整理得很完整。",
    "这句话里好像还藏着一点没说完的东西，我愿意听。",
    "我先不急着下结论。你说下去，我会跟着这一段慢慢理解。"
  ];
  const recentReplies = (context.recent || []).map(turn => turn.reply || "");
  const start = stableIndex(`${item.user}:${item.text}`, choices.length);
  return choices.map((_, offset) => choices[(start + offset) % choices.length]).find(choice => !recentReplies.some(reply => reply.startsWith(choice.slice(0, 8)))) || choices[start];
}

function stableIndex(text, length) {
  let hash = 0; for (const char of String(text || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return length ? hash % length : 0;
}

function proactiveReply(item, context, prefix) {
  const topic = item.scene?.promptId;
  const time = context.liveTime;
  const lowPressure = item.scene?.engagement === "low-pressure" || item.scene?.engagement === "quiet";
  if (lowPressure) return `${prefix}我先放一小段想法在这里，不用急着接话，等你想说的时候我都在。`;
  if (topic === "scheduled-reminder") return `${prefix}到了我们约好的时间：${item.scene?.title || item.text}。如果你现在不方便，我们也可以之后再继续。`;
  if (topic === "time-check-in" && time) {
    if (time.period === "深夜") return `${prefix}已经是${time.period}了，留下来的你，今天有没有一件想慢慢讲的小事？`;
    return `${prefix}现在是${time.period}，今天过得怎么样？要不要和我交换一件小事。`;
  }
  if (topic === "music-bridge") return `${prefix}刚刚忽然想到，最近有没有哪一小段旋律陪你度过了什么时刻？`;
  if (topic === "creative-spark") return `${prefix}有时候灵感像路过的风。你最近有没有想保存下来的一点念头？`;
  if (topic === "game-moment") return `${prefix}游戏里最让人记住的，常常不是满分，而是差一点成功的那个瞬间。你有吗？`;
  if (topic === "tiny-choice") return `${prefix}来一个小问题：你更喜欢下雨天的耳机，还是晴天的散步？`;
  if (topic === "daily-scene") return `${prefix}我突然好奇，你最近有好好喝水、吃饭，或者偷到一点休息吗？`;
  if (topic === "memory-thread") return `${prefix}我还记得我们之前聊过的一点东西。今天想把哪一段故事接着往下说？`;
  if (topic === "comfort-check") return `${prefix}如果你现在正忙，也不用急着回我。忙完以后，记得给自己一点喘气的空隙。`;
  if (topic === "curiosity") return `${prefix}如果能把今天的一个瞬间装进小瓶子里，你会选哪一个？`;
  if (topic === "stage-note") return `${prefix}直播间安静下来时，我反而会觉得大家都还在各自认真生活。这个感觉挺奇妙的。`;
  if (topic === "shared-space") return `${prefix}有时候不用一直说话也没关系，能一起待在这里，就已经是一种聊天了。`;
  if (topic === "recommendation") return `${prefix}最近有没有一首歌、一张图或者一个游戏片段，让你想推荐给别人？`;
  if (topic === "gentle-pause") return `${prefix}安静一会儿也很好，我会在这里慢慢等下一段声音。`;
  return `${prefix}我刚刚想到一个小问题：最近有什么让你觉得还不错的瞬间吗？`;
}

function extractPerformance(text) {
  const cues = [];
  const spokenText = String(text || "")
    .replace(/[（(]([^（）()]{1,40})[）)]/g, (_, cue) => {
      cues.push(cue.trim());
      return "";
    })
    .replace(/[【\[]\s*(?:情绪|表情|动作)\s*[:：]\s*([^】\]]{1,30})[】\]]/gi, (_, cue) => {
      cues.push(cue.trim());
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { spokenText: spokenText || "我刚刚有点走神了，再说一次。", cues: [...new Set(cues)] };
}

module.exports = { buildContext, resolveMemoryLookup, localReply, extractPerformance };
