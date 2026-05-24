//
//  tcp.js
//  SupaVector
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// tcp.js
// This file handles sending commands to the C++ TCP server.

const net = require("net");

// Hostname inside Docker network is the service name: "redis"
// If running locally without Docker, you can switch to "127.0.0.1"
const TCP_HOST = process.env.TCP_HOST || "redis";
const TCP_PORT = parseInt(process.env.TCP_PORT || "6379", 10);
const TCP_TIMEOUT_MS = parseInt(process.env.TCP_TIMEOUT_MS || "8000", 10);

function extractReplyLines(buffer) {
  let remaining = String(buffer || "");
  const lines = [];

  while (true) {
    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex === -1) break;
    let line = remaining.slice(0, newlineIndex);
    remaining = remaining.slice(newlineIndex + 1);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (!line) continue;
    lines.push(line.trim());
  }

  return { lines, remainder: remaining };
}

function createInactivityTimer(timeoutMs, onTimeout) {
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
  let timer = null;

  function clear() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clear();
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
    }, safeTimeoutMs);
  }

  return {
    timeoutMs: safeTimeoutMs,
    start: schedule,
    bump: schedule,
    clear
  };
}

// sendCmd sends ONE command and returns ONE line reply
function sendCmd(cmd) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let settled = false;
    const timeoutMs = Number.isFinite(TCP_TIMEOUT_MS) && TCP_TIMEOUT_MS > 0 ? TCP_TIMEOUT_MS : 8000;
    const parts = cmd.trim().split(/\s+/, 3);
    const label = parts.length >= 2 ? `${parts[0]} ${parts[1]}` : (parts[0] || "CMD");
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`TCP command timeout (${label})`));
    }, timeoutMs);

    let data = "";

    client.connect(TCP_PORT, TCP_HOST, () => {
      client.setNoDelay(true);
      client.write(cmd.trim() + "\n");
    });

    client.on("data", (chunk) => {
      data += chunk.toString();

      // Our C++ server replies with one line per command
      if (data.includes("\n")) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        resolve(data.trim());
      }
    });

    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    client.on("timeout", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(new Error(`TCP command timeout (${label})`));
    });
    client.setTimeout(timeoutMs);
  });
}

function sendCmdBatch(commands) {
  const cleanCommands = Array.isArray(commands)
    ? commands.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (!cleanCommands.length) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let settled = false;
    let pending = "";
    const replies = [];
    const timeoutMs = Number.isFinite(TCP_TIMEOUT_MS) && TCP_TIMEOUT_MS > 0 ? TCP_TIMEOUT_MS : 8000;
    const label = `batch ${cleanCommands.length}`;
    const inactivityTimer = createInactivityTimer(timeoutMs, () => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`TCP command timeout (${label})`));
    });
    inactivityTimer.start();

    client.connect(TCP_PORT, TCP_HOST, () => {
      client.setNoDelay(true);
      client.write(cleanCommands.join("\n") + "\n");
    });

    client.on("data", (chunk) => {
      pending += chunk.toString();
      inactivityTimer.bump();
      const parsed = extractReplyLines(pending);
      pending = parsed.remainder;
      for (const line of parsed.lines) {
        replies.push(line);
        if (replies.length >= cleanCommands.length) {
          if (settled) return;
          settled = true;
          inactivityTimer.clear();
          client.destroy();
          resolve(replies.slice(0, cleanCommands.length));
          return;
        }
      }
    });

    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      inactivityTimer.clear();
      reject(err);
    });

    client.on("timeout", () => {
      if (settled) return;
      settled = true;
      inactivityTimer.clear();
      client.destroy();
      reject(new Error(`TCP command timeout (${label})`));
    });

    client.on("close", () => {
      if (settled) return;
      settled = true;
      inactivityTimer.clear();
      reject(new Error(`TCP connection closed before all replies were received (${replies.length}/${cleanCommands.length})`));
    });

    client.setTimeout(timeoutMs);
  });
}

// Build a VSET command string
// id = string
// vec = array of floats
function buildVset(id, vec) {

  // dim = how many floats
  const dim = vec.length;

  // Convert floats to strings
  // toString() is okay for MVP; later we can control precision
  const floats = vec.map(x => x.toString()).join(" ");

  return `VSET ${id} ${dim} ${floats}`;
}

// Build a VSEARCH command string
function buildVsearch(k, vec) {
  const dim = vec.length;
  const floats = vec.map(x => x.toString()).join(" ");
  return `VSEARCH ${k} ${dim} ${floats}`;
}

function buildVsearchIn(k, vec, ids) {
  const dim = vec.length;
  const floats = vec.map(x => x.toString()).join(" ");
  const cleanIds = Array.isArray(ids)
    ? ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!cleanIds.length) {
    return `VSEARCHIN ${k} ${dim} ${floats} 0`;
  }
  return `VSEARCHIN ${k} ${dim} ${floats} ${cleanIds.length} ${cleanIds.join(" ")}`;
}

function buildVsearchAnn(k, vec, overfetch = 5) {
  const dim = vec.length;
  const floats = vec.map(x => x.toString()).join(" ");
  const cleanOverfetch = Number.isFinite(Number(overfetch)) && Number(overfetch) > 0
    ? Math.floor(Number(overfetch))
    : 5;
  return `VSEARCHANN ${k} ${dim} ${floats} ${cleanOverfetch}`;
}

function buildVsearchAnnIn(k, vec, ids, overfetch = 5) {
  const dim = vec.length;
  const floats = vec.map(x => x.toString()).join(" ");
  const cleanOverfetch = Number.isFinite(Number(overfetch)) && Number(overfetch) > 0
    ? Math.floor(Number(overfetch))
    : 5;
  const cleanIds = Array.isArray(ids)
    ? ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!cleanIds.length) {
    return `VSEARCHANNIN ${k} ${dim} ${floats} ${cleanOverfetch} 0`;
  }
  return `VSEARCHANNIN ${k} ${dim} ${floats} ${cleanOverfetch} ${cleanIds.length} ${cleanIds.join(" ")}`;
}

// Build a VDEL command string
function buildVdel(id) {
  return `VDEL ${id}`;
}

function buildVdelPrefix(prefix) {
  return `VDELPREFIX ${prefix}`;
}

function buildVclear() {
  return "VCLEAR";
}

// Parse VSEARCH reply:
// "id1 score1|id2 score2|id3 score3"
function parseVsearchReply(line) {
  if (!line) return [];

  // Split by "|"
  const items = line.split("|").map(x => x.trim()).filter(Boolean);

  const out = [];

  for (const item of items) {

    // item looks like: "doc#0 0.9234"
    const parts = item.split(/\s+/);

    if (parts.length < 2) continue;

    const id = parts[0];
    const score = parseFloat(parts[1]);

    out.push({ id, score });
  }

  return out;
}

module.exports = {
  sendCmd,
  sendCmdBatch,
  buildVset,
  buildVsearch,
  buildVsearchIn,
  buildVsearchAnn,
  buildVsearchAnnIn,
  buildVdel,
  buildVdelPrefix,
  buildVclear,
  parseVsearchReply,
  __testHooks: {
    buildVdelPrefix,
    extractReplyLines,
    createInactivityTimer
  }
};
