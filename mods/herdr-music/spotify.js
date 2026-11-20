import { randomBytes, createHash } from "crypto";
import { seal, unseal, url64, VaultState, vaultIterations } from "./vendor/herdr-vault/vault.js";

/**
 * @typedef {object} OAuthAttempt
 * @property {string} client
 * @property {string} verifier
 * @property {string} state
 * @property {number} expires
 * @property {string} url
 * @property {boolean} [used]
 */
/** @typedef {import("./vendor/herdr-vault/vault.js").VaultRecord & { client: string, generated?: boolean }} PersistedVault */
/** @typedef {<T>(operation: () => Promise<T>) => Promise<T>} Wait */
/** @typedef {import("./vendor/herdr-vault/vault.js").Derivation & {stage: (message: string) => void, wait: Wait, commit: () => void}} OperationRuntime */
/** @typedef {{access_token: string, refresh_token?: string, expires_in: number}} TokenResponse */
/** @typedef {{id: string | null, name: string, is_active: boolean, is_restricted: boolean, supports_volume?: boolean, volume_percent: number | null}} Device */
/** @typedef {Partial<Record<"seeking" | "skipping_prev" | "skipping_next" | "pausing" | "resuming" | "toggling_shuffle" | "toggling_repeat_context" | "toggling_repeat_track", boolean>>} PlaybackRestrictions */
/**
 * @typedef {object} PlayerResponse
 * @property {{name: string, duration_ms: number, artists?: {name: string}[], show?: {name: string}} | null} item
 * @property {Device} [device]
 * @property {{disallows?: PlaybackRestrictions}} [actions]
 * @property {boolean} is_playing
 * @property {boolean} shuffle_state
 * @property {"off" | "context" | "track"} repeat_state
 * @property {number | null} progress_ms
 */
/** @typedef {ShellFetchResponse & {headers?: {get(name: string): string | null}}} SpotifyResponse */
/** @typedef {{grant_type: "authorization_code", code: string, redirect_uri?: string, code_verifier?: string} | {grant_type: "refresh_token", refresh_token: string}} GrantFields */

const PKCE_VERIFIER_BYTES = 48;
const OAUTH_STATE_BYTES = 24;
const OAUTH_ATTEMPT_TTL_MS = 600000;
const TOKEN_RENEWAL_MARGIN_MS = 30000;
const DEFAULT_RETRY_SECONDS = 60;
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const PLAYER_URL = "https://api.spotify.com/v1/me/player";

/** @type {Wait} */
const withoutTimeout = (operation) => operation();

export const redirect = "http://127.0.0.1:8765/callback";

/** @param {Record<string, string>} fields */
const form = (fields) =>
  Object.entries(fields)
    .map(([k, v]) => k + "=" + encodeURIComponent(v))
    .join("&");
/** @param {string} verifier */
export function challenge(verifier) {
  /** @param {Iterable<number>} bytes */
  const hex = createHash("sha256").update(verifier).digest("hex");
  if (typeof hex !== "string" || !/^[a-f0-9]{64}$/.test(hex)) {
    throw Error("Could not generate the PKCE challenge.");
  }
  return url64(hex.match(/../g).map((pair) => parseInt(pair, 16)));
}
/** @param {string} client @returns {OAuthAttempt} */
export function authorize(client) {
  if (!/^[a-f\d]{32}$/i.test(client)) {
    throw Error("Check your Spotify Client ID.");
  }
  const verifier = url64(randomBytes(PKCE_VERIFIER_BYTES));
  const state = url64(randomBytes(OAUTH_STATE_BYTES));
  if (verifier.length !== 64 || state.length !== 32) {
    throw Error("Could not start secure authorization.");
  }
  return {
    client,
    verifier,
    state,
    expires: Date.now() + OAUTH_ATTEMPT_TTL_MS,
    url:
      "https://accounts.spotify.com/authorize?" +
      form({
        client_id: client,
        response_type: "code",
        redirect_uri: redirect,
        state,
        code_challenge: challenge(verifier),
        code_challenge_method: "S256",
        scope:
          "user-read-playback-state user-read-currently-playing user-modify-playback-state",
      }),
  };
}
/** @param {OAuthAttempt | null} attempt @param {string} input @returns {string} */
export function callback(attempt, input) {
  if (!attempt || attempt.used || Date.now() >= attempt.expires) {
    throw Error("Start a new authorization.");
  }
  const raw = input.trim();
  if (!raw.startsWith(redirect + "?") || raw.includes("#")) {
    throw Error("Invalid callback URL.");
  }
  const params = new Map();
  for (const field of raw.slice(redirect.length + 1).split("&")) {
    const split = field.indexOf("=");
    if (split < 1) {
      throw Error("Invalid callback.");
    }
    const key = decodeURIComponent(field.slice(0, split));
    if (params.has(key)) {
      throw Error("Duplicate parameter.");
    }
    params.set(key, decodeURIComponent(field.slice(split + 1)));
  }
  if (
    params.get("state") !== attempt.state ||
    !params.get("code") ||
    params.has("error")
  ) {
    throw Error("Authorization denied or invalid callback.");
  }
  // Consume a validated callback before the token exchange, even if the exchange fails.
  attempt.used = true;
  return params.get("code");
}
export class Session {
  /** @param {(value: string) => Promise<void>} storage @param {(url: string, options: ShellFetchOptions) => Promise<SpotifyResponse>} request */
  constructor(storage, request) {
    this.storage = storage;
    this.request = request;
    /** @type {string | null} */
    this.client = null;
    /** @type {VaultState | null} */
    this.vault = null;
    /** @type {string | null} */
    this.access = null;
    /** @type {string | null} */
    this.refreshToken = null;
    this.generated = false;
    this.expires = 0;
    this.until = 0;
  }
  /** @param {string} client @param {GrantFields} fields @param {string | null} password @param {OperationRuntime} [runtime] @param {boolean} [generated] @param {VaultState} [unlocked] */
  async grant(client, fields, password, runtime, generated = false, unlocked) {
    const wait = runtime?.wait || withoutTimeout;
    runtime?.stage("Exchanging the code with Spotify…");
    let r;
    try {
      r = await wait(() =>
        this.request(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({ client_id: client, ...fields }),
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw error;
      }
      throw Error(
        "Herdr could not send the request to Spotify. Try authorizing again.",
        { cause: error },
      );
    }
    if (!r.ok) {
      throw Error(
        r.status === 400
          ? "Authorization expired. Reconnect Spotify."
          : "Authorization failed (" + r.status + ").",
      );
    }
    const data = /** @type {TokenResponse} */ (await wait(() => r.json()));
    if (!data.access_token) {
      throw Error("Invalid authorization response.");
    }
    const refresh =
      data.refresh_token ||
      ("refresh_token" in fields ? fields.refresh_token : null);
    const state = unlocked ?? (password && refresh ? new VaultState() : null);
    try {
      if (state && refresh && (data.refresh_token || !unlocked)) {
        runtime?.stage("Securing your account…");
        const vault = await seal(password, refresh, vaultIterations(generated), runtime, state);
        runtime?.stage("Saving the vault…");
        runtime?.commit();
        try {
          await this.storage(JSON.stringify({ client, ...vault, generated }));
        } catch {
          throw Error(
            "Spotify accepted the authorization, but Herdr could not write the vault file.",
          );
        }
      }
      runtime?.check?.();
    } catch (error) {
      if (state !== this.vault) {
        state?.close();
      }
      throw error;
    }
    if (this.vault !== state) {
      this.vault?.close();
    }
    this.vault = state;
    this.client = client;
    this.generated = generated;
    this.refreshToken = refresh;
    this.access = data.access_token;
    this.expires = Date.now() + data.expires_in * 1000;
  }
  /** @param {PersistedVault} record @param {string} password @param {OperationRuntime} [runtime] */
  async unlock(record, password, runtime) {
    const state = new VaultState();
    const generated = record.generated === true;
    try {
      const token = await unseal(password, record, vaultIterations(generated), runtime, state, { legacy: true });
      await this.grant(record.client, { grant_type: "refresh_token", refresh_token: token }, null, runtime, generated, state);
    } finally {
      if (this.vault !== state) {
        state.close();
      }
    }
  }

  /** @param {OperationRuntime} [runtime] */
  async renew(runtime) {
    await this.grant(
      this.client,
      { grant_type: "refresh_token", refresh_token: this.refreshToken },
      null,
      runtime,
      this.generated,
      this.vault,
    );
  }
  /** @param {string} [path] @param {string} [method] @param {{device_ids: string[], play: boolean}} [payload] @param {OperationRuntime} [runtime] @returns {Promise<unknown>} */
  async api(path = "", method = "GET", payload, runtime) {
    const wait = runtime?.wait || withoutTimeout;
    if (Date.now() < this.until) {
      throw Error("Wait for the rate limit to reset.");
    }
    if (Date.now() + TOKEN_RENEWAL_MARGIN_MS >= this.expires) {
      await this.renew(runtime);
    }
    const send = () =>
      this.request(PLAYER_URL + path, {
        method,
        headers: {
          Authorization: "Bearer " + this.access,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    let r = await wait(send);
    if (r.status === 401) {
      await this.renew(runtime);
      r = await wait(send);
    }
    if (r.status === 429) {
      this.until =
        Date.now() +
        1000 *
          Math.max(
            1,
            Number(r.headers?.get?.("Retry-After")) || DEFAULT_RETRY_SECONDS,
          );
      throw Error("Rate limit reached. Try again later.");
    }
    if (!r.ok) {
      throw Error(
        r.status === 403
          ? "This control is not permitted."
          : r.status === 404
            ? "Start playback on a Spotify device."
            : "Spotify error (" + r.status + ").",
      );
    }
    return r.status === 204 || method !== "GET" ? null : wait(() => r.json());
  }
  /** @param {string} path @param {OperationRuntime} runtime @returns {Promise<PlayerResponse | null>} */
  async playback(path, runtime) {
    return /** @type {PlayerResponse | null} */ (
      await this.api(path, "GET", undefined, runtime)
    );
  }

  /** @param {OperationRuntime} runtime @returns {Promise<Device[] | undefined>} */
  async devices(runtime) {
    const result = /** @type {{devices?: Device[]}} */ (
      await this.api("/devices", "GET", undefined, runtime)
    );
    return result.devices;
  }

  /** @param {string} password @param {OperationRuntime} runtime */
  async changePassword(password, runtime) {
    if (!this.refreshToken) {
      throw Error("Unlock or connect your account first.");
    }
    runtime.stage("Securing your account with the new password…");
    const state = new VaultState();
    try {
      const vault = await seal(password, this.refreshToken, vaultIterations(false), runtime, state);
      runtime.commit();
      await this.storage(JSON.stringify({ client: this.client, ...vault, generated: false }));
    } catch (error) {
      state.close();
      throw error;
    }
    this.vault?.close();
    this.vault = state;
    this.generated = false;
  }
  async logout() {
    await this.storage("");
    this.client = null;
    this.vault?.close();
    this.vault = null;
    this.generated = false;
    this.access = null;
    this.refreshToken = null;
    this.until = 0;
    this.expires = 0;
  }
}
