const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "data", "behavior-principles.json");

function retrieveBehaviorLessons(text, { limit = 3, filePath = DEFAULT_PATH } = {}) {
  let principles = [];
  try { principles = JSON.parse(fs.readFileSync(filePath, "utf8")).principles || []; } catch { return []; }
  const source = String(text || "").toLowerCase();
  return principles.map(item => ({
    ...item,
    score: (item.keywords || []).reduce((sum, keyword) => sum + (source.includes(String(keyword).toLowerCase()) ? 1 : 0), 0) * Number(item.weight || 1)
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.weight - a.weight).slice(0, limit);
}

module.exports = { retrieveBehaviorLessons, DEFAULT_PATH };
