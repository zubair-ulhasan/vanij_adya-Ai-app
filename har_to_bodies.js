#!/usr/bin/env node
"use strict";

/**
 * HAR Unique Endpoints Extractor
 * --------------------------------
 * Reads a .har (or JSON) file, de-duplicates network entries by METHOD + URL path (query string ignored by default),
 * prints counts for total vs. unique endpoints, and writes a `har_bodies.json` file with one object per unique endpoint.
 *
 * Usage:
 *   node har_extract.js -i ./traffic.har               # writes ./har_bodies.json
 *   node har_extract.js -i ./traffic.har -o ./out.json  # custom output path
 *   node har_extract.js -i ./traffic.har --include-query # consider query string in uniqueness key
 *
 * Notes:
 * - "Unique" is determined by default as: `${METHOD} ${origin}${pathname}` (no query string). Use --include-query to include query.
 * - "type" prefers Chrome's `_resourceType` (maps `xhr` -> `xmlhttprequest`). Falls back to `sec-fetch-dest` header.
 * - `timeStamp` is derived from `startedDateTime` (epoch ms).
 * - `requestBody` attempts JSON.parse when `postData.text` looks like JSON; otherwise returns raw text or a params object.
 * - Adds a simple progress counter and meaningful logs.
 * node har_to_bodies.js -i ./har_veeclinic_22_oct.json -o ./out.json
 * node har_to_bodies.js -i ./Inventory_HAR_24_oct.json -o ./Inventory_request_bodies.json
 * node har_to_bodies.js -i ./CRM_HAR_24_oct.json -o ./CRM_request_bodies.json
 * node har_to_bodies.js -i ./celitech_har.json -o ./celitech_request_bodies.json
 * node har_to_bodies.js -i ./Synctera_har.json -o ./Syntera_request_bodies.json
 * node har_to_bodies.js -i ./Webengage_har.json -o ./Webengage_request_bodies.json

 */

import fs from "fs";
import path from "path";

// ---- CLI args ----
const args = process.argv.slice(2);
function getArg(flag, fallback = undefined) {
  const i = args.indexOf(flag);
  if (i !== -1) {
    const next = args[i + 1];
    if (!next || next.startsWith("-")) return true; // boolean flag
    return next;
  }
  return fallback;
}

const inputPath = getArg("-i") || getArg("--in") || getArg("--input");
const outputPath = getArg("-o") || getArg("--out") || "har_bodies.json";
const includeQuery = Boolean(getArg("--include-query", false));

if (!inputPath) {
  console.error("\x1b[31m✖ Error:\x1b[0m Please provide an input file with -i ./file.har");
  process.exit(1);
}

// ---- Utilities ----
function safeParseJSON(text) {
  if (typeof text !== "string") return text ?? null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return trimmed; // return raw text when not valid JSON
  }
}

function headerLookup(headers = [], name) {
  const n = (name || "").toLowerCase();
  const found = headers.find(h => (h?.name || "").toLowerCase() === n);
  return found ? found.value : undefined;
}

function normalizeType(entry) {
  const rt = (entry._resourceType || "").toLowerCase();
  if (rt === "xhr") return "xmlhttprequest";
  if (rt) return rt;
  // fallback to sec-fetch-dest header if available
  const dest = headerLookup(entry?.request?.headers, "sec-fetch-dest");
  return (dest || "unknown").toLowerCase();
}

function buildStatusText(response) {
  const hv = (response?.httpVersion || "HTTP/1.1").toUpperCase();
  const st = response?.status ?? 0;
  // If response.statusText is present and non-empty, prefer it; otherwise construct one
  const statusText = (response?.statusText && String(response.statusText).trim())
    ? String(response.statusText).trim()
    : `${hv} ${st}`;
  return statusText;
}

function toEpochMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function parseRequestBody(req) {
  if (!req?.postData) return null;
  const { mimeType, text, params } = req.postData;

  // urlencoded forms
  if (Array.isArray(params) && params.length) {
    const obj = {};
    for (const p of params) {
      if (!p || typeof p.name !== "string") continue;
      obj[p.name] = p.value ?? "";
    }
    return obj;
  }

  // JSON or raw text
  if (typeof text === "string" && text.length) {
    // Try JSON.parse for JSON-like mime types
    const mt = (mimeType || "").toLowerCase();
    if (mt.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
      return safeParseJSON(text);
    }
    return text; // keep as raw string for non-JSON payloads
  }

  return null;
}

function dedupeKey(method, urlStr, includeQuery) {
  try {
    const u = new URL(urlStr);
    const base = `${u.origin}${u.pathname}`;
    return includeQuery ? `${method.toUpperCase()} ${u.href}` : `${method.toUpperCase()} ${base}`;
  } catch (err) {
    // If URL constructor fails (non-absolute), fallback to raw string
    const base = urlStr.split("?")[0];
    return includeQuery ? `${method.toUpperCase()} ${urlStr}` : `${method.toUpperCase()} ${base}`;
  }
}

function drawProgress(current, total, width = 28) {
  const ratio = total ? current / total : 1;
  const filled = Math.round(ratio * width);
  const bar = "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
  const pct = String(Math.floor(ratio * 100)).padStart(3, " ");
  return `[${bar}] ${pct}% (${current}/${total})`;
}

// ---- Main ----
(async function main() {
  const startTs = Date.now();
  console.log(`\n\x1b[36mHAR Unique Endpoints Extractor\x1b[0m`);
  console.log(`Input:  ${path.resolve(inputPath)}`);
  console.log(`Output: ${path.resolve(outputPath)}`);
  console.log(`Uniqueness key: METHOD + URL ${includeQuery ? "(with query)" : "(no query)"}`);

  let raw;
  try {
    raw = fs.readFileSync(inputPath, "utf8");
  } catch (err) {
    console.error("\x1b[31m✖ Failed to read file:\x1b[0m", err.message);
    process.exit(1);
  }

  let har;
  try {
    har = JSON.parse(raw);
  } catch (err) {
    console.error("\x1b[31m✖ Not valid JSON/HAR:\x1b[0m", err.message);
    process.exit(1);
  }

  const version = har?.log?.version || "unknown";
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  console.log(`HAR version: ${version}`);
  console.log(`Entries found: ${entries.length}`);
  if (entries.length === 0) {
    console.warn("\x1b[33mNo entries to process. Exiting.\x1b[0m");
    process.exit(0);
  }

  // De-duplicate
  const uniqueMap = new Map();
  const total = entries.length;
  const progressEvery = Math.max(1, Math.floor(total / 100)); // ~100 updates max

  let considered = 0;
  for (let i = 0; i < total; i++) {
    const e = entries[i];
    const req = e?.request;
    const res = e?.response;

    if (!req?.url || !req?.method) continue; // ignore malformed

    considered++;
    const key = dedupeKey(req.method, req.url, includeQuery);
    if (uniqueMap.has(key)) {
      // already captured; skip
    } else {
      const obj = {
        id: String(uniqueMap.size + 1),
        url: req.url,
        method: String(req.method || "").toUpperCase(),
        type: normalizeType(e),
        timeStamp: toEpochMs(e?.startedDateTime),
        requestBody: parseRequestBody(req),
        status: res?.status ?? 0,
        statusText: buildStatusText(res),
        responseHeaders: Array.isArray(res?.headers)
          ? res.headers
              .filter(h => h && typeof h.name === "string")
              .map(h => ({ name: h.name, value: h.value }))
          : []
      };
      uniqueMap.set(key, obj);
    }

    if (i % progressEvery === 0 || i === total - 1) {
      const line = drawProgress(i + 1, total);
      process.stdout.write("\r" + line);
    }
  }
  process.stdout.write("\n");

  const unique = Array.from(uniqueMap.values());

  // Summary logs
  console.log(`\n\x1b[32m✔ Processing complete\x1b[0m`);
  console.log(`Total entries scanned: ${total}`);
  console.log(`Entries considered (valid requests): ${considered}`);
  console.log(`Unique endpoints: ${unique.length}`);

  // Write file
  try {
    fs.writeFileSync(outputPath, JSON.stringify(unique, null, 2), "utf8");
    const bytes = fs.statSync(outputPath).size;
    console.log(`\nWrote \x1b[36m${unique.length}\x1b[0m records to \x1b[35m${outputPath}\x1b[0m (${bytes} bytes).`);
  } catch (err) {
    console.error("\x1b[31m✖ Failed to write output:\x1b[0m", err.message);
    process.exit(1);
  }

  const dur = ((Date.now() - startTs) / 1000).toFixed(2);
  console.log(`Elapsed: ${dur}s\n`);
})();
