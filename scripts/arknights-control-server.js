/**
 * Elevated, loopback-only Arknights mouse controller.
 *
 * Launch once with RunAs, then drive it through the companion client. Every
 * click is still guarded by win-control.ps1's top-level window hit-test.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  activateWindow,
  captureScreen,
  clickClientAtomic,
  clickClientMessageAtomic,
  dragClientAtomic,
  getWindowInfo,
} = require("../src/bot/windows-control");

const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] || 17631);
const TOKEN = process.argv[3] || "codex-arknights-local";
const captureDir = path.join(__dirname, "..", "runtime", "vision", "captures", "arknights");
const livePath = path.join(captureDir, "_live-control.png");

function respond(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function capture() {
  activateWindow();
  const info = getWindowInfo();
  fs.mkdirSync(captureDir, { recursive: true });
  captureScreen(info.client.x, info.client.y, info.client.width, info.client.height, livePath);
  return { info, path: livePath, capturedAt: new Date().toISOString() };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      respond(response, 403, { ok: false, error: "forbidden" });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      respond(response, 200, { ok: true, info: getWindowInfo() });
      return;
    }
    if (request.method === "POST" && request.url === "/capture") {
      respond(response, 200, { ok: true, ...capture() });
      return;
    }
    if (request.method === "POST" && request.url === "/click") {
      const body = await readJson(request);
      const xRatio = Number(body.xRatio);
      const yRatio = Number(body.yRatio);
      if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
        throw new Error("xRatio and yRatio must be between 0 and 1");
      }
      const info = getWindowInfo();
      const clientX = Math.round((info.client.width - 1) * xRatio);
      const clientY = Math.round((info.client.height - 1) * yRatio);
      const click = body.mode === "message"
        ? clickClientMessageAtomic(clientX, clientY)
        : clickClientAtomic(clientX, clientY);
      await new Promise(resolve => setTimeout(resolve, Number(body.waitMs) || 900));
      respond(response, 200, { ok: true, click, ...capture() });
      return;
    }
    if (request.method === "POST" && request.url === "/drag") {
      const body = await readJson(request);
      const ratios = [body.startXRatio, body.startYRatio, body.endXRatio, body.endYRatio].map(Number);
      if (ratios.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error("drag ratios must be between 0 and 1");
      }
      const info = getWindowInfo();
      const [startXRatio, startYRatio, endXRatio, endYRatio] = ratios;
      const drag = dragClientAtomic(
        Math.round((info.client.width - 1) * startXRatio),
        Math.round((info.client.height - 1) * startYRatio),
        Math.round((info.client.width - 1) * endXRatio),
        Math.round((info.client.height - 1) * endYRatio)
      );
      await new Promise(resolve => setTimeout(resolve, Number(body.waitMs) || 900));
      respond(response, 200, { ok: true, drag, ...capture() });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      respond(response, 200, { ok: true, shuttingDown: true });
      setTimeout(() => server.close(() => process.exit(0)), 50);
      return;
    }
    respond(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    respond(response, 500, { ok: false, error: error?.stack || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Arknights controller ready at http://${HOST}:${PORT}`);
});
