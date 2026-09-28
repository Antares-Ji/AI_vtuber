const fs = require("fs");
const path = require("path");

class QueueStore {
  constructor({ filePath = path.join(__dirname, "..", "..", "runtime", "danmaku-queue.json") } = {}) {
    this.filePath = filePath;
    this.items = this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.items, null, 2), "utf8");
    fs.renameSync(temporary, this.filePath);
    return this.items;
  }

  push(item) {
    this.items.push(item);
    this.save();
    return item;
  }

  remove(item) {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
    this.save();
    return index >= 0;
  }

  prune(predicate) {
    const before = this.items.length;
    const retained = this.items.filter(item => !predicate(item));
    this.items.splice(0, this.items.length, ...retained);
    if (before !== this.items.length) this.save();
    return before - this.items.length;
  }

  status() {
    return { size: this.items.length, persisted: true, file: path.basename(this.filePath) };
  }
}

module.exports = { QueueStore };
