import { View, div, svg } from "gpui-kit";
import {
  h_flex,
  v_flex,
  Input,
  InputState,
  Slider,
  SliderTrack,
  SliderThumb,
  SliderState,
  SliderIndicator,
} from "gpui-base";
import {
  theme,
  appHome,
  readTextFile,
  writeTextFile,
  run,
  checking,
  nextCommand,
} from "herdr";
import { deriveOnWindows } from "./vendor/herdr-vault/windows-kdf.js";
import { generateVaultCode, probe } from "./vendor/herdr-vault/vault.js";
import {
  authorize,
  callback,
  redirect,
  Session,
} from "./spotify.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").AsyncContext} AsyncContext */
/** @typedef {Record<string, `#${string}`>} Theme */
/** @typedef {ReturnType<typeof v_flex>} Panel */
/** @typedef {import("./spotify.js").OperationRuntime} OperationRuntime */
/** @typedef {import("./spotify.js").Device} Device */
/**
 * @typedef {object} Playback
 * @property {string} title
 * @property {string} [artist]
 * @property {boolean} playing
 * @property {number} measured
 * @property {string} [device]
 * @property {boolean} [restricted]
 * @property {number | null} [volume]
 * @property {import("./spotify.js").PlaybackRestrictions} disallows
 * @property {number | null} progress
 * @property {number} duration
 * @property {boolean} shuffle
 * @property {"off" | "context" | "track"} repeat
 */

// Copies use one private service. Only presentation data goes into Herdr shared state.
/** @type {Session} */
let service;
/** @type {Promise<void> | null} */
let ready;
/** @type {boolean} */
let cryptoOK;
/** @type {string | null} */
let saved;
let running = false;

const SEEK_SCALE = 1000;
const PROGRESS_INTERVAL_MS = 1000;
const PLAYER_POLL_INTERVAL_MS = 15000;
const OPERATION_TIMEOUT_MS = 20000;

/** @param {string} name */
const icon = (name) => "mods/herdr-music/icons/" + name + ".svg";
/** @param {string} name */
const shellIcon = (name) => "mods/workspace-chrome/" + name + ".svg";
/** @param {unknown} error */
const errorMessage = (error) =>
  (error instanceof Error && error.message) || "The operation failed.";
/** @param {number} ms */
const timeLabel = (ms) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};
/** @param {SliderState} state @param {Theme} t */
function bar(state, t) {
  return Slider.new(state)
    .w_full()
    .child(
      SliderTrack.new(state)
        .flex()
        .items_center()
        .h(24)
        .w_full()
        .child(
          SliderIndicator.new(state)
            .relative()
            .w_full()
            .h(5)
            .rounded(3)
            .bg(t.raised)
            .range_style((fill) => fill.rounded(3).bg(t.accent))
            .child(
              SliderThumb.new(state).size(12).rounded(6).bg(t.accent).ml(-6),
            ),
        ),
    );
}
function initialize() {
  if (!ready) {
    ready = (async () => {
      const file = appHome() + "/data/herdr-music-vault.json";
      saved = await readTextFile(file);
      cryptoOK = await probe();
      service = new Session(async (value) => {
        // Use the last read or written snapshot to avoid overwriting a vault changed by another copy.
        await writeTextFile(file, value, saved);
        saved = value;
      }, fetch);
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
export default class Music extends View {
  /** @param {import("gpui-shell").Props | undefined} _ @param {AsyncContext} cx */
  init(_, cx) {
    this.settings = false;
    this.manualPassword = false;
    this.copiedCode = false;
    this.revealClient = false;
    this.changingPassword = false;
    /** @type {import("./spotify.js").OAuthAttempt | null} */
    this.attempt = null;
    /** @type {string | null} */
    this.generatedCode = null;
    /** @type {string | null} */
    this.stage = null;
    /** @type {(() => void) | null} */
    this.cancelOperation = null;
    this.message = "";
    /** @type {"seek" | "volume" | null} */
    this.drag = null;
    /** @type {Playback | null} */
    this.track = null;
    /** @type {Device[] | undefined} */
    this.devices = undefined;
    this.client = InputState.new({ placeholder: "Spotify Client ID" });
    this.client.set_masked(true);
    this.password = InputState.new({ placeholder: "Local vault password" });
    this.password.set_masked(true);
    this.url = InputState.new({ placeholder: "Paste the final URL here" });
    this.url.set_masked(true);
    this.url.on("submit", (_, cx) => this.finishConnection(cx));
    this.seek = SliderState.new({ max: SEEK_SCALE });
    this.volume = SliderState.new();
    this.bindSlider(this.seek, "seek");
    this.bindSlider(this.volume, "volume");
    if (checking()) {
      return;
    }
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "configure") {
          this.settings = true;
          cx.notify();
        }
      }
    });
    cx.timer.every(PROGRESS_INTERVAL_MS, (cx) => {
      if (this.track?.playing && !this.settings && !this.drag) {
        this.syncBars();
        cx.notify();
      }
    });
    this.task(cx, async (runtime) => {
      await initialize();
      if (service.access) {
        await this.refresh(runtime);
      }
    });
    cx.timer.every(PLAYER_POLL_INTERVAL_MS, (cx) => {
      if (service?.access) {
        this.task(cx, (runtime) => this.refresh(runtime));
      }
    });
  }
  /** @param {Context} cx @param {(runtime: OperationRuntime) => Promise<void>} work */
  task(cx, work) {
    if (running) {
      return;
    }
    running = true;
    // The event context expires when its handler returns. Use the spawned context across awaits.
    cx.spawn(async (cx) => {
      let cancelled = false;
      /** @type {(error: Error) => void} */
      let stop;
      const stopped = new Promise((_, reject) => {
        stop = reject;
      });
      stopped.catch(() => {});
      const cancelError = Error("Operation cancelled.");
      function check() {
        if (cancelled) {
          throw cancelError;
        }
      }
      this.cancelOperation = () => {
        cancelled = true;
        stop(cancelError);
      };
      /**
       * @template T
       * @param {() => Promise<T>} operation
       * @returns {Promise<T>}
       */
      async function wait(operation) {
        /** @type {import("gpui-kit").Task | undefined} */
        let timeout;
        try {
          check();
          return await Promise.race([
            operation(),
            stopped,
            new Promise((_, reject) => {
              timeout = cx.timer.after(OPERATION_TIMEOUT_MS, () => {
                const error = new Error(
                  "The service timed out. Try again.",
                );
                error.name = "TimeoutError";
                reject(error);
              });
            }),
          ]);
        } finally {
          timeout?.cancel();
        }
      }

      /** @type {OperationRuntime} */
      const runtime = {
        wait,
        check,
        commit: () => {
          check();
          this.cancelOperation = null;
          cx.notify();
        },
        derive: (password, salt) =>
          deriveOnWindows(password, salt, cx, appHome() + "/mods/herdr-music/vendor/herdr-vault/vault-kdf.ps1", {
            check,
            wait: (work) => wait(() => work),
          }),
        stage: (message) => {
          this.stage = message;
          cx.notify();
        },
      };

      try {
        this.message = "";
        await work(runtime);
      } catch (error) {
        this.message = errorMessage(error);
      } finally {
        this.stage = null;
        this.cancelOperation = null;
        running = false;
        cx.notify();
      }
    });
  }
  /** @param {Context} cx */
  finishConnection(cx) {
    if (running) {
      return;
    }
    const attempt = this.attempt;
    const password = this.manualPassword
      ? this.password.value()
      : this.generatedCode;
    const input = this.url.value();
    let code;
    try {
      if (cryptoOK && this.manualPassword && !password?.trim()) {
        throw Error("Enter your local vault password to finish.");
      }
      if (cryptoOK && !this.manualPassword && !this.copiedCode) {
        throw Error("Copy and save the unlock code to finish.");
      }
      if (!input.trim()) {
        throw Error("Paste the full Spotify callback URL.");
      }
      code = callback(attempt, input);
    } catch (error) {
      this.message = errorMessage(error);
      cx.notify();
      return;
    }
    const generated = !this.manualPassword && !!password;
    this.generatedCode = null;
    this.copiedCode = false;
    this.attempt = null;
    this.url.set_value("");
    this.password.set_value("");
    this.task(cx, async (runtime) => {
      await service.grant(
        attempt.client,
        {
          grant_type: "authorization_code",
          redirect_uri: redirect,
          code,
          code_verifier: attempt.verifier,
        },
        cryptoOK ? password : null,
        runtime,
        generated,
      );
      this.settings = false;
      runtime.stage("Checking playback…");
      await this.refresh(runtime);
    });
  }
  /** @param {OperationRuntime} runtime */
  async refresh(runtime) {
    let p = await service.playback("?additional_types=track,episode", runtime);
    if (!p?.item) {
      const current = await service.playback(
        "/currently-playing?additional_types=track,episode",
        runtime,
      );
      if (current?.item) {
        const device =
          p?.device ||
          (await service.devices(runtime))?.find((d) => d.is_active);
        p = { ...p, ...current, device };
      }
    }
    this.track = p?.item
      ? {
        title: p.item.name,
        artist:
            p.item.artists?.map((a) => a.name).join(", ") || p.item.show?.name,
        playing: p.is_playing,
        measured: Date.now(),
        device: p.device?.name,
        restricted: p.device?.is_restricted,
        volume:
            p.device?.supports_volume !== false
              ? p.device?.volume_percent
              : null,
        disallows: p.actions?.disallows || {},
        progress: p.progress_ms,
        duration: p.item.duration_ms,
        shuffle: p.shuffle_state,
        repeat: p.repeat_state,
      }
      : null;
    this.syncBars();
  }
  position() {
    const p = this.track;
    return Math.min(
      p.duration,
      (p.progress || 0) + (p.playing ? Date.now() - p.measured : 0),
    );
  }
  syncBars() {
    const p = this.track;
    if (p?.duration && this.drag !== "seek") {
      this.seek.set_value(
        Math.round((SEEK_SCALE * this.position()) / p.duration),
      );
    }
    if (p?.volume != null && this.drag !== "volume") {
      this.volume.set_value(p.volume);
    }
  }

  /** @param {SliderState} state @param {"seek" | "volume"} type */
  bindSlider(state, type) {
    state.on("change", () => {
      this.drag = type;
    });
    state.on("release", (value, cx) => {
      this.drag = null;
      const p = this.track;
      if (!p || p.restricted || typeof value !== "number") {
        return;
      }
      const path =
        type === "seek"
          ? "/seek?position_ms=" +
            Math.min(
              p.duration - 1,
              Math.round((value * p.duration) / SEEK_SCALE),
            )
          : "/volume?volume_percent=" + Math.round(value);
      this.controlPlayback(cx, path, "PUT");
    });
  }

  /** @param {Context} cx @param {string} path @param {string} method */
  controlPlayback(cx, path, method) {
    this.task(cx, async (runtime) => {
      await service.api(path, method, undefined, runtime);
      await this.refresh(runtime);
    });
  }

  /** @param {Context} cx */
  startAuthorization(cx) {
    try {
      if (!service) {
        throw Error("Wait for the mod to finish initializing.");
      }
      if (running) {
        return;
      }
      this.url.set_value("");
      this.attempt = authorize(this.client.value().trim());
      this.generatedCode = cryptoOK ? generateVaultCode() : null;
      this.copiedCode = false;
      this.revealClient = false;
      this.client.set_masked(true);
      cx.open_url(this.attempt.url);
      this.message = "";
    } catch (error) {
      this.message = errorMessage(error);
    }
    cx.notify();
  }

  /** @param {Context} cx */
  unlock(cx) {
    this.task(cx, async (runtime) => {
      /** @type {import("./spotify.js").PersistedVault} */
      const vault = JSON.parse(saved);
      const password = this.password.value();
      this.password.set_value("");
      runtime.stage("Unlocking your account…");
      await service.unlock(vault, password, runtime);
      this.settings = false;
      await this.refresh(runtime);
    });
  }

  /** @param {Context} cx @param {string} id */
  transferPlayback(cx, id) {
    this.task(cx, async (runtime) => {
      await service.api("", "PUT", { device_ids: [id], play: true }, runtime);
      this.settings = false;
      await this.refresh(runtime);
    });
  }

  /** @param {Context} cx */
  loadDevices(cx) {
    this.task(cx, async (runtime) => {
      this.devices = await service.devices(runtime);
    });
  }

  /** @param {Context} cx */
  savePassword(cx) {
    const password = this.password.value();
    if (!password.trim()) {
      this.message = "Enter a new password.";
      cx.notify();
      return;
    }
    this.task(cx, async (runtime) => {
      this.password.set_value("");
      await service.changePassword(password, runtime);
      this.changingPassword = false;
      this.message = "Vault updated.";
    });
  }

  /** @param {Context} cx */
  disconnect(cx) {
    this.task(cx, async (runtime) => {
      runtime.commit();
      await service.logout();
      this.devices = [];
      this.track = null;
    });
  }

  /** @param {Context} cx */
  toggleSettings(cx) {
    this.settings = !this.settings;
    cx.notify();
  }

  /** @param {Context} cx */
  toggleClientVisibility(cx) {
    this.revealClient = !this.revealClient;
    this.client.set_masked(!this.revealClient);
    cx.notify();
  }

  /** @param {Context} cx @param {boolean} enabled */
  setManualPassword(cx, enabled) {
    this.manualPassword = enabled;
    cx.notify();
  }

  /** @param {Context} cx */
  copyVaultCode(cx) {
    cx.write_to_clipboard(this.generatedCode);
    this.copiedCode = true;
    this.message = "Code copied.";
    cx.notify();
  }

  /** @param {Context} cx @param {boolean} enabled */
  setChangingPassword(cx, enabled) {
    if (!enabled) {
      this.password.set_value("");
    }
    this.changingPassword = enabled;
    cx.notify();
  }

  /** @param {Theme} t @param {string} label @param {(cx: Context) => void} action @param {string} [image] @param {boolean} [iconOnly] */
  button(t, label, action, image, iconOnly = false) {
    return h_flex()
      .id(label)
      .px(8)
      .h(28)
      .gap(6)
      .items_center()
      .justify_center()
      .rounded(6)
      .bg(iconOnly ? t.surface : t.raised)
      .hover((style) => style.bg(t.hover))
      .tab_stop(true)
      .when(!!image, (element) =>
        element.child(svg(image).size(14).flex_none().text_color(t.muted)),
      )
      .when(!iconOnly, (element) => element.child(label))
      .on_click((_, cx) => action(cx))
      .on_key_down((event, cx) => {
        if (["enter", "space"].includes(event.key)) {
          cx.stop_propagation();
          action(cx);
        }
      });
  }

  /** @param {Panel} root @param {Theme} t */
  renderHeader(root, t) {
    root.child(
      h_flex()
        .items_center()
        .gap(6)
        .child(div().flex_1().child("Music"))
        .child(
          this.button(
            t,
            this.settings ? "Back" : "Settings",
            (cx) => this.toggleSettings(cx),
            shellIcon(this.settings ? "chevron-left" : "settings"),
          ),
        )
        .child(
          this.button(
            t,
            "Close",
            () => run("layout.hide", { id: "panel" }),
            shellIcon("x"),
            true,
          ),
        ),
    );
    if (this.stage) {
      root.child(div().child(this.stage));
      if (this.cancelOperation) {
        root.child(this.button(t, "Cancel operation", () => this.cancelOperation?.()));
      }
    }
    if (this.message) {
      root.child(div().child(this.message));
    }
    root.child(div().text_color(t.muted).child("Spotify"));
  }

  /** @param {Panel} root @param {Theme} t */
  renderConnection(root, t) {
    if (!this.settings) {
      root.child(
        this.button(t, saved ? "Unlock" : "Connect Spotify", (cx) =>
          this.toggleSettings(cx),
        ),
      );
      return;
    }
    if (saved) {
      root
        .child(div().child("Unlock your saved account."))
        .child(Input.new(this.password))
        .child(this.button(t, "Unlock", (cx) => this.unlock(cx)));
      return;
    }
    root
      .child(Input.new(this.client))
      .child(
        this.button(
          t,
          this.revealClient ? "Hide Client ID" : "Show Client ID",
          (cx) => this.toggleClientVisibility(cx),
          icon(this.revealClient ? "eye-off" : "eye"),
        ),
      )
      .child(
        div().child("Register this redirect URI in the Spotify Dashboard: " + redirect),
      );
    if (cryptoOK === false) {
      root.child(
        div().child(
          "The vault is unavailable in this Herdr installation. Your connection lasts for this session.",
        ),
      );
    }
    root.child(
      this.button(t, "Authorize in Spotify", (cx) =>
        this.startAuthorization(cx),
      ),
    );
    if (this.attempt) {
      this.renderAuthorization(root, t);
    }
  }

  /** @param {Panel} root @param {Theme} t */
  renderAuthorization(root, t) {
    root
      .child(
        div().child(
          "After authorizing, paste the full URL from your browser, even if the page fails to load.",
        ),
      )
      .child(Input.new(this.url));
    if (cryptoOK) {
      if (this.manualPassword) {
        root
          .child(Input.new(this.password))
          .child(div().child("Windows uses this password to protect your account."))
          .child(
            this.button(t, "Use an unlock code", (cx) =>
              this.setManualPassword(cx, false),
            ),
          );
      } else {
        root
          .child(
            div().child(
              "Save this code to unlock your account the next time you open Herdr.",
            ),
          )
          .child(
            this.button(
              t,
              this.copiedCode
                ? "Copy code again"
                : "Copy unlock code",
              (cx) => this.copyVaultCode(cx),
              icon("copy"),
            ),
          )
          .child(
            this.button(t, "Use my own password", (cx) =>
              this.setManualPassword(cx, true),
            ),
          );
      }
    }
    root.child(
      this.button(t, "Finish connecting", (cx) => this.finishConnection(cx)),
    );
  }

  /** @param {Panel} root @param {Theme} t @param {Playback | null} p */
  renderPlayback(root, t, p) {
    root.child(div().child(p?.title || "Nothing is playing"));
    if (p?.artist) {
      root.child(div().text_color(t.muted).child(p.artist));
    }
    if (!p) {
      root
        .child(
          div().child("Start playing something in Spotify to control it here."),
        )
        .child(
          this.button(t, "Open Spotify", (cx) =>
            cx.open_url("https://open.spotify.com/"),
          ),
        )
        .child(
          this.button(t, "Refresh", (cx) =>
            this.task(cx, (runtime) => this.refresh(runtime)),
          ),
        );
    }
    if (p?.device) {
      root.child(div().text_color(t.muted).child(p.device));
    }
    if (p?.duration) {
      root.child(
        div().child(timeLabel(this.position()) + " / " + timeLabel(p.duration)),
      );
      if (!p.restricted && !p.disallows.seeking) {
        root.child(bar(this.seek, t));
      }
    }
    if (p && !p.restricted && p.volume != null) {
      root
        .child(div().child("Volume · " + p.volume + "%"))
        .child(bar(this.volume, t));
    }
    if (p && p.volume == null) {
      root.child(
        div().text_color(t.muted).child("Adjust the volume on your device."),
      );
    }
    if (p?.restricted) {
      root.child(div().child("This device restricts remote control."));
    }
  }

  /** @param {Theme} t @param {Playback | null} p */
  playbackControls(t, p) {
    const row = h_flex().flex_wrap().gap(6);
    /** @param {string} label @param {string} path @param {string} method @param {string} [symbol] */
    const action = (label, path, method, symbol) =>
      row.child(
        this.button(
          t,
          label,
          (cx) => this.controlPlayback(cx, path, method),
          symbol && icon(symbol),
        ),
      );
    if (p && !p.restricted) {
      if (!p.disallows.skipping_prev) {
        action("Previous", "/previous", "POST", "previous");
      }
      if (!p.disallows[p.playing ? "pausing" : "resuming"]) {
        action(
          p.playing ? "Pause" : "Play",
          p.playing ? "/pause" : "/play",
          "PUT",
          p.playing ? "pause" : "play",
        );
      }
      if (!p.disallows.skipping_next) {
        action("Next", "/next", "POST", "next");
      }
      if (!p.disallows.toggling_shuffle) {
        action("Shuffle", "/shuffle?state=" + !p.shuffle, "PUT");
      }
      if (
        !p.disallows.toggling_repeat_context &&
        !p.disallows.toggling_repeat_track
      ) {
        action(
          "Repeat",
          "/repeat?state=" +
            { off: "context", context: "track", track: "off" }[p.repeat],
          "PUT",
        );
      }
    }
    return row;
  }

  /** @param {Panel} root @param {Theme} t */
  renderDevices(root, t) {
    root.child(this.button(t, "Devices", (cx) => this.loadDevices(cx)));
    if (this.devices?.length === 0) {
      root.child(div().child("No devices available."));
    }
    for (const device of this.devices || []) {
      root.child(
        device.is_active || device.is_restricted || !device.id
          ? div().child(device.name + (device.is_active ? " · active" : ""))
          : this.button(t, "Play on " + device.name, (cx) =>
            this.transferPlayback(cx, device.id),
          ),
      );
    }
  }

  /** @param {Panel} root @param {Theme} t */
  renderPasswordChange(root, t) {
    if (this.changingPassword) {
      root
        .child(div().child("Enter the new password for your local vault."))
        .child(Input.new(this.password))
        .child(
          this.button(t, "Save new password", (cx) => this.savePassword(cx)),
        )
        .child(
          this.button(t, "Cancel", (cx) =>
            this.setChangingPassword(cx, false),
          ),
        );
    } else {
      root.child(
        this.button(t, "Change vault password", (cx) =>
          this.setChangingPassword(cx, true),
        ),
      );
    }
  }

  render() {
    const t = /** @type {Theme} */ (theme());
    const connected = !!service?.access;
    const p = connected ? this.track : null;
    const root = v_flex()
      .id("music-panel")
      .size_full()
      .overflow_y_scrollbar()
      .p(12)
      .gap(8)
      .bg(t.surface)
      .text_color(t.foreground);
    this.renderHeader(root, t);
    if (connected) {
      if (this.settings) {
        this.renderDevices(root, t);
        this.renderPasswordChange(root, t);
      } else {
        this.renderPlayback(root, t, p);
      }
    } else {
      this.renderConnection(root, t);
      if (!this.settings) {
        return root;
      }
    }
    if (this.settings && (connected || saved)) {
      root.child(this.button(t, "Disconnect", (cx) => this.disconnect(cx)));
    }
    return root.child(this.playbackControls(t, p));
  }
}
