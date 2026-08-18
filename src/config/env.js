const fs = require("fs");
const path = require("path");

function loadEnvFile(envPath, override = false) {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (override || !process.env[key]) process.env[key] = value;
  }
}

function loadEnv() {
  const root = path.join(__dirname, "..", "..");
  loadEnvFile(path.join(root, ".env"));
  loadEnvFile(path.join(root, ".env.local"), true);
}

module.exports = { loadEnv };
