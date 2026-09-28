const PERSONAL_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{15,19}\b/g,
  /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]\b/g
];

function redactPersonalValues(value) {
  let output = String(value ?? "");
  for (const pattern of PERSONAL_PATTERNS) output = output.replace(pattern, "[已隐藏]");
  return output;
}

function sanitizeErrorMessage(error, fallback = "运行时发生错误") {
  let output = String(error instanceof Error ? error.message : error || fallback);
  output = output
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]")
    .replace(/\b(?:[A-Za-z]:\\|\/)(?:[^\s:]+[\\/])*[^\s:]*/g, "[路径已隐藏]");
  output = redactPersonalValues(output).replace(/[\r\n]+/g, " ").trim();
  return output || fallback;
}

module.exports = { sanitizeErrorMessage, redactPersonalValues };
