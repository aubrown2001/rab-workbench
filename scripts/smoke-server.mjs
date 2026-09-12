import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const app = require("../server.js");
const server = app.listen(0, "127.0.0.1");

try {
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const protectedMode = !!(process.env.RAB_USERNAME && process.env.RAB_PASSWORD);
  const authHeader = protectedMode
    ? { authorization: `Basic ${Buffer.from(`${process.env.RAB_USERNAME}:${process.env.RAB_PASSWORD}`).toString("base64")}` }
    : {};

  if (protectedMode) {
    const blocked = await fetch(base + "/");
    if (blocked.status !== 401 || !blocked.headers.get("www-authenticate")) {
      throw new Error("Protected deployment did not require sign-in.");
    }
  }

  const checks = [
    ["/", 200, "RAB Workbench"],
    ["/healthz", 200, '"ok":true'],
    ["/api/models", 200, '"models"'],
    ["/api/reports", 200, '"archive":false'],
  ];

  for (const [path, expectedStatus, expectedText] of checks) {
    const response = await fetch(base + path, { headers: path === "/healthz" ? {} : authHeader });
    const text = await response.text();
    if (response.status !== expectedStatus || !text.includes(expectedText)) {
      throw new Error(`${path} failed: status=${response.status}`);
    }
  }

  const sample = await fetch(base + "/api/sample", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader },
    body: JSON.stringify({ input: "Smoke test", model: "default" }),
  });
  const sampleBody = await sample.json();
  if (sample.status !== 503 || sampleBody?.error?.code !== "not_configured") {
    throw new Error("Model configuration fallback did not behave as expected.");
  }

  const ask = await fetch(base + "/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader },
    body: JSON.stringify({ question: "What is RAB?" }),
  });
  const askBody = await ask.json();
  const expectedAskCode = protectedMode ? "not_configured" : "login_required";
  if (ask.status !== 503 || askBody?.error?.code !== expectedAskCode) {
    throw new Error("Protected Ask ChatGPT fallback did not behave as expected.");
  }

  const check = await fetch(base + "/api/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader },
    body: JSON.stringify({ provider: "gemini", claim: "The sky is blue." }),
  });
  const checkBody = await check.json();
  if (check.status !== 503 || checkBody?.error?.code !== "not_configured") {
    throw new Error("Provider-specific cross-check fallback did not behave as expected.");
  }

  console.log("Server, static app, protected ChatGPT path, capability discovery, reports fallback, model fallback, and cross-check fallback passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
