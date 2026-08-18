const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "data", "story-state.json");

function defaultState() {
  return {
    currentArc: { title: "第一次形成自己的直播记忆", summary: "在聊天、音乐和游戏陪伴中逐渐形成连续经历。", status: "active" },
    goals: [
      { id: randomUUID(), text: "记住重要的共同经历，并在合适的时候自然延续", status: "active", createdAt: new Date().toISOString() },
      { id: randomUUID(), text: "学习理解 osu! 的画面与训练数据", status: "active", createdAt: new Date().toISOString() }
    ],
    beats: [],
    schedule: [],
    updatedAt: new Date().toISOString()
  };
}

class StoryStore {
  constructor(filePath = DEFAULT_PATH) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.state = this.load();
  }

  load() {
    try { return { ...defaultState(), ...JSON.parse(fs.readFileSync(this.filePath, "utf8")) }; }
    catch { const state = defaultState(); this.save(state); return state; }
  }

  save(state = this.state) {
    state.updatedAt = new Date().toISOString();
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporary, this.filePath);
    this.state = state;
    return this.getState();
  }

  getState() { return JSON.parse(JSON.stringify(this.state)); }

  setArc({ title, summary, status = "active" }) {
    this.state.currentArc = { title: String(title || "未命名篇章").slice(0, 80), summary: String(summary || "").slice(0, 500), status };
    return this.save();
  }

  addGoal(text) {
    const content = String(text || "").trim().slice(0, 300);
    if (!content) throw new Error("goal text is required");
    this.state.goals.push({ id: randomUUID(), text: content, status: "active", createdAt: new Date().toISOString() });
    this.state.goals = this.state.goals.slice(-30);
    return this.save();
  }

  updateGoal(id, status) {
    const goal = this.state.goals.find(item => item.id === id);
    if (!goal) throw new Error("goal not found");
    goal.status = ["active", "completed", "paused"].includes(status) ? status : goal.status;
    goal.updatedAt = new Date().toISOString();
    return this.save();
  }

  addBeat({ title, detail, participants = [], importance = 0.7, at = new Date().toISOString() }) {
    this.state.beats.push({ id: randomUUID(), title: String(title).slice(0, 100), detail: String(detail).slice(0, 800), participants: participants.slice(0, 12), importance: clamp(importance), at });
    this.state.beats = this.state.beats.slice(-100);
    return this.save();
  }

  addSchedule({ title, dueAt, prompt }) {
    const safeTitle = String(title || "").trim().slice(0, 100);
    const parsedDueAt = Date.parse(dueAt);
    if (!safeTitle) throw new Error("schedule title is required");
    if (!Number.isFinite(parsedDueAt)) throw new Error("schedule dueAt is invalid");
    this.state.schedule.push({ id: randomUUID(), title: safeTitle, dueAt: new Date(parsedDueAt).toISOString(), prompt: String(prompt || safeTitle).trim().slice(0, 500), status: "scheduled" });
    const upcoming = this.state.schedule.filter(item => item.status === "scheduled").sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).slice(0, 40);
    const completed = this.state.schedule.filter(item => item.status !== "scheduled").sort((a, b) => Date.parse(b.completedAt || b.dueAt) - Date.parse(a.completedAt || a.dueAt)).slice(0, 10);
    this.state.schedule = [...upcoming, ...completed];
    return this.save();
  }

  dueItems(now = Date.now()) {
    return this.state.schedule.filter(item => item.status === "scheduled" && Date.parse(item.dueAt) <= now);
  }

  markScheduleDone(id) {
    const item = this.state.schedule.find(entry => entry.id === id);
    if (item) { item.status = "completed"; item.completedAt = new Date().toISOString(); this.save(); }
    return this.getState();
  }

  promptContext() {
    const activeGoals = this.state.goals.filter(goal => goal.status === "active").slice(0, 4);
    const recentBeats = this.state.beats.slice(-4);
    const nextSchedule = this.state.schedule.filter(item => item.status === "scheduled").slice(0, 3);
    return { arc: this.state.currentArc, activeGoals, recentBeats, nextSchedule };
  }
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

module.exports = { StoryStore, DEFAULT_PATH };
