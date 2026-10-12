const { EMOTIONS, createEmotionState, updateEmotion, applyRepetition, applySocialPerception, previewEmotion } = require("./brain/emotion");
const { MemoryStore, redactSensitiveText } = require("./brain/memory");
const { buildContext, resolveMemoryLookup, localReply, extractPerformance } = require("./brain/reply");
const { PERSONA } = require("./brain/persona");
const { JISUI_PERSONAS } = require("./character/jisui");
const { PersonaRuntime } = require("./runtime/persona-runtime");
const { createLlmStatus, callExternalLlm } = require("./brain/llm");
const { classifyComplexity, callLocalLlm } = require("./brain/local-llm");
const { directReply } = require("./brain/director");
const { getLiveTime, needsLiveTime } = require("./brain/time");
const { CHAT_COMPANION, createSceneState, chooseProactive, recordHumanActivity, recordProactive, setChatEnabled, setInteractionHold, clearInteractionHold, suspendIfIgnored } = require("./brain/scenes");
const { conversationKey, createCognitionState, observeTurn, shouldReflect, createReflection, afterReflection, advanceNeeds } = require("./brain/cognition");
const { StoryStore } = require("./story/store");
const { BrainStateStore } = require("./runtime/brain-state");
const { applyReplyPolicy } = require("./brain/policy");
const { createPersonalityProfile, deriveExpressedPersonality } = require("./brain/personality-schema");
const { BRAIN_THRESHOLDS } = require("./brain/thresholds");

class StreamerBrain {
  constructor({ memoryOptions, llmEnabled = true, storyOptions, runtimeOptions, dualPersonas = false } = {}) {
    this.dualPersonas = dualPersonas;
    this.persona = dualPersonas ? JISUI_PERSONAS.sui : PERSONA;
    this.personaStates = {};
    this.personaRuntime = new PersonaRuntime(dualPersonas ? JISUI_PERSONAS : { [PERSONA.id]: PERSONA }, this.persona.id);
    this.memoryStore = new MemoryStore(memoryOptions);
    this.shortTerm = this.memoryStore.shortTerm;
    this.memory = this.memoryStore.data;
    this.emotion = createEmotionState();
    this.llmStatus = createLlmStatus();
    this.personality = createPersonalityProfile(this.persona);
    this.personalityExpression = deriveExpressedPersonality(this.personality);
    this.lastMemoryRetrieval = null;
    this.lastDirection = null;
    this.sceneState = createSceneState();
    this.lastTimeCheck = null;
    this.cognition = createCognitionState(this.persona);
    this.lastSpeech = null;
    this.userGenerations = new Map();
    this.llmEnabled = llmEnabled;
    this.storyStore = new StoryStore(storyOptions?.filePath);
    const runtimePath = runtimeOptions?.filePath === undefined ? (memoryOptions?.databasePath ? null : undefined) : runtimeOptions.filePath;
    this.runtimeStore = new BrainStateStore(runtimePath);
    this.restoreRuntime();
  }

  restoreRuntime() {
    const saved = this.runtimeStore.load();
    if (!saved) return false;
    if (this.dualPersonas) {
      this.personaStates = saved.personaStates || {};
      const id = Object.hasOwn(JISUI_PERSONAS, saved.activePersonaId) ? saved.activePersonaId : "sui";
      this.persona = JISUI_PERSONAS[id];
      this.personaRuntime.activeId = id;
      this.loadPersonaState(id);
      if (saved.sceneState?.sceneId) this.sceneState = mergeState(createSceneState(), saved.sceneState);
      this.sceneState.nextProactiveAt = Math.max(this.sceneState.nextProactiveAt || 0, createSceneState().nextProactiveAt);
      return true;
    }
    if (saved.emotion?.dimensions && saved.emotion?.scores) this.emotion = mergeState(createEmotionState(), saved.emotion);
    if (saved.cognition?.activePlan) this.cognition = mergeState(createCognitionState(this.persona), saved.cognition);
    if (saved.sceneState?.sceneId) {
      const freshScene = createSceneState();
      this.sceneState = mergeState(freshScene, saved.sceneState);
      // A stale timer must not make the character speak while the page and microphone are booting.
      this.sceneState.nextProactiveAt = Math.max(Number(saved.sceneState.nextProactiveAt || 0), freshScene.nextProactiveAt);
    }
    if (saved.lastSpeech?.text) this.lastSpeech = saved.lastSpeech;
    return true;
  }

  personaStatus() {
    return { ...this.personaRuntime.snapshot(), enabled: this.dualPersonas,
      personas: Object.values(this.personaRuntime.personas).map(({ id, displayName }) => ({ id, displayName })) };
  }

  savePersonaState() {
    this.personaStates[this.persona.id] = { emotion: this.emotion, cognition: this.cognition };
  }

  loadPersonaState(id) {
    const saved = this.personaStates[id] || {};
    this.emotion = mergeState(createEmotionState(), saved.emotion || {});
    this.cognition = mergeState(createCognitionState(this.persona), saved.cognition || {});
    this.personality = createPersonalityProfile(this.persona);
    this.personalityExpression = deriveExpressedPersonality(this.personality);
    this.lastMemoryRetrieval = null;
    this.lastDirection = null;
    this.lastSpeech = null;
  }

  switchPersona(id) {
    if (!this.dualPersonas) throw new RangeError("Dual personas are not enabled");
    this.personaRuntime.validate(id);
    if (id === this.persona.id) return this.personaStatus();
    this.savePersonaState();
    this.personaRuntime.switchTo(id);
    this.persona = JISUI_PERSONAS[id];
    this.loadPersonaState(id);
    this.persistRuntime();
    return this.personaStatus();
  }

  interruptTurn(reason = "interrupted") {
    this.personaRuntime.invalidate(reason);
    this.lastSpeech = null;
    this.persistRuntime();
    return this.personaStatus();
  }

  persistRuntime() {
    if (this.dualPersonas) {
      this.savePersonaState();
      return this.runtimeStore.save({ activePersonaId: this.persona.id, personaStates: this.personaStates, sceneState: this.sceneState });
    }
    return this.runtimeStore.save({ emotion: this.emotion, cognition: this.cognition, sceneState: this.sceneState, lastSpeech: this.lastSpeech });
  }

  scoreDanmaku(item) {
    const typeScore = { superchat: 100, gift: 80, guard: 70, chat: 30 }[item.type] || 20;
    const relationship = this.memoryStore.getRelationship(item.user);
    const knownUser = Math.round(relationship.familiarity * 12) + (relationship.level === "regular" ? 3 : relationship.level === "old_friend" ? 6 : 0);
    const question = /[?？吗呢]|怎么|为什么|会不会|能不能/.test(item.text) ? 14 : 0;
    const repetitionPenalty = Math.min(36, Number(item.repeatCount || 0) * 12) + Math.min(16, relationship.repeatStrikes * 4);
    return typeScore + knownUser + question - repetitionPenalty;
  }

  pickDanmaku(queue, { preferFresh = false } = {}) {
    if (!queue.length) return null;
    if (preferFresh && queue.length >= 3) {
      const newestFirst = [...queue].sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
      const urgent = newestFirst.find(item => ["superchat", "gift", "guard"].includes(item.type));
      return urgent || newestFirst[0];
    }
    return [...queue].sort((a, b) => this.scoreDanmaku(b) - this.scoreDanmaku(a))[0];
  }

  updateEmotion(text, type = "chat", context = {}) {
    this.emotion = updateEmotion(this.emotion, text, type, new Date().toISOString(), { ...context, personality: this.personality.dimensions, persona: this.persona });
    return this.emotion;
  }

  visibleEmotion(now = new Date().toISOString()) {
    return previewEmotion(this.emotion, now);
  }

  remember(item, reply) {
    this.memoryStore.remember(item, reply, { emotion: this.emotion, direction: this.lastDirection });
    this.shortTerm = this.memoryStore.shortTerm;
    this.memory = this.memoryStore.data;
  }

  buildContext(item) {
    item = { ...item, sessionId: item.sessionId || this.memoryStore.ensureActiveSession() };
    const context = buildContext(this.memoryStore, this.emotion, item, this.persona, this.dualPersonas);
    context.personality = this.personality;
    this.personalityExpression = deriveExpressedPersonality(this.personality, this.emotion, context.relationship);
    context.personalityExpression = this.personalityExpression;
    context.cognition = {
      activePlan: this.cognition.lastConversationKey === conversationKey(item) ? this.cognition.activePlan : createCognitionState(this.persona).activePlan,
      openLoops: (this.cognition.openLoops || []).filter(loop => loop.user === item.user && loop.conversationKey === conversationKey(item)),
      metacognition: this.cognition.lastConversationKey === conversationKey(item) ? this.cognition.metacognition : createCognitionState(this.persona).metacognition,
      needs: this.cognition.needs,
      selfModel: this.cognition.selfModel,
      goals: this.cognition.goals,
      conversation: this.cognition.conversations?.[conversationKey(item)]?.conversation || createCognitionState(this.persona).conversation
    };
    context.memoryLookup = resolveMemoryLookup(item, context, context.cognition, this.memoryStore);
    context.story = this.storyStore.promptContext();
    return context;
  }

  maybeInitiate(now = Date.now()) {
    this.sceneState = suspendIfIgnored(this.sceneState, now);
    this.cognition.needs = advanceNeeds(this.cognition.needs, now);
    const due = this.storyStore.dueItems(now)[0];
    if (due && this.sceneState.chatEnabled && !this.sceneState.chatSuspended && now >= (this.sceneState.interactionHoldUntil || 0)) {
      const scheduledPrompt = { id: "scheduled-reminder", text: due.prompt, engagement: "gentle", selectionReason: "用户确认的计划已到时间" };
      this.sceneState = recordProactive(this.sceneState, scheduledPrompt, now);
      this.persistRuntime();
      const liveTime = getLiveTime(new Date(now));
      this.lastTimeCheck = liveTime;
      return {
        user: "你", text: due.prompt, type: "proactive", timestamp: new Date(now).toISOString(), scheduleId: due.id,
        scene: { id: CHAT_COMPANION.id, name: CHAT_COMPANION.name, promptId: scheduledPrompt.id, title: due.title, instruction: due.prompt, engagement: "gentle", selectionReason: scheduledPrompt.selectionReason },
        liveTime
      };
    }
    const lastTurn = this.shortTerm[this.shortTerm.length - 1];
    const prompt = chooseProactive(this.sceneState, now, {
      topics: this.memoryStore.getRecentTopics(4),
      hasMemory: Boolean(lastTurn?.user && this.memoryStore.getUserFacts(lastTurn.user).length),
      needs: this.cognition.needs
    });
    if (!prompt) return null;
    this.sceneState = recordProactive(this.sceneState, prompt, now);
    this.persistRuntime();
    const liveTime = prompt.timeSensitive ? getLiveTime(new Date(now)) : null;
    if (liveTime) this.lastTimeCheck = liveTime;
    return {
      user: "你",
      text: prompt.text,
      type: "proactive",
      timestamp: new Date(now).toISOString(),
      scene: { id: CHAT_COMPANION.id, name: CHAT_COMPANION.name, promptId: prompt.id, instruction: prompt.text, engagement: prompt.engagement, selectionReason: prompt.selectionReason },
      liveTime
    };
  }

  setInteractionHold(durationMs) {
    this.sceneState = setInteractionHold(this.sceneState, durationMs);
    this.persistRuntime();
    return this.sceneState;
  }

  clearInteractionHold() {
    this.sceneState = clearInteractionHold(this.sceneState);
    this.persistRuntime();
    return this.sceneState;
  }

  // Shared preparation keeps streaming and non-streaming replies on the same
  // persona, memory, emotion, and director state. Do not commit this prepared
  // turn after a cancelled stream.
  prepareStreamReply(item) {
    const { signal, ...delivery } = this.personaRuntime.beginTurn();
    item = { ...item, personaId: this.persona.id, delivery };
    item = { ...item, sessionId: this.memoryStore.ensureActiveSession(), userGeneration: this.userGenerations.get(item.user) || 0 };
    if (item.type !== "proactive") {
      this.sceneState = recordHumanActivity(this.sceneState);
      if (isStopChatRequest(item.text)) this.sceneState = setChatEnabled(this.sceneState, false);
      else if (isSpaceRequest(item.text)) this.sceneState = setInteractionHold(this.sceneState, 180_000);
    }
    if (!item.liveTime && needsLiveTime(item.text)) {
      item = { ...item, liveTime: getLiveTime() };
      this.lastTimeCheck = item.liveTime;
    }
    this.updateEmotion(item.text, item.type, { relationship: this.memoryStore.getRelationship(item.user) });
    this.emotion = applyRepetition(this.emotion, Number(item.repeatCount || 0));
    const context = this.buildContext(item);
    this.lastMemoryRetrieval = context.retrieval;
    const direction = directReply(item, this.emotion, context.relationship, context);
    this.lastDirection = direction;
    context.direction = direction;
    context.disableExternalLlm = !this.llmEnabled;
    context.taskSignal = signal;
    context.fallbackText = this.localReply(item, context);
    return { item, context, direction };
  }

  commitStreamReply(item, context, rawText) {
    this.assertTurnCurrent(item);
    const direction = context.direction || this.lastDirection;
    const policy = applyReplyPolicy(rawText, { item, capabilityRequest: context.capabilityRequest, maxCharacters: direction?.responseBudget?.maxCharacters || 180, persona: this.persona, memoryRetrieval: context.retrieval });
    const performance = extractPerformance(policy.text);
    if (item.type !== "proactive") this.remember(item, performance.spokenText);
    context.responseText = performance.spokenText;
    const persistedItem = { ...item, text: redactSensitiveText(item.text) };
    this.cognition = observeTurn(this.cognition, persistedItem, direction, this.emotion, context.sessionTopics || [], context);
    if (shouldReflect(this.cognition)) {
      this.memoryStore.recordCharacterReflection(createReflection(this.cognition, this.memoryStore));
      this.cognition = afterReflection(this.cognition);
      this.memory = this.memoryStore.data;
    }
    const result = {
      text: performance.spokenText,
      delivery: item.delivery,
      rawText,
      performance: { cues: performance.cues, emotion: this.emotion.name, repetition: this.emotion.repetition, profile: this.emotion.performance, causes: this.emotion.causes.slice(-3) },
      emotion: this.emotion,
      direction,
      memory: this.memory.users[item.user],
      memoryRetrieval: context.retrieval,
      cognition: this.cognition,
      persona: { id: this.persona.id, name: this.persona.name, displayName: this.persona.displayName },
      llm: this.llmStatus,
      policy
    };
    this.lastSpeech = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      delivery: item.delivery,
      persona: result.persona,
      item: { user: item.user, type: item.type, text: persistedItem.text },
      text: result.text,
      emotion: result.emotion,
      performance: result.performance
    };
    if (item.scheduleId) {
      this.storyStore.markScheduleDone(item.scheduleId);
      this.storyStore.addBeat({ title: "完成一次约定提醒", detail: String(item.scene?.title || item.text).slice(0, 300), importance: 0.7 });
    }
    this.persistRuntime();
    return result;
  }

  async reply(item) {
    const prepared = this.prepareStreamReply(item);
    item = prepared.item;
    const context = prepared.context;
    const direction = prepared.direction;
    const emotion = this.emotion;
    const routing = classifyComplexity(item);
    let external;
    if (routing.route === "local") {
      external = await callLocalLlm(item, context);
      if (!external.text) {
        external = await callExternalLlm(item, context);
        external.status = { ...external.status, route: "cloud-fallback", routeReason: routing.reason };
      }
    } else {
      external = await callExternalLlm(item, context);
      external.status = { ...external.status, route: "cloud", routeReason: routing.reason };
    }
    this.assertTurnCurrent(item);
    this.llmStatus = external.status;
    if (external.socialPerception) this.emotion = applySocialPerception(this.emotion, external.socialPerception);
    if (external.liveTime) this.lastTimeCheck = external.liveTime;
    const repeatedDraft = external.text && isNearDuplicateReply(external.text, context.recent);
    const rawText = external.text && !repeatedDraft ? external.text : this.localReply(item, context);
    if (repeatedDraft) this.llmStatus = { ...this.llmStatus, lastMode: "fallback-quality", lastError: "External draft repeated a recent reply" };
    const policy = applyReplyPolicy(rawText, { item, capabilityRequest: context.capabilityRequest, maxCharacters: direction.responseBudget?.maxCharacters || 180, persona: this.persona, memoryRetrieval: context.retrieval });
    const performance = extractPerformance(policy.text);
    const performanceCues = [...new Set([...(external.performanceCues || []), ...performance.cues])];
    if (item.type !== "proactive") this.remember(item, performance.spokenText);
    context.responseText = performance.spokenText;
    const persistedItem = { ...item, text: redactSensitiveText(item.text) };
    this.cognition = observeTurn(this.cognition, persistedItem, direction, this.emotion, context.sessionTopics || [], context);
    if (shouldReflect(this.cognition)) {
      this.memoryStore.recordCharacterReflection(createReflection(this.cognition, this.memoryStore));
      this.cognition = afterReflection(this.cognition);
      this.memory = this.memoryStore.data;
    }
    const result = {
      text: performance.spokenText,
      delivery: item.delivery,
      rawText,
      performance: { cues: performanceCues, emotion: this.emotion.name, repetition: this.emotion.repetition, profile: this.emotion.performance, causes: this.emotion.causes.slice(-3) },
      emotion: this.emotion,
      direction,
      memory: this.memory.users[item.user],
      memoryRetrieval: context.retrieval,
      cognition: this.cognition,
      persona: { id: this.persona.id, name: this.persona.name, displayName: this.persona.displayName },
      llm: this.llmStatus
      ,routing
      ,policy
    };
    this.lastSpeech = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      delivery: item.delivery,
      persona: result.persona,
      item: { user: item.user, type: item.type, text: persistedItem.text },
      text: result.text,
      emotion: result.emotion,
      performance: result.performance
    };
    if (item.scheduleId) {
      this.storyStore.markScheduleDone(item.scheduleId);
      this.storyStore.addBeat({ title: "完成一次约定提醒", detail: String(item.scene?.title || item.text).slice(0, 300), importance: 0.7 });
    }
    this.persistRuntime();
    return result;
  }

  assertTurnCurrent(item) {
    if (item.sessionId && item.sessionId !== this.memoryStore.getMeta("active_session_id") || (item.userGeneration || 0) !== (this.userGenerations.get(item.user) || 0)) {
      const error = new Error("Reply context was invalidated"); error.code = "STALE_REPLY"; throw error;
    }
    if (item.delivery && !this.personaRuntime.isCurrent(item.delivery)) {
      throw new DOMException("Persona turn was cancelled", "AbortError");
    }
  }

  forgetUser(user) {
    this.interruptTurn("viewer forgotten");
    this.userGenerations.set(user, (this.userGenerations.get(user) || 0) + 1);
    this.memoryStore.deleteUserMemories(user);
    this.shortTerm = this.memoryStore.shortTerm;
    this.memory = this.memoryStore.data;
    const fresh = createCognitionState(this.persona);
    for (const field of ["openLoops", "completedLoops", "observations", "actionHistory", "capabilityFailures"]) this.cognition[field] = (this.cognition[field] || []).filter(entry => entry.user && entry.user !== user);
    this.cognition.conversations = Object.fromEntries(Object.entries(this.cognition.conversations || {}).filter(([, entry]) => entry.user !== user));
    if (!this.cognition.lastUser || this.cognition.lastUser === user) {
      for (const field of ["conversation", "workspace", "activePlan", "lastDecision", "metacognition"]) this.cognition[field] = fresh[field];
      this.cognition.lastUser = null;
      this.cognition.lastConversationKey = null;
    }
    for (const [id, state] of Object.entries(this.personaStates)) {
      if (id === this.persona.id) continue;
      const cognition = state.cognition;
      if (!cognition) continue;
      const defaults = createCognitionState(this.personaRuntime.personas[id]);
      for (const field of ["openLoops", "completedLoops", "observations", "actionHistory", "capabilityFailures"]) cognition[field] = (cognition[field] || []).filter(entry => entry.user && entry.user !== user);
      cognition.conversations = Object.fromEntries(Object.entries(cognition.conversations || {}).filter(([, entry]) => entry.user !== user));
      if (!cognition.lastUser || cognition.lastUser === user) {
        for (const field of ["conversation", "workspace", "activePlan", "lastDecision", "metacognition"]) cognition[field] = defaults[field];
        cognition.lastUser = null;
        cognition.lastConversationKey = null;
      }
    }
    if (this.lastSpeech?.item?.user === user) this.lastSpeech = null;
    this.lastMemoryRetrieval = null;
    this.lastDirection = null;
    this.persistRuntime();
  }

  localReply(item, context) {
    return localReply(item, context, this.emotion.name);
  }
}

function isStopChatRequest(text) {
  return /(?:停止聊天|停止陪聊|安静一下|先别说|别说了|休息一下|关闭主动聊天)/.test(String(text || ""));
}

function isSpaceRequest(text) {
  return /(?:别问了|不想说|给我点空间|让我静一静|先别打扰)/.test(String(text || ""));
}

function mergeState(defaults, saved) {
  if (Array.isArray(defaults)) return Array.isArray(saved) ? saved : defaults;
  if (!defaults || typeof defaults !== "object") return saved === undefined ? defaults : saved;
  const output = { ...defaults };
  for (const [key, value] of Object.entries(saved || {})) output[key] = key in defaults ? mergeState(defaults[key], value) : value;
  return output;
}

function isNearDuplicateReply(text, recent = []) {
  const candidate = normalizedBigrams(text);
  if (!candidate.size) return false;
  return recent.some(turn => {
    const previous = normalizedBigrams(turn.reply);
    if (!previous.size) return false;
    let shared = 0;
    for (const token of candidate) if (previous.has(token)) shared += 1;
    return shared / new Set([...candidate, ...previous]).size >= BRAIN_THRESHOLDS.output.nearDuplicateJaccard;
  });
}

function normalizedBigrams(text) {
  const source = String(text || "").replace(/[\s\p{P}]/gu, "").toLowerCase();
  const output = new Set();
  for (let index = 0; index < source.length - 1; index += 1) output.add(source.slice(index, index + 2));
  return output;
}

module.exports = { StreamerBrain, EMOTIONS, isNearDuplicateReply };
