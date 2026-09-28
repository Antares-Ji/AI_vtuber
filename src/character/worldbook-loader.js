const fs = require("fs");
const path = require("path");

function loadWorldBookText(filePath, fallback = []) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const entries = source
      .split(/^---\s*$/m)
      .map(parseEntry)
      .filter(Boolean);
    return entries.length ? entries : fallback;
  } catch {
    return fallback;
  }
}

function parseEntry(block) {
  const fields = {};
  for (const rawLine of String(block).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    fields[key] = line.slice(separator + 1).trim();
  }
  if (!fields.key || !fields.title || !fields.content) return null;
  return {
    key: fields.key,
    canon: fields.canon || "project",
    title: fields.title,
    keywords: String(fields.keywords || "").split(/[，,]/).map(value => value.trim()).filter(Boolean),
    content: fields.content
  };
}

function defaultLuotianyiWorldBookPath() {
  return path.join(__dirname, "..", "..", "data", "luotianyi-worldbook.txt");
}

module.exports = { loadWorldBookText, parseEntry, defaultLuotianyiWorldBookPath };
