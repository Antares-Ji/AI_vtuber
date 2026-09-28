const fs = require("fs");
const path = require("path");
const { redactPersonalValues } = require("./redaction");

class BrainStateStore {
  constructor(filePath = path.join(__dirname, "..", "..", "runtime", "brain-state.json")) {
    this.filePath = filePath;
  }

  load() {
    if (!this.filePath) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  save(state) {
    if (!this.filePath) return sanitizeValue(state);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const safeState = sanitizeValue(state);
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(safeState, null, 2), "utf8");
    fs.renameSync(temporary, this.filePath);
    return safeState;
  }
}

function sanitizeValue(value) {
  if (typeof value === "string") return redactPersonalValues(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return value;
}

module.exports = { BrainStateStore };
