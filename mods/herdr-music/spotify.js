import { randomBytes, createHash } from "crypto";
import { gcm, pbkdf2, sha256 } from "./vault-crypto.js";

/**
 * @typedef {object} OAuthAttempt
 * @property {string} client
 * @property {string} verifier
 * @property {string} state
 * @property {number} expires
 * @property {string} url
 * @property {boolean} [used]
 */
/**
 * @typedef {object} VaultContents
 * @property {number} [version]
 * @property {string} salt
 * @property {string} iv
 * @property {string} data
 */
/** @typedef {VaultContents & { client: string, generated?: boolean }} PersistedVault */
/** @typedef {(password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>} DeriveKey */
/** @typedef {<T>(operation: () => Promise<T>) => Promise<T>} Wait */
/** @typedef {{derive: DeriveKey, stage: (message: string) => void, wait: Wait}} OperationRuntime */
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

const VAULT_CODE_BYTES = 24;
const PKCE_VERIFIER_BYTES = 48;
const OAUTH_STATE_BYTES = 24;
const OAUTH_ATTEMPT_TTL_MS = 600000;
const PASSWORD_ITERATIONS = 600000;
const GENERATED_CODE_ITERATIONS = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VAULT_VERSION = 2;
const TOKEN_RENEWAL_MARGIN_MS = 30000;
const DEFAULT_RETRY_SECONDS = 60;
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const PLAYER_URL = "https://api.spotify.com/v1/me/player";

/** @type {Wait} */
const withoutTimeout = (operation) => operation();

export const redirect = "http://127.0.0.1:8765/callback";

// Herdr exposes indexed bytes, but its Buffer base64 conversion can return "".
/** @param {Iterable<number>} bytes */
function url64(bytes) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  let bits = 0;
  let pending = 0;
  for (const byte of bytes) {
    pending = (pending << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += alphabet[(pending >>> bits) & 63];
    }
  }
  if (bits) {
    result += alphabet[(pending << (6 - bits)) & 63];
  }
  return result;
}
export const generateVaultCode = () => url64(randomBytes(VAULT_CODE_BYTES));
/** @param {boolean} [generated] */
export const vaultIterations = (generated) =>
  generated ? GENERATED_CODE_ITERATIONS : PASSWORD_ITERATIONS;
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
    throw Error("Falha ao gerar o desafio PKCE.");
  }
  return url64(hex.match(/../g).map((pair) => parseInt(pair, 16)));
}
/** @param {string} client @returns {OAuthAttempt} */
export function authorize(client) {
  if (!/^[a-f\d]{32}$/i.test(client)) {
    throw Error("Confira o Client ID do Spotify.");
  }
  const verifier = url64(randomBytes(PKCE_VERIFIER_BYTES));
  const state = url64(randomBytes(OAUTH_STATE_BYTES));
  if (verifier.length !== 64 || state.length !== 32) {
    throw Error("Falha ao iniciar autorização segura.");
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
    throw Error("Inicie uma nova autorização.");
  }
  const raw = input.trim();
  if (!raw.startsWith(redirect + "?") || raw.includes("#")) {
    throw Error("Endereço de retorno inválido.");
  }
  const params = new Map();
  for (const field of raw.slice(redirect.length + 1).split("&")) {
    const split = field.indexOf("=");
    if (split < 1) {
      throw Error("Retorno inválido.");
    }
    const key = decodeURIComponent(field.slice(0, split));
    if (params.has(key)) {
      throw Error("Parâmetro duplicado.");
    }
    params.set(key, decodeURIComponent(field.slice(split + 1)));
  }
  if (
    params.get("state") !== attempt.state ||
    !params.get("code") ||
    params.has("error")
  ) {
    throw Error("Autorização recusada ou retorno inválido.");
  }
  // Consume a validated callback before the token exchange, even if the exchange fails.
  attempt.used = true;
  return params.get("code");
}
/** @param {Iterable<number>} bytes */
const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** @param {string} value */
function fromHex(value) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{2})+$/.test(value)) {
    throw Error("Cofre inválido.");
  }
  return Uint8Array.from(value.match(/../g), (b) => parseInt(b, 16));
}
/** @param {string} value */
function utf8(value) {
  const bytes = [];
  for (const part of encodeURIComponent(value).match(/%[A-F0-9]{2}|./g) || []) {
    bytes.push(
      part.length === 3 ? parseInt(part.slice(1), 16) : part.charCodeAt(0),
    );
  }
  return Uint8Array.from(bytes);
}
/** @param {string} password @param {Uint8Array} salt @param {number} iterations @param {DeriveKey} [derive] */
function keyFor(password, salt, iterations, derive) {
  const bytes = utf8(password);
  if (derive && iterations === PASSWORD_ITERATIONS) {
    return derive(bytes, salt).finally(() => bytes.fill(0));
  }
  const steps = pbkdf2(sha256, bytes, salt, {
    c: iterations,
    dkLen: KEY_BYTES,
  });
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) {
      return step.value;
    }
  }
}
/** @param {string} password @param {string} token @param {number} [iterations] @param {DeriveKey} [derive] @returns {Promise<VaultContents>} */
export async function seal(
  password,
  token,
  iterations = PASSWORD_ITERATIONS,
  derive,
) {
  const salt = Uint8Array.from(randomBytes(SALT_BYTES));
  const iv = Uint8Array.from(randomBytes(IV_BYTES));
  const key = await keyFor(password, salt, iterations, derive);
  try {
    return {
      version: VAULT_VERSION,
      salt: hex(salt),
      iv: hex(iv),
      data: hex(gcm(key, iv).encrypt(utf8(token))),
    };
  } finally {
    key.fill(0);
  }
}
/** @param {string} password @param {VaultContents} record @param {number} [iterations] @param {DeriveKey} [derive] */
export async function unseal(
  password,
  record,
  iterations = PASSWORD_ITERATIONS,
  derive,
) {
  try {
    /** @param {string} value */
    const decode = (value) =>
      record.version === VAULT_VERSION ? fromHex(value) : legacyBytes(value);
    const key = await keyFor(password, decode(record.salt), iterations, derive);
    try {
      const bytes = gcm(key, decode(record.iv)).decrypt(decode(record.data));
      return decodeURIComponent(
        Array.from(bytes, (b) => "%" + b.toString(16).padStart(2, "0")).join(
          "",
        ),
      );
    } finally {
      key.fill(0);
    }
  } catch {
    throw Error("Senha incorreta ou cofre danificado.");
  }
}
/** @param {string} value */
function legacyBytes(value) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  let bits = 0;
  let pending = 0;
  for (const char of value.replace(/=+$/, "")) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) {
      throw Error("Cofre inválido.");
    }
    pending = (pending << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((pending >>> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}
export async function probe() {
  try {
    const sample = await seal("probe", "ok", 2);
    if ((await unseal("probe", sample, 2)) !== "ok") {
      return false;
    }
    try {
      await unseal("wrong", sample, 2);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}
export class Session {
  /** @param {(value: string) => Promise<void>} storage @param {(url: string, options: ShellFetchOptions) => Promise<SpotifyResponse>} request */
  constructor(storage, request) {
    this.storage = storage;
    this.request = request;
    /** @type {string | null} */
    this.client = null;
    /** @type {string | null} */
    this.password = null;
    /** @type {string | null} */
    this.access = null;
    /** @type {string | null} */
    this.refreshToken = null;
    this.generated = false;
    this.expires = 0;
    this.until = 0;
  }
  /** @param {string} client @param {GrantFields} fields @param {string | null} password @param {OperationRuntime} [runtime] @param {boolean} [generated] */
  async grant(client, fields, password, runtime, generated = false) {
    const wait = runtime?.wait || withoutTimeout;
    runtime?.stage("Trocando o código com o Spotify…");
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
        "Herdr não conseguiu enviar a solicitação ao Spotify. Tente autorizar novamente.",
        { cause: error },
      );
    }
    if (!r.ok) {
      throw Error(
        r.status === 400
          ? "Autorização expirada. Reconecte o Spotify."
          : "Falha na autorização (" + r.status + ").",
      );
    }
    const data = /** @type {TokenResponse} */ (await wait(() => r.json()));
    if (!data.access_token) {
      throw Error("Resposta de autorização inválida.");
    }
    const refresh =
      data.refresh_token ||
      ("refresh_token" in fields ? fields.refresh_token : null);
    if (password && refresh && (data.refresh_token || !this.refreshToken)) {
      runtime?.stage("Protegendo a conta…");
      let vault;
      try {
        vault = await seal(
          password,
          refresh,
          vaultIterations(generated),
          runtime?.derive,
        );
      } catch {
        throw Error(
          "O Herdr não conseguiu proteger a conta. Use o código de desbloqueio para salvar rapidamente.",
        );
      }
      runtime?.stage("Gravando o cofre no Herdr…");
      try {
        await wait(() =>
          this.storage(JSON.stringify({ client, ...vault, generated })),
        );
      } catch {
        throw Error(
          "Spotify aceitou a autorização, mas o Herdr não conseguiu gravar o arquivo do cofre.",
        );
      }
    }
    this.client = client;
    this.password = password;
    this.generated = generated;
    this.refreshToken = refresh;
    this.access = data.access_token;
    this.expires = Date.now() + data.expires_in * 1000;
  }
  /** @param {OperationRuntime} [runtime] */
  async renew(runtime) {
    await this.grant(
      this.client,
      { grant_type: "refresh_token", refresh_token: this.refreshToken },
      this.password,
      runtime,
      this.generated,
    );
  }
  /** @param {string} [path] @param {string} [method] @param {{device_ids: string[], play: boolean}} [payload] @param {OperationRuntime} [runtime] @returns {Promise<unknown>} */
  async api(path = "", method = "GET", payload, runtime) {
    const wait = runtime?.wait || withoutTimeout;
    if (Date.now() < this.until) {
      throw Error("Aguarde o limite de requisições.");
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
      throw Error("Limite de requisições. Aguarde.");
    }
    if (!r.ok) {
      throw Error(
        r.status === 403
          ? "Sem permissão para este controle."
          : r.status === 404
            ? "Inicie a reprodução em um dispositivo Spotify."
            : "Erro do Spotify (" + r.status + ").",
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
      throw Error("Desbloqueie ou conecte sua conta primeiro.");
    }
    runtime.stage("Protegendo a conta com a nova senha…");
    const vault = await seal(
      password,
      this.refreshToken,
      PASSWORD_ITERATIONS,
      runtime.derive,
    );
    await this.storage(
      JSON.stringify({ client: this.client, ...vault, generated: false }),
    );
    this.password = password;
    this.generated = false;
  }
  async logout() {
    await this.storage("");
    this.client = null;
    this.password = null;
    this.access = null;
    this.refreshToken = null;
    this.until = 0;
    this.expires = 0;
  }
}
