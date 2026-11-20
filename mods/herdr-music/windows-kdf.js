import { randomBytes, createHash } from "crypto";
import { connect } from "net";
import { appHome, exec } from "herdr";

const CHALLENGE_BYTES = 32;
const FIRST_DYNAMIC_PORT = 49152;
const DYNAMIC_PORT_COUNT = 16384;
const WORKER_TIMEOUT_MS = 6000;
const CONNECT_ATTEMPTS = 45;
const CONNECT_RETRY_MS = 35;
const READ_CHUNK_BYTES = 128;
const MAX_RESPONSE_BYTES = 256;

/** @param {Iterable<number>} bytes */
const hex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
/** @param {Uint8Array} bytes */
function base64(bytes) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const word =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += alphabet[word >>> 18] + alphabet[(word >>> 12) & 63];
    result += i + 1 < bytes.length ? alphabet[(word >>> 6) & 63] : "=";
    result += i + 2 < bytes.length ? alphabet[word & 63] : "=";
  }
  return result;
}

/** @param {Uint8Array} password @param {Uint8Array} salt @param {import("gpui-kit").AsyncContext} cx */
export async function deriveOnWindows(password, salt, cx) {
  const challenge = hex(randomBytes(CHALLENGE_BYTES));
  const entropy = randomBytes(2);
  const port =
    FIRST_DYNAMIC_PORT + ((entropy[0] * 256 + entropy[1]) % DYNAMIC_PORT_COUNT);
  const systemRoot =
    ("env" in process
      ? /** @type {{SystemRoot?: string} | undefined} */ (process.env)
        ?.SystemRoot
      : undefined) || "C:\\Windows";
  const program =
    systemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const worker = exec(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      appHome() + "/mods/herdr-music/vault-kdf.ps1",
      String(port),
      challenge,
    ],
    { timeout: WORKER_TIMEOUT_MS },
  ).then(
    (result) => result.code,
    () => -1,
  );
  /** @type {import("net").Socket | undefined} */
  let socket;
  try {
    for (let tries = 0; tries < CONNECT_ATTEMPTS; tries++) {
      try {
        socket = await connect("127.0.0.1", port);
        break;
      } catch {
        await cx.sleep(CONNECT_RETRY_MS);
      }
    }
    if (!socket) {
      throw Error("O serviço de criptografia do Windows não iniciou.");
    }
    let pending = "";
    const line = async () => {
      while (!pending.includes("\n")) {
        const bytes = await socket.read(READ_CHUNK_BYTES);
        if (!bytes || !bytes.length) {
          throw Error("O serviço de criptografia do Windows se desconectou.");
        }
        pending += String.fromCharCode(...bytes);
        if (pending.length > MAX_RESPONSE_BYTES) {
          throw Error("Resposta inválida da criptografia do Windows.");
        }
      }
      const end = pending.indexOf("\n");
      const value = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      return value;
    };
    /** @param {"server" | "client"} role */
    const proof = (role) =>
      createHash("sha256")
        .update(role + ":" + challenge)
        .digest("hex");
    if ((await line()) !== proof("server")) {
      throw Error(
        "O serviço de criptografia do Windows não pôde ser autenticado.",
      );
    }
    await socket.write(
      proof("client") + "\n" + base64(password) + "\n" + base64(salt) + "\n",
    );
    const key = await line();
    if (!/^[a-f0-9]{64}$/.test(key) || (await worker) !== 0) {
      throw Error("Falha na derivação da chave no Windows.");
    }
    return Uint8Array.from(key.match(/../g), (byte) => parseInt(byte, 16));
  } finally {
    socket?.close();
  }
}
