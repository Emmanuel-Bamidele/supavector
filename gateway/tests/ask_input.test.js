const assert = require("assert/strict");

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || "ask-input-test-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "ask-input-test-jwt-secret";

const { __testHooks } = require("../index");

function testAskHistoryParsing() {
  assert.deepEqual(__testHooks.parseAskHistoryInput(undefined), []);
  assert.deepEqual(__testHooks.parseAskHistoryInput([
    { role: " user ", text: " First turn " },
    { role: "ASSISTANT", text: "Second turn" },
    { role: "user", text: "   " }
  ]), [
    { role: "user", text: "First turn" },
    { role: "assistant", text: "Second turn" }
  ]);

  const long = __testHooks.parseAskHistoryInput([
    { role: "user", text: "x".repeat(2100) }
  ]);
  assert.equal(long[0].text.length, 2000);

  assert.throws(() => __testHooks.parseAskHistoryInput({}), /history must be an array/);
  const bounded = __testHooks.parseAskHistoryInput(
    Array.from({ length: 13 }, (_, index) => ({ role: "user", text: `turn-${index + 1}` }))
  );
  assert.equal(bounded.length, 12);
  assert.equal(bounded[0].text, "turn-2");
  assert.equal(bounded.at(-1).text, "turn-13");
  assert.throws(
    () => __testHooks.parseAskHistoryInput(Array.from({ length: 161 }, () => ({ role: "user", text: "x" }))),
    /at most 160 turns/
  );
  assert.throws(() => __testHooks.parseAskHistoryInput([null]), /turns must be objects/);
  assert.throws(() => __testHooks.parseAskHistoryInput([{ role: "system", text: "x" }]), /roles must be user or assistant/);
  assert.throws(() => __testHooks.parseAskHistoryInput([{ role: "user", text: { nested: true } }]), /text must be a string/);
}

function testAskBackgroundParsing() {
  assert.equal(__testHooks.parseAskBackgroundInput(undefined), null);
  assert.equal(__testHooks.parseAskBackgroundInput("  visitor clock  "), "visitor clock");
  assert.throws(() => __testHooks.parseAskBackgroundInput({}), /background must be a string/);
  assert.throws(() => __testHooks.parseAskBackgroundInput("x".repeat(601)), /600 characters or fewer/);
}

function testV1RouteFallbackStaysJsonWithoutBreakingOptions() {
  let nextCalled = false;
  __testHooks.handleV1RouteNotFound({ method: "OPTIONS" }, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, "OPTIONS must continue to Express method discovery");

  let status = null;
  let payload = null;
  const res = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    }
  };
  __testHooks.handleV1RouteNotFound({
    method: "POST",
    originalUrl: "/v1/not-a-real-route?ignored=1"
  }, res, () => {});
  assert.equal(status, 404);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "ROUTE_NOT_FOUND");
  assert.match(payload.error.message, /No POST handler for \/v1\/not-a-real-route/);
  assert.doesNotMatch(payload.error.message, /ignored/);
}

async function main() {
  testAskHistoryParsing();
  testAskBackgroundParsing();
  testV1RouteFallbackStaysJsonWithoutBreakingOptions();
  console.log("ask input tests passed");
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
