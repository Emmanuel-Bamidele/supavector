const assert = require("assert/strict");

const { __testHooks } = require("../security");

function req(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    header(name) {
      return normalized[String(name).toLowerCase()];
    }
  };
}

const token = "supav_test_service_token";

assert.equal(__testHooks.extractApiKey(req({ "x-api-key": token })), token);
assert.equal(__testHooks.extractApiKey(req({ authorization: `ApiKey ${token}` })), token);
assert.equal(__testHooks.extractApiKey(req({ authorization: `apikey ${token}` })), token);
assert.equal(__testHooks.extractApiKey(req({ authorization: `Bearer ${token}` })), token);
assert.equal(__testHooks.extractApiKey(req({ authorization: `bearer ${token}` })), token);
assert.equal(__testHooks.extractApiKey(req({ authorization: `Bearer   ${token}` })), token);
assert.equal(__testHooks.extractApiKey(req({ authorization: `Bearer ${token} trailing` })), null);
assert.equal(
  __testHooks.extractApiKey(req({ "x-api-key": token, authorization: "Bearer another" })),
  token,
  "X-API-Key must keep precedence when both supported headers are present"
);
assert.equal(__testHooks.extractApiKey(req({ authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" })), null);
assert.equal(__testHooks.extractApiKey(req({ authorization: "Bearer unprefixed-service-token" })), null);
assert.equal(__testHooks.extractApiKey(req({ authorization: "Bearer" })), null);
assert.equal(__testHooks.extractApiKey(req()), null);

console.log("security tests passed");
