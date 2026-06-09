const fs = require("fs");
const http = require("http");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const PORT = 17354;
const CDP_PORT = 17355;
const ROOT = __dirname;
const TIMER_FILE = path.join(ROOT, "obs_timer.html");
const PROFILE_DIR = path.join(ROOT, ".weflab-browser-profile");
const DEFAULT_NAMES = ["멧돼지", "돼지"];
const OBS_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OBS/30.0.0";
const DETECTION_COOLDOWN_MS = 15000;

const clients = new Set();
const recentEvents = new Map();
let nextDetectionAllowedAt = 0;

function question(rl, text) {
  return new Promise((resolve) => rl.question(text, resolve));
}

function findBrowser() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/" || url.pathname === "/timer") {
      const html = fs.readFileSync(TIMER_FILE, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(html);
      return;
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      res.write("event: hello\ndata: {}\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname === "/send") {
      const text = url.searchParams.get("text") || "";
      if (text.trim()) broadcastRoulette(text.trim(), "manual");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`OBS 타이머 주소: http://127.0.0.1:${PORT}/timer`);
  });

  return server;
}

function broadcastRoulette(text, source = "weflab") {
  const payload = JSON.stringify({ text, source, at: new Date().toISOString() });
  for (const client of clients) {
    client.write(`event: roulette\ndata: ${payload}\n\n`);
  }
  console.log(`[적용 전송] ${text}`);
}

function launchBrowser(browserPath, weflabUrl) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    `--user-agent=${OBS_USER_AGENT}`,
    "--no-first-run",
    "--disable-features=Translate",
    weflabUrl
  ];
  return spawn(browserPath, args, {
    detached: false,
    stdio: "ignore"
  });
}

async function waitForJson(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error(`브라우저 디버그 포트 연결 실패: ${url}`);
}

async function connectPageSocket() {
  await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const pages = await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!page) throw new Error("감지할 브라우저 페이지를 찾지 못했습니다.");
  return new CdpClient(page.webSocketDebuggerUrl);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 5000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return result.result?.value || "";
  }
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAliases(names) {
  const base = [...names, "멧돼지", "맷돼지", "돼지", "대지"];
  return [...new Set(base.map((name) => name.trim()).filter(Boolean))];
}

function extractRouletteEvents(text, names) {
  const aliases = buildAliases(names);
  const aliasPattern = aliases.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|");
  const timePattern = "[+-]?\\s*\\d+(?:\\.\\d+)?\\s*(?:시간|시|분|초|h|hr|m|min|s|sec)";
  const patterns = [
    new RegExp(`(?:${aliasPattern})[^\\n]{0,80}?${timePattern}`, "gi"),
    new RegExp(`${timePattern}[^\\n]{0,80}?(?:${aliasPattern})`, "gi")
  ];
  const normalized = normalizeText(text);

  const resultMarker = normalized.match(/룰렛\s*결과(?:는|은|:)?/);
  if (resultMarker && typeof resultMarker.index === "number") {
    const resultArea = normalized.slice(resultMarker.index + resultMarker[0].length, resultMarker.index + resultMarker[0].length + 180);
    const resultEvents = collectRouletteMatches(resultArea, patterns);
    if (resultEvents.length > 0) return [resultEvents[0]];
  }

  const lines = normalized.split("\n");
  const resultLineIndex = lines.findIndex((line) => /룰렛\s*결과/.test(line));
  if (resultLineIndex >= 0) {
    const nearbyText = lines.slice(resultLineIndex, resultLineIndex + 4).join("\n");
    const nearbyEvents = collectRouletteMatches(nearbyText, patterns);
    if (nearbyEvents.length > 0) return [nearbyEvents[nearbyEvents.length - 1]];
  }

  return collectRouletteMatches(normalized, patterns).slice(-1);
}

function collectRouletteMatches(text, patterns) {
  const events = [];
  for (const line of normalizeText(text).split("\n")) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const matches = line.match(pattern) || [];
      for (const match of matches) {
        const clean = match.replace(/\s+/g, " ").trim();
        if (clean) events.push(clean);
      }
    }
  }

  return [...new Set(events)];
}

function getEventKey(text, names) {
  const aliases = buildAliases(names).sort((a, b) => b.length - a.length);
  const compact = String(text).replace(/\s+/g, "");
  const alias = aliases.find((name) => compact.includes(name.replace(/\s+/g, ""))) || "";
  const time = compact.match(/[+-]?\d+(?:\.\d+)?(?:시간|시|분|초|h|hr|m|min|s|sec)/i)?.[0] || "";
  return `${alias}:${time}` || compact;
}

function wasRecentlySent(key, windowMs = 20000) {
  const now = Date.now();
  for (const [eventKey, sentAt] of recentEvents) {
    if (now - sentAt > windowMs) recentEvents.delete(eventKey);
  }
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, now);
  return false;
}

async function monitorPage(cdp, names) {
  let lastText = "";
  console.log("위플랩 페이지 감지 시작");

  setInterval(async () => {
    try {
      const text = await cdp.evaluate("document.body ? document.body.innerText : ''");
      const normalized = normalizeText(text);
      if (!normalized || normalized === lastText) return;

      const previous = lastText;
      lastText = normalized;
      const changedText = normalized
        .split("\n")
        .filter((line) => !previous.includes(line))
        .join("\n");
      const events = extractRouletteEvents(`${changedText}\n${normalized}`, names);
      if (events.length === 0 || Date.now() < nextDetectionAllowedAt) return;

      for (const eventText of events) {
        const key = getEventKey(eventText, names);
        if (wasRecentlySent(key)) continue;
        broadcastRoulette(eventText);
        nextDetectionAllowedAt = Date.now() + DETECTION_COOLDOWN_MS;
        break;
      }
    } catch (error) {
      console.log(`[감지 오류] ${error.message}`);
    }
  }, 900);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const argUrl = process.argv[2] || "";
  const weflabUrl = argUrl || (await question(rl, "위플랩 후원알림 URL: "));
  const firstName = (await question(rl, "첫 번째 타이머 이름 [멧돼지]: ")) || DEFAULT_NAMES[0];
  const secondName = (await question(rl, "두 번째 타이머 이름 [돼지]: ")) || DEFAULT_NAMES[1];
  rl.close();

  if (!/^https?:\/\//i.test(weflabUrl.trim())) {
    console.log("위플랩 URL은 https:// 로 시작해야 합니다.");
    process.exit(1);
  }

  startServer();

  const browserPath = findBrowser();
  if (!browserPath) {
    console.log("Edge 또는 Chrome을 찾지 못했습니다.");
    process.exit(1);
  }

  launchBrowser(browserPath, weflabUrl.trim());
  const cdp = await connectPageSocket();
  await cdp.open();
  await cdp.send("Runtime.enable");
  await monitorPage(cdp, [firstName, secondName]);

  console.log("OBS에는 아래 주소를 브라우저 소스로 넣으세요.");
  console.log(`http://127.0.0.1:${PORT}/timer`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
