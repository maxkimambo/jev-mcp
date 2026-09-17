// Live end-to-end tests against the real TypeSafe API.
//
// Skipped unless a credential is present in the environment, so `npm test` on a
// clean checkout and in CI never depends on network access or spends tokens.
// Run with: npm run test:e2e

import assert from "node:assert/strict";
import test from "node:test";
import { payload, withClient } from "./helpers.mjs";

const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");
const hasKey = Boolean(process.env[KEY_VAR]);
const options = { skip: hasKey ? false : `set ${KEY_VAR} to run live tests` };

/** Forward the real credential to the server under test. */
function live(fn) {
  return withClient({ withKey: false, env: { [KEY_VAR]: process.env[KEY_VAR] } }, fn);
}

test("the key works and lists at least one model", options, async () => {
  await live(async (client) => {
    const body = payload(await client.callTool({ name: "jev_models", arguments: {} }));
    assert.ok(body.models.length >= 1, "expected at least one available model");
  });
});

test("classify routes a support ticket to the right team", options, async () => {
  await live(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_classify",
        arguments: {
          state: "My running shoes arrived in the wrong size. Can I swap them for a size 10?",
          question: "Which team should handle this?",
          options: {
            returns: "Exchanges, refunds, wrong or damaged items",
            shipping: "Delivery status, delays, lost packages",
            billing: "Charges, invoices, payment problems",
          },
        },
      }),
    );
    assert.equal(body.choice, "returns");
    assert.ok(body.confidence > 0 && body.confidence <= 1);
    assert.ok(Object.keys(body.probabilities).includes("none"));
  });
});

test("check returns a high probability for a plainly urgent message", options, async () => {
  await live(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_check",
        arguments: {
          state: "Help! My payouts have been failing for 3 days and customers are complaining.",
          question: "Does this convey urgency?",
        },
      }),
    );
    assert.ok(body.probability_yes > 0.5, `expected an urgent read, got ${body.probability_yes}`);
    assert.equal(body.verdict, "yes");
  });
});

test("ask answers several questions about one state in a single request", options, async () => {
  await live(async (client) => {
    const body = payload(
      await client.callTool({
        name: "jev_ask",
        arguments: {
          state: "I was charged twice for order A-104. Please refund the duplicate.",
          questions: [
            { id: "billing", type: "check", question: "Is this about billing?" },
            { id: "refund", type: "check", question: "Is the customer asking for a refund?" },
            { id: "anger", type: "score", question: "How frustrated is the customer?", levels: ["Calm", "Frustrated", "Very angry"] },
          ],
        },
      }),
    );
    assert.ok(body.answers.billing.noul > 0.5);
    assert.ok(body.answers.refund.noul > 0.5);
    assert.ok(typeof body.answers.anger.score === "number");
    assert.ok(body.usage.input_tokens > 0);
  });
});
