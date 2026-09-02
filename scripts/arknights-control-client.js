const action = process.argv[2] || "status";
const PORT = 17631;
const TOKEN = "codex-arknights-local";

async function main() {
  const options = {
    method: action === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
  let endpoint = action;
  if (action === "click") {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({
      xRatio: Number(process.argv[3]),
      yRatio: Number(process.argv[4]),
      waitMs: Number(process.argv[5]) || 900,
      mode: process.argv[6] || "physical",
    });
  } else if (action === "drag") {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({
      startXRatio: Number(process.argv[3]),
      startYRatio: Number(process.argv[4]),
      endXRatio: Number(process.argv[5]),
      endYRatio: Number(process.argv[6]),
      waitMs: Number(process.argv[7]) || 900,
    });
  }
  const response = await fetch(`http://127.0.0.1:${PORT}/${endpoint}`, options);
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
  if (!response.ok || !payload.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
