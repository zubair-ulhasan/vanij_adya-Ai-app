#!/usr/bin/env node
/**
 * HAR -> OpenAPI (YAML) generator
 *
 * Features:
 * - Reads HAR file from .env (HAR_FILE)
 * - Filters endpoints by BASE_PATH
 * - Dedupes by (method + normalizedPath) ignoring query differences
 * - Infers path params and query params
 * - Adds request/response examples from HAR
 * - Generates OpenAPI 3.0 YAML with tags and schemas (best-effort)
 * - Progress bar + single-line log updates (no terminal spam)
 * run this npm i fs path dotenv yaml chalk cli-progress
 * node har-to-openapi.js
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import YAML from "yaml";
import chalk from "chalk";
import cliProgress from "cli-progress";

dotenv.config();

const {
  HAR_FILE,
  BASE_PATH,
  OUTPUT_SWAGGER,
  API_TITLE,
  API_VERSION,
  SERVER_URL,
} = process.env;

if (!HAR_FILE) {
  console.error("Missing HAR_FILE in .env");
  process.exit(1);
}
if (!BASE_PATH) {
  console.error("Missing BASE_PATH in .env");
  process.exit(1);
}

const absHarPath = path.isAbsolute(HAR_FILE)
  ? HAR_FILE
  : path.resolve(process.cwd(), HAR_FILE);
const absOutPath = path.isAbsolute(OUTPUT_SWAGGER)
  ? OUTPUT_SWAGGER
  : path.resolve(process.cwd(), OUTPUT_SWAGGER);

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function parseHar(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = safeJsonParse(raw);
  if (!parsed?.log?.entries?.length) {
    throw new Error("HAR does not contain log.entries[]");
  }
  return parsed;
}

function urlToObj(u) {
  try {
    return new URL(u);
  } catch {
    // Some HARs store partial URLs; try to repair minimally
    return new URL(u, "http://har.local");
  }
}

/**
 * Normalize a URL pathname into an OpenAPI-style path:
 * - Keeps BASE_PATH as a required prefix
 * - Converts "likely IDs" to {param} placeholders:
 *   - UUID, Mongo ObjectId, numeric segments
 * - Avoids converting short/common segments (heuristic)
 */
// function normalizePathname(pathname) {
//   const segments = pathname.split("/").filter(Boolean);

//   const uuidRe =
//     /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
//   const mongoIdRe = /^[0-9a-f]{24}$/i;
//   const numRe = /^\d+$/;

//   const normalized = segments.map((seg) => {
//     // Heuristics: treat long identifiers as params
//     if (uuidRe.test(seg)) return "{id}";
//     if (mongoIdRe.test(seg)) return "{id}";
//     if (numRe.test(seg)) return "{id}";
//     // Also consider very long opaque tokens as IDs
//     if (seg.length >= 16 && /^[A-Za-z0-9\-_]+$/.test(seg)) return "{id}";
//     return seg;
//   });

//   return "/" + normalized.join("/");
// }
function normalizePathname(pathname) {
  const segments = pathname.split("/").filter(Boolean);

  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const mongoIdRe = /^[0-9a-f]{24}$/i;
  const numRe = /^\d+$/;

  let idCount = 0;

  const normalized = segments.map((seg) => {
    const isId =
      uuidRe.test(seg) ||
      mongoIdRe.test(seg) ||
      numRe.test(seg) ||
      (seg.length >= 16 && /^[A-Za-z0-9\-_]+$/.test(seg));

    if (isId) {
      idCount += 1;
      return idCount === 1 ? "{id}" : `{id${idCount}}`;
    }
    return seg;
  });

  return "/" + normalized.join("/");
}

/**
 * Extract path parameters from normalized path and original path:
 * - If normalized has {id}, create param name:
 *   - Prefer "id" or try to infer from previous segment (plural -> singular)
 */
// function extractPathParams(normalizedPath, originalPathname) {
//   const nSegs = normalizedPath.split("/").filter(Boolean);
//   const oSegs = originalPathname.split("/").filter(Boolean);

//   const params = [];
//   for (let i = 0; i < nSegs.length; i++) {
//     if (nSegs[i].startsWith("{") && nSegs[i].endsWith("}")) {
//       // const prev = nSegs[i - 1] || "id";
//       // let name = "id";
//       // if (prev && prev !== "{id}") {
//       //   // Try infer: "users" -> "userId", "orders" -> "orderId"
//       //   const base = prev.endsWith("s") ? prev.slice(0, -1) : prev;
//       //   name = `${base}Id`;
//       const name = nSegs[i].replace(/[{}]/g, "");

//       params.push({
//         name,
//         in: "path",
//         required: true,
//         schema: { type: "string" },
//       });
//     }
//   }

//   // Deduplicate path params by name
//   const uniq = new Map();
//   for (const p of params) {
//     if (!uniq.has(p.name)) uniq.set(p.name, p);
//   }
//   return Array.from(uniq.values());
// }
function extractPathParams(normalizedPath, originalPathname) {
  const nSegs = normalizedPath.split("/").filter(Boolean);
  const oSegs = originalPathname.split("/").filter(Boolean);

  const params = [];
  for (let i = 0; i < nSegs.length; i++) {
    if (nSegs[i].startsWith("{") && nSegs[i].endsWith("}")) {
      const name = nSegs[i].replace(/[{}]/g, "");
      const exampleValue = oSegs[i]; // actual value from HAR URL path

      params.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        example: exampleValue, // <-- keep it here for later emission
      });
    }
  }

  // Deduplicate by name (now names are id, id2, id3... so they won't collide)
  const uniq = new Map();
  for (const p of params) {
    if (!uniq.has(p.name)) uniq.set(p.name, p);
  }
  return Array.from(uniq.values());
}

function buildTagFromPath(normalizedPath) {
  // e.g. /api/users/{id}/roles -> "users"
  const segs = normalizedPath.split("/").filter(Boolean);
  // Skip base path segments
  const baseSegs = BASE_PATH.split("/").filter(Boolean);
  const remaining = segs.slice(baseSegs.length);
  const first =
    remaining.find((s) => s && !s.startsWith("{")) || remaining[0] || "default";
  return first;
}

function contentTypeOf(headers = []) {
  const h = headers.find(
    (x) => (x.name || "").toLowerCase() === "content-type"
  );
  return (h?.value || "").split(";")[0].trim() || "";
}

function pickRequestBody(entry) {
  const postData = entry?.request?.postData;
  if (!postData) return null;

  const mimeType =
    postData.mimeType ||
    contentTypeOf(entry.request.headers) ||
    "application/json";
  const text = postData.text || "";

  // Try JSON example
  const parsed = safeJsonParse(text);
  if (parsed) {
    return { mimeType: "application/json", example: parsed };
  }

  // If it's urlencoded, attempt to parse into object
  if (mimeType.includes("application/x-www-form-urlencoded")) {
    const obj = {};
    (postData.params || []).forEach((p) => {
      obj[p.name] = p.value ?? "";
    });
    return { mimeType: "application/x-www-form-urlencoded", example: obj };
  }

  // fallback
  return { mimeType: mimeType || "text/plain", example: text };
}

function pickResponseBody(entry) {
  const res = entry?.response;
  if (!res) return null;

  const mimeType = res.content?.mimeType || contentTypeOf(res.headers) || "";
  const text = res.content?.text ?? "";
  const status = res.status || 200;

  const parsed = safeJsonParse(text);
  if (parsed) {
    return { status, mimeType: "application/json", example: parsed };
  }

  if (text && mimeType) {
    return { status, mimeType, example: text };
  }

  return null;
}

/**
 * Basic schema inference from example value.
 * This is deliberately conservative.
 */
function inferSchemaFromExample(example, components, suggestedName) {
  const t = typeof example;

  if (example === null) return { nullable: true };

  if (Array.isArray(example)) {
    const itemSchema = example.length
      ? inferSchemaFromExample(example[0], components, `${suggestedName}Item`)
      : { type: "string" };
    return { type: "array", items: itemSchema };
  }

  if (t === "string") return { type: "string" };
  if (t === "number")
    return Number.isInteger(example) ? { type: "integer" } : { type: "number" };
  if (t === "boolean") return { type: "boolean" };

  if (t === "object") {
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(example)) {
      props[k] = inferSchemaFromExample(
        v,
        components,
        `${suggestedName}${capitalize(k)}`
      );
      required.push(k);
    }
    return { type: "object", properties: props, required };
  }

  return { type: "string" };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function ensureComponentSchema(components, name, schema) {
  if (!components.schemas[name]) {
    components.schemas[name] = schema;
  }
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Dedup key ignores query differences:
 * method + normalizedPath
 */
function endpointKey(method, normalizedPath) {
  return `${method.toUpperCase()} ${normalizedPath}`;
}

function mergeQueryParams(existingParams, newParams) {
  const map = new Map(existingParams.map((p) => [`${p.in}:${p.name}`, p]));
  for (const p of newParams) {
    const k = `${p.in}:${p.name}`;
    if (!map.has(k)) map.set(k, p);
  }
  return Array.from(map.values());
}

function harEntryToEndpoint(entry) {
  const req = entry.request;
  const method = (req.method || "GET").toUpperCase();
  const urlObj = urlToObj(req.url || "");
  const pathname = urlObj.pathname || "/";
  // ---- SKIP STATIC / NON-API ENDPOINTS ----
  if (
    /\.(js|css|map|png|jpg|jpeg|gif|svg|ico|woff2?|woff|ttf|eot)$/i.test(
      pathname
    ) ||
    (entry._resourceType && entry._resourceType !== "xhr")
  ) {
    return null;
  }
  if (!pathname.startsWith(BASE_PATH)) return null;

  const normalizedPath = normalizePathname(pathname);
  const tag = buildTagFromPath(normalizedPath);

  // Query params (from URLSearchParams + HAR params if present)
  const queryParams = [];
  urlObj.searchParams.forEach((value, name) => {
    queryParams.push({
      name,
      in: "query",
      required: false,
      schema: { type: "string" },
      example: value,
    });
  });
  // HAR might include request.queryString
  (req.queryString || []).forEach((q) => {
    if (!queryParams.find((p) => p.name === q.name)) {
      queryParams.push({
        name: q.name,
        in: "query",
        required: false,
        schema: { type: "string" },
        example: q.value ?? "",
      });
    }
  });

  const pathParams = extractPathParams(normalizedPath, pathname);

  const requestBody = pickRequestBody(entry);
  const responseBody = pickResponseBody(entry);

  return {
    method,
    pathname,
    normalizedPath,
    tag,
    queryParams,
    pathParams,
    requestBody,
    responseBody,
    status: entry?.response?.status || 200,
  };
}

function buildOpenApiDoc() {
  return {
    openapi: "3.0.3",
    info: {
      title: API_TITLE,
      version: API_VERSION,
    },
    servers: [{ url: SERVER_URL }],
    tags: [],
    paths: {},
    components: { schemas: {} },
  };
}

/**
 * Create a stable operationId
 */
function makeOperationId(method, normalizedPath) {
  const clean = normalizedPath
    .replace(/^\//, "")
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/[^A-Za-z0-9]/g, "_"))
    .join("_");
  return `${method.toLowerCase()}_${clean || "root"}`;
}

function printInlineStatus(line) {
  // Clear current line and write new one (no terminal spam)
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(line);
}

function finalizeInlineStatus() {
  process.stdout.write("\n");
}

function main() {
  const startedAt = Date.now();

  console.log(chalk.cyan(`Reading HAR: ${absHarPath}`));
  const har = parseHar(absHarPath);
  const entries = har.log.entries || [];

  // Pre-filter entries by BASE_PATH to size progress bar accurately
  const candidate = [];
  for (const e of entries) {
    const u = urlToObj(e?.request?.url || "");
    if ((u.pathname || "").startsWith(BASE_PATH)) candidate.push(e);
  }

  console.log(chalk.cyan(`BASE_PATH: ${BASE_PATH}`));
  console.log(chalk.cyan(`SERVER_URL: ${SERVER_URL}`));
  console.log(chalk.cyan(`Candidate requests: ${candidate.length}`));

  const bar = new cliProgress.SingleBar(
    {
      format: "Progress |{bar}| {percentage}% | {value}/{total} | {status}",
      hideCursor: true,
      barsize: 24,
      clearOnComplete: true,
    },
    cliProgress.Presets.shades_classic
  );

  bar.start(candidate.length || 1, 0, { status: "starting" });

  const doc = buildOpenApiDoc();
  const tagSet = new Set();

  const endpoints = new Map(); // key -> aggregate
  let skippedNoMatch = entries.length - candidate.length;

  // Track stats
  let withRequestBody = 0;
  let withResponseExample = 0;
  let dedupedCount = 0;

  for (let i = 0; i < candidate.length; i++) {
    const entry = candidate[i];

    const ep = harEntryToEndpoint(entry);
    if (!ep) {
      bar.increment(1, { status: "skipping" });
      continue;
    }

    const key = endpointKey(ep.method, ep.normalizedPath);
    if (!endpoints.has(key)) {
      endpoints.set(key, {
        ...ep,
        // keep lists mutable to merge
        queryParams: [...ep.queryParams],
        pathParams: [...ep.pathParams],
        // keep "best" examples we see
        requestExamples: [],
        responseExamples: [],
      });
      dedupedCount++;
    } else {
      // Merge: do not treat differing query/path param values as new endpoint
      const existing = endpoints.get(key);
      existing.queryParams = mergeQueryParams(
        existing.queryParams,
        ep.queryParams
      );
      existing.pathParams = mergeQueryParams(
        existing.pathParams,
        ep.pathParams
      );
    }

    const agg = endpoints.get(key);

    if (
      ep.requestBody?.example !== undefined &&
      ep.requestBody?.example !== null
    ) {
      agg.requestExamples.push(ep.requestBody);
      withRequestBody++;
    }
    if (
      ep.responseBody?.example !== undefined &&
      ep.responseBody?.example !== null
    ) {
      agg.responseExamples.push(ep.responseBody);
      withResponseExample++;
    }

    tagSet.add(ep.tag);

    bar.increment(1, { status: `${ep.method} ${ep.normalizedPath}` });
  }

  bar.stop();

  // Add tags
  for (const t of Array.from(tagSet).sort()) {
    doc.tags.push({ name: t });
  }

  // Build paths and schemas
  for (const [key, ep] of endpoints.entries()) {
    if (!doc.paths[ep.normalizedPath]) doc.paths[ep.normalizedPath] = {};
    const opId = makeOperationId(ep.method, ep.normalizedPath);

    const parameters = [];

    // Path params
    // for (const p of ep.pathParams) {
    //   parameters.push({
    //     name: p.name,
    //     in: "path",
    //     required: true,
    //     schema: p.schema || { type: "string" },
    //   });
    // }
    for (const p of ep.pathParams) {
      parameters.push({
        name: p.name,
        in: "path",
        required: true,
        schema: p.schema || { type: "string" },
        ...(p.example !== undefined ? { example: p.example } : {}),
      });
    }
    // Query params
    for (const q of ep.queryParams) {
      parameters.push({
        name: q.name,
        in: "query",
        required: false,
        schema: q.schema || { type: "string" },
        ...(q.example !== undefined ? { example: q.example } : {}),
      });
    }

    // Request body schema + examples
    let requestBody = undefined;
    if (ep.requestExamples.length) {
      const best =
        ep.requestExamples.find((x) => x.mimeType === "application/json") ||
        ep.requestExamples[0];
      const mime = best.mimeType || "application/json";

      // Build schema and component
      let schema = { type: "string" };
      if (mime === "application/json" && typeof best.example === "object") {
        const inferred = inferSchemaFromExample(
          best.example,
          doc.components,
          `${capitalize(ep.tag)}Request`
        );
        const compName = `${capitalize(ep.tag)}${capitalize(
          ep.method.toLowerCase()
        )}Request`;
        schema = ensureComponentSchema(doc.components, compName, inferred);
      }

      requestBody = {
        required: true,
        content: {
          [mime]: {
            schema,
            examples: {
              fromHar: { value: best.example },
            },
          },
        },
      };
    }

    // Responses schema + examples
    const responses = {};
    const respBest =
      ep.responseExamples.find((x) => x.mimeType === "application/json") ||
      ep.responseExamples[0];

    if (respBest) {
      const mime = respBest.mimeType || "application/json";
      let schema = { type: "string" };

      if (mime === "application/json" && typeof respBest.example === "object") {
        const inferred = inferSchemaFromExample(
          respBest.example,
          doc.components,
          `${capitalize(ep.tag)}Response`
        );
        const compName = `${capitalize(ep.tag)}Response`;
        schema = ensureComponentSchema(doc.components, compName, inferred);
      }

      responses[String(respBest.status || 200)] = {
        description: "Response captured from HAR",
        content: {
          [mime]: {
            schema,
            examples: {
              fromHar: { value: respBest.example },
            },
          },
        },
      };
    } else {
      responses["200"] = { description: "Success" };
    }

    // Operation
    doc.paths[ep.normalizedPath][ep.method.toLowerCase()] = {
      tags: [ep.tag],
      summary: `${ep.method} ${ep.normalizedPath}`,
      operationId: opId,
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses,
    };
  }

  // Clean undefined fields for nicer YAML
  function deepClean(obj) {
    if (Array.isArray(obj)) return obj.map(deepClean);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const cleaned = deepClean(v);
        if (cleaned === undefined) continue;
        out[k] = cleaned;
      }
      return out;
    }
    return obj;
  }

  const cleaned = deepClean(doc);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(absOutPath), { recursive: true });

  // Write YAML
  const yamlText = YAML.stringify(cleaned, {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false,
  });
  fs.writeFileSync(absOutPath, yamlText, "utf8");

  // Summary
  const elapsedMs = Date.now() - startedAt;
  const totalUnique = endpoints.size;

  console.log("");
  console.log(chalk.green(`OpenAPI YAML written to: ${absOutPath}`));
  console.log(chalk.white("Summary"));
  console.log(chalk.white("-------"));
  console.log(`Total HAR entries:         ${entries.length}`);
  console.log(`Skipped (BASE_PATH mismatch): ${skippedNoMatch}`);
  console.log(`Unique endpoints:          ${totalUnique}`);
  console.log(`Request examples captured: ${withRequestBody}`);
  console.log(`Response examples captured:${withResponseExample}`);
  console.log(`Tags generated:            ${doc.tags.length}`);
  console.log(
    `Schemas generated:         ${
      Object.keys(doc.components.schemas || {}).length
    }`
  );
  console.log(`Elapsed:                   ${(elapsedMs / 1000).toFixed(2)}s`);
}

try {
  main();
} catch (err) {
  console.error(chalk.red(`Error: ${err?.message || err}`));
  process.exit(1);
}
