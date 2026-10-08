import net from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const LOCAL_ENDPOINTS = Object.freeze([
  { name: "PostgreSQL", host: "127.0.0.1", port: 5432 },
  { name: "Temporal gRPC", host: "127.0.0.1", port: 7233 },
  { name: "Vendure Dashboard", url: "http://127.0.0.1:3001/dashboard" },
  { name: "Integration Gateway", url: "http://127.0.0.1:3002/health" },
  { name: "OpenSearch", url: "http://127.0.0.1:9200/" },
  { name: "Knowledge/RAG", url: "http://127.0.0.1:8001/health" },
  { name: "Agent Runtime", url: "http://127.0.0.1:8000/health" },
  { name: "Conversation Runtime", url: "http://127.0.0.1:3004/health" },
  { name: "Human Operations", url: "http://127.0.0.1:3003/health" },
  { name: "Edge API", url: "http://127.0.0.1:3000/health" },
  { name: "Temporal UI", url: "http://127.0.0.1:8233/" },
  { name: "Customer Portal", url: "http://127.0.0.1:3100/sign-in" },
  { name: "Operations Console", url: "http://127.0.0.1:3101/sign-in" },
]);

export function classifyProbeResult(result) {
  if (result.kind === "connected") return { status: "healthy" };
  if (result.kind === "http") {
    if (result.status >= 200 && result.status < 300) return { status: "healthy" };
    if (result.status >= 500 && result.status < 600) return { status: "down" };
    return { status: "unknown" };
  }
  if (result.kind === "error" && result.code === "ECONNREFUSED") return { status: "down" };
  return { status: "unknown" };
}

export async function checkLocalStack({
  endpoints = LOCAL_ENDPOINTS,
  httpProbe = probeHttp,
  tcpProbe = probeTcp,
  tokens = {
    customer: { state: "missing" },
    refundStaff: { state: "missing" },
    deliveryStaff: { state: "missing" },
    chatSupport: { state: "missing" },
  },
}) {
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    let probeResult;
    try {
      probeResult = endpoint.url
        ? await httpProbe(endpoint.url)
        : await tcpProbe(endpoint.host, endpoint.port);
    } catch (error) {
      probeResult = { kind: "error", code: safeErrorCode(error) };
    }
    return {
      name: endpoint.name,
      target: endpoint.url ?? `${endpoint.host}:${endpoint.port}`,
      ...classifyProbeResult(probeResult),
    };
  }));

  return { endpoints: results, tokens };
}

export function inspectLocalToken(token, nowMs = Date.now()) {
  if (typeof token !== "string" || token.length === 0) return { state: "missing" };

  try {
    const segments = token.split(".");
    if (segments.length !== 3) return { state: "unverified" };
    const header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (header?.alg !== "HS256" || typeof claims?.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0) {
      return { state: "unverified" };
    }

    const secondsRemaining = Math.floor(claims.exp - nowMs / 1000);
    return {
      state: secondsRemaining <= 0 ? "expired-unverified" : "unverified",
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      secondsRemaining,
    };
  } catch {
    return { state: "unverified" };
  }
}

export function effectiveEnvValue(key, { processEnv = {}, localEnv = "", baseEnv = "" } = {}) {
  const processValue = processEnv[key];
  if (typeof processValue === "string" && processValue.length > 0) return processValue;
  return parseEnvValue(localEnv, key) ?? parseEnvValue(baseEnv, key);
}

export function formatReadinessReport(report) {
  const lines = report.endpoints.map(({ name, target, status }) =>
    `${name}${target ? ` (${target})` : ""}: ${status}`,
  );
  lines.push(`Customer token: ${formatTokenMetadata(report.tokens.customer)}`);
  lines.push(`Refund staff token: ${formatTokenMetadata(report.tokens.refundStaff)}`);
  lines.push(`Delivery staff token: ${formatTokenMetadata(report.tokens.deliveryStaff)}`);
  lines.push(`Chat support staff token: ${formatTokenMetadata(report.tokens.chatSupport)}`);
  lines.push("Token expiry metadata is unverified; signatures are not checked.");
  return lines.join("\n");
}

export async function readLocalTokens({
  repositoryRoot = REPOSITORY_ROOT,
  processEnv = process.env,
  readText = readOptionalText,
  nowMs = Date.now(),
} = {}) {
  const [customerLocal, customerBase, staffLocal, staffBase] = await Promise.all([
    readText(resolve(repositoryRoot, "apps/web/customer-portal/.env.local")),
    readText(resolve(repositoryRoot, "apps/web/customer-portal/.env")),
    readText(resolve(repositoryRoot, "apps/web/operations-console/.env.local")),
    readText(resolve(repositoryRoot, "apps/web/operations-console/.env")),
  ]);

  const staffEnv = { localEnv: staffLocal, baseEnv: staffBase };
  return {
    customer: inspectLocalToken(effectiveEnvValue("CSO_LOCAL_CUSTOMER_TOKEN", {
      processEnv,
      localEnv: customerLocal,
      baseEnv: customerBase,
    }), nowMs),
    refundStaff: inspectLocalToken(effectiveEnvValue("CSO_LOCAL_HUMAN_TOKEN", {
      processEnv,
      ...staffEnv,
    }), nowMs),
    deliveryStaff: inspectLocalToken(effectiveEnvValue("CSO_LOCAL_DELIVERY_STAFF_TOKEN", {
      processEnv,
      ...staffEnv,
    }), nowMs),
    chatSupport: inspectLocalToken(effectiveEnvValue("CSO_LOCAL_SUPPORT_STAFF_TOKEN", {
      processEnv,
      ...staffEnv,
    }), nowMs),
  };
}

async function probeHttp(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    return { kind: "http", status: response.status };
  } catch (error) {
    return { kind: "error", code: safeErrorCode(error) };
  } finally {
    clearTimeout(timer);
  }
}

function probeTcp(host, port, timeoutMs = 1_500) {
  return new Promise((resolveResult) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolveResult(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ kind: "error", code: "ETIMEDOUT" }));
    socket.once("connect", () => finish({ kind: "connected" }));
    socket.once("error", (error) => finish({ kind: "error", code: safeErrorCode(error) }));
  });
}

function parseEnvValue(contents, key) {
  const prefix = `${key}=`;
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("export ")) {
      const exported = trimmed.slice("export ".length).trim();
      if (exported.startsWith(prefix)) return stripEnvQuotes(exported.slice(prefix.length).trim());
    } else if (trimmed.startsWith(prefix)) {
      return stripEnvQuotes(trimmed.slice(prefix.length).trim());
    }
  }
  return undefined;
}

function stripEnvQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function formatTokenMetadata(metadata) {
  if (!metadata || metadata.state === "missing") return "missing";
  if (!metadata.expiresAt) return "unverified (expiry unavailable)";
  const state = metadata.state === "expired-unverified" ? "expired-unverified" : "unverified";
  return `${state}; expiry ${metadata.expiresAt}; ${metadata.secondsRemaining}s remaining`;
}

function safeErrorCode(error) {
  return typeof error?.code === "string" ? error.code : "UNKNOWN";
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function isDirectExecution(moduleUrl) {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectExecution(import.meta.url)) {
  const tokens = await readLocalTokens();
  const report = await checkLocalStack({ tokens });
  console.log(formatReadinessReport(report));
  if (report.endpoints.some(({ status }) => status !== "healthy")) process.exitCode = 1;
}
