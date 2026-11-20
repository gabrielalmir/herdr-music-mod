import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorize,
  challenge,
  callback,
  redirect,
  Session,
} from "../mods/herdr-music/spotify.js";
import {
  seal,
  unseal,
  probe,
  generateVaultCode,
  vaultIterations,
} from "../mods/herdr-music/vendor/herdr-vault/vault.js";
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
for (const pattern of [/not permitted/, /Spotify device/, /Rate limit reached/, /Wait for the rate limit/]) {
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

const password = "$@!$".repeat(128);
const oldVault = await seal(password, "legacy-refresh");
const legacy = { client: "legacy-client" };
for (const field of ["salt", "iv", "data"]) {
  legacy[field] = Buffer.from(oldVault[field], "hex").toString("base64");
}
let requests = 0;
let writes = 0;
let savedMusic;
const legacySession = new Session(
  async value => {
    writes++;
    savedMusic = value;
  },
  async () => {
    requests++;
    return {
      ok: true,
      json: () => ({
        access_token: "access",
        ...(requests > 1 ? { refresh_token: "rotated-refresh" } : {}),
        expires_in: 3600,
      }),
    };
  },
);
await assert.rejects(legacySession.unlock(legacy, password + "$"));
const damaged = { ...legacy, data: (legacy.data[0] === "A" ? "B" : "A") + legacy.data.slice(1) };
await assert.rejects(legacySession.unlock(damaged, password));
assert.equal(requests, 0);
const cancelled = new Error("Cancelled");
let stopped = false;
const runtime = {
  stage() {},
  wait: action => action(),
  check() {
    if (stopped) {
      throw cancelled;
    }
  },
  derive: async () => {
    stopped = true;
    return new Uint8Array(32);
  },
  commit() {
    this.check();
  },
};
await assert.rejects(legacySession.unlock(legacy, password, runtime), cancelled);
assert.equal(requests, 0);
assert.equal(writes, 0);
await legacySession.unlock(legacy, password);
assert.equal(legacySession.refreshToken, "legacy-refresh");
assert.equal(writes, 0);
stopped = false;
runtime.derive = async () => {
  throw Error("Token rotation must reuse the unlocked key.");
};
await legacySession.renew(runtime);
assert.equal(writes, 1);
const upgraded = JSON.parse(savedMusic);
assert.equal(upgraded.version, 2);
assert.equal(upgraded.client, legacy.client);
assert.equal(upgraded.salt, oldVault.salt);
assert.equal(await unseal(password, upgraded), "rotated-refresh");
const home = await mkdtemp(join(tmpdir(), "music-vault-"));
try {
  const clickup = join(home, "mods/clickup-panel");
  await mkdir(clickup, { recursive: true });
  const clickupPath = join(clickup, ".config.json");
  const clickupVault = JSON.stringify(await seal("synthetic-code", "simulated ClickUp profile", 1));
  await writeFile(clickupPath, clickupVault);
  const musicPath = join(home, "herdr-music-vault.json");
  await writeFile(musicPath, savedMusic);
  legacySession.storage = value => writeFile(musicPath, value);
  await legacySession.logout();
  assert.equal(await readFile(musicPath, "utf8"), "");
  assert.equal(await readFile(clickupPath, "utf8"), clickupVault);
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log("Spotify tests passed");
