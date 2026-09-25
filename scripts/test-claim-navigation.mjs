import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const activity of [null, "research", "homework"]) {
  for (const status of ["verified", "unsupported", "refuted", "opinion"]) {
    for (const nextSelector of ["#claim-next", '[data-act="next-claim"]']) {
      const dom = new JSDOM(html.replace(/<style>[\s\S]*?<\/style>/g, ""), { url: "http://localhost", runScripts: "outside-only", pretendToBeVisual: true });
      const { window } = dom;
      window.fetch = async () => ({ json: async () => ({ models: [] }) });
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.scrollTo = () => {};
      window.eval(source.replace(/\}\)\(\);\s*$/, 'window.testApp={S,renderLedger};})();'));
      await new Promise(resolve => setTimeout(resolve, 0));
      const { S, renderLedger } = window.testApp;
      S.wiz.path = "ask";
      S.wiz.claimIndex = 0;
      S.student = activity ? { activity, claimIndex: 0 } : null;
      S.claims = ["First claim", "Second claim", "Third claim"].map((text, i) => ({
        id: `claim-${i}`, text, status: "unverified", checks: { claim: true, independent: false }, aiChecks: {}, queries: [], note: "", url: ""
      }));
      renderLedger();
      const query = selector => window.document.querySelector(selector);
      assert.equal(query(nextSelector).disabled, true);
      query(`[data-act="status"][data-v="${status}"]`).click();
      assert.equal(query(`[data-v="${status}"]`).getAttribute("aria-pressed"), "true");
      assert.equal(query(nextSelector).disabled, false);
      query(nextSelector).click();
      assert.equal(query("#claim-progress").textContent, "Claim 2 of 3");
      assert.equal(S.claims[0].status, status);
      assert.equal(S.claims[1].status, "unverified");
      assert.match(query('.research-choice-note').textContent, /Claim 2 is awaiting your review/);
      assert.equal(query('.research-choice-note').classList.contains('required'), false);
      query("#claim-prev").click();
      assert.equal(query(`[data-v="${status}"]`).getAttribute("aria-pressed"), "true");
      dom.window.close();
    }
  }
}
console.log("Claim navigation: all four dispositions persist across both Next controls and Previous in Ask AI, Research, and Homework.");
