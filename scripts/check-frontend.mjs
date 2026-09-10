import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

if (!scripts.length) {
  throw new Error("No inline application script found in public/index.html");
}

for (const [index, match] of scripts.entries()) {
  new Script(match[1], { filename: `public/index.html:inline-script-${index + 1}.js` });
}

console.log(`Checked ${scripts.length} inline application script${scripts.length === 1 ? "" : "s"}.`);
