import assert from "node:assert/strict";
import {
  authorize,
  challenge,
  callback,
  redirect,
  seal,
  unseal,
  probe,
  generateVaultCode,
  vaultIterations,
  Session,
} from "../mods/herdr-music/spotify.js";
assert.equal(
  challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
);
const attempt = () => authorize("a".repeat(32));
const a = attempt();
const url = redirect + "?code=c&state=" + a.state;
assert.throws(() => callback(a, "https://example.org/"));
assert.equal(callback(a, url), "c");
assert.throws(() => callback(a, url));
for (const bad of [
  url.replace("callback", "callback/"),
  url + "#fragment",
  url + "&code=c",
  url.replace(a.state, "invalid"),
]) {
  assert.throws(() => callback({ ...a, used: false }, bad));
}
assert.throws(() => callback({ ...a, used: false, expires: 0 }, url));
assert.ok(await probe());
const vault = await seal("password", "secret");
assert.equal(await unseal("password", vault), "secret");
await assert.rejects(unseal("bad", vault));
await assert.rejects(
  unseal("password", {
    ...vault,
    data: vault.data.startsWith("A")
      ? "B" + vault.data.slice(1)
      : "A" + vault.data.slice(1),
  }),
);
let persisted;
let statuses = [401, 204, 403, 404, 429];
let grants = 0;
const session = new Session(
  async (v) => (persisted = v),
  async (url, options) => {
    if (url.includes("accounts.spotify")) {
      grants++;
      if (grants > 1) {
        assert.match(options.body, /refresh_token=r1/);
      }
      return {
        ok: true,
        json: () => ({
          access_token: "a" + grants,
          refresh_token: "r" + grants,
          expires_in: 3600,
        }),
      };
    }
    const status = statuses.shift();
    return { status, ok: status === 204 };
  },
);
await session.grant(
  "client",
  { grant_type: "authorization_code", code: "c" },
  "password",
);
await session.api();
assert.equal(await unseal("password", JSON.parse(persisted)), "r2");
for (const pattern of [/permissão/, /dispositivo/, /Limite/, /Aguarde/]) {
  await assert.rejects(session.api(), pattern);
}
await session.logout();
assert.equal(persisted, "");
assert.equal(session.access, null);
assert.equal(session.refreshToken, null);
const code = generateVaultCode();
assert.match(code, /^[A-Za-z0-9_-]{32}$/);
await session.grant(
  "client",
  { grant_type: "refresh_token", refresh_token: "r1" },
  code,
  undefined,
  true,
);
const fastVault = JSON.parse(persisted);
assert.equal(fastVault.generated, true);
assert.equal(
  await unseal(code, fastVault, vaultIterations(fastVault.generated)),
  "r3",
);
console.log("Spotify tests passed");
