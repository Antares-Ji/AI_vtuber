const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classifyComplexity } = require("../src/brain/local-llm");

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "router-evaluation.json"), "utf8"));
const results = cases.map(test => ({ ...test, actual: classifyComplexity({ text: test.text }).route }));
const failures = results.filter(result => result.actual !== result.expected);
const accuracy = (results.length - failures.length) / results.length;
const criticalCategories = new Set(["medical", "legal", "financial", "realtime-fact", "fact-check"]);
const criticalFailures = failures.filter(result => criticalCategories.has(result.category));

if (failures.length) {
  console.error("Router evaluation failures:");
  for (const failure of failures) console.error(`- [${failure.category}] expected=${failure.expected} actual=${failure.actual}: ${failure.text}`);
}
console.log(`Router evaluation: ${results.length - failures.length}/${results.length} (${(accuracy * 100).toFixed(1)}%)`);
assert(accuracy >= 0.9, `router accuracy ${(accuracy * 100).toFixed(1)}% is below 90%`);
assert.deepEqual(criticalFailures, [], "high-stakes and realtime fact requests must not stay on the local model");
