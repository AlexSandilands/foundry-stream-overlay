/**
 * Riv Stream Overlay
 *
 * Views, chosen by URL, meant to be loaded in OBS browser sources by a non-GM observer user:
 *   /game   (inside OBS, or with #map)  -> map only, camera mirrors the GM's view
 *   /stream                             -> chat log only, styled for the overlay
 *   /stream#party                       -> party portraits with HP bars
 *
 * The GM's own client broadcasts its camera; observers in map view follow it while
 * they are showing the same scene.
 */

const MODULE_ID = "riv-stream-overlay";
const SOCKET = `module.${MODULE_ID}`;
const SLOT_COUNT = 5;
const CHAT_HISTORY = 40;

const mode = (() => {
  const hash = window.location.hash.replace("#", "");
  const path = window.location.pathname;
  if (path.endsWith("/stream")) return hash === "party" ? "party" : "chat";
  if (path.endsWith("/game") && (hash === "map" || window.obsstudio)) return "map";
  return null;
})();

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "slots", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: () => PartyView.render()
  });

  game.settings.registerMenu(MODULE_ID, "slotsMenu", {
    name: "Party slots",
    label: "Choose characters",
    hint: "Which character appears in each of the five portrait slots on stream, left to right.",
    icon: "fa-solid fa-users",
    type: SlotsConfig,
    restricted: true
  });

  game.settings.register(MODULE_ID, "chatStyle", {
    name: "Chat style",
    hint: "How chat messages look in the stream's chat panel.",
    scope: "world",
    config: true,
    type: String,
    choices: Object.fromEntries(Object.entries(CHAT_STYLES).map(([k, v]) => [k, v.label])),
    default: "parchment",
    onChange: () => ChatView.applyStyle()
  });

  game.settings.register(MODULE_ID, "portraitImage", {
    name: "Portrait image",
    hint: "Use the character's portrait art or their token image in the party strip.",
    scope: "world",
    config: true,
    type: String,
    choices: { actor: "Character portrait", token: "Token image" },
    default: "actor",
    onChange: () => PartyView.render()
  });

  game.settings.register(MODULE_ID, "showHpNumbers", {
    name: "Show HP numbers",
    hint: "Show current / max HP on the bars. When off, only the bar is shown.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => PartyView.render()
  });

  game.keybindings.register(MODULE_ID, "toggleMirror", {
    name: "Pause / resume stream camera",
    hint: "While paused, the stream's map stays where it is when you move your view.",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => {
      CameraMirror.togglePause();
      return true;
    }
  });

});

Hooks.once("setup", () => {
  game.socket.on(SOCKET, message => CameraMirror.onMessage(message));
});

/* -------------------------------------------- */
/*  Camera mirroring (map view)                 */
/* -------------------------------------------- */

const CameraMirror = {
  paused: false,
  lastView: null,

  /** GM side: the visible area of the canvas, in scene coordinates. */
  currentView() {
    if (!canvas?.ready || !canvas.scene) return null;
    const scale = canvas.stage.scale.x;
    const [width, height] = canvas.screenDimensions;
    return {
      type: "view",
      sceneId: canvas.scene.id,
      x: canvas.stage.pivot.x,
      y: canvas.stage.pivot.y,
      width: width / scale,
      height: height / scale
    };
  },

  broadcast() {
    if (!game.user.isGM || mode || this.paused) return;
    const view = this.currentView();
    if (view) game.socket.emit(SOCKET, view);
  },

  togglePause() {
    if (!game.user.isGM) return;
    this.paused = !this.paused;
    ui.notifications.info(this.paused
      ? "Stream camera paused. It will stay where it is until you resume (Shift+M)."
      : "Stream camera resumed. It is following your view again.");
    if (!this.paused) this.broadcast();
  },

  onMessage(message) {
    if (message.type === "request") return this.broadcast();
    if (message.type !== "view" || mode !== "map") return;
    this.lastView = message;
    this.apply(message);
  },

  /** Observer side: frame the same area the GM sees, fitted to this window. */
  apply(view) {
    if (!canvas?.ready || canvas.scene?.id !== view.sceneId) return;
    const [width, height] = canvas.screenDimensions;
    const scale = Math.min(width / view.width, height / view.height);
    canvas.animatePan({ x: view.x, y: view.y, scale, duration: 250 });
  }
};

Hooks.on("canvasPan", foundry.utils.throttle(() => CameraMirror.broadcast(), 100));

Hooks.on("canvasReady", () => {
  if (mode === "map") {
    // Ask the GM where they're looking; re-apply the last known view for this scene meanwhile.
    if (CameraMirror.lastView) CameraMirror.apply(CameraMirror.lastView);
    game.socket.emit(SOCKET, { type: "request" });
  }
  else CameraMirror.broadcast();
});

/* -------------------------------------------- */
/*  Stream page: wait for game data             */
/* -------------------------------------------- */

/** The /stream page never fires the "ready" hook, so poll until documents are available. */
async function streamDataReady() {
  for (let i = 0; i < 100; i++) {
    if (game.actors?.size && game.settings?.settings?.has(`${MODULE_ID}.slots`)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/* -------------------------------------------- */
/*  Chat view                                   */
/* -------------------------------------------- */

const CHAT_STYLES = {
  dark: { label: "Solid dark", theme: "dark" },
  parchment: { label: "Parchment", theme: "light" },
  banner: { label: "Parchment with dark banner", theme: "light" },
  ledger: { label: "Dark ledger (no cards)", theme: "dark" }
};

const ChatView = {
  log: null,

  /** Apply one of CHAT_STYLES; defaults to the world setting. */
  applyStyle(style) {
    style ??= game.settings.get(MODULE_ID, "chatStyle");
    if (!CHAT_STYLES[style]) style = "parchment";
    for (const key of Object.keys(CHAT_STYLES)) document.body.classList.toggle(`riv-chat-${key}`, key === style);
    const theme = CHAT_STYLES[style].theme;
    this.log?.classList.remove("theme-light", "theme-dark");
    this.log?.classList.add(`theme-${theme}`);
  },

  async init() {
    const log = await waitFor(() => document.querySelector("#chat .chat-log"));
    if (!log || !(await streamDataReady())) return;
    this.log = log;
    this.applyStyle();
    const scroller = log.closest(".chat-scroll") ?? log.parentElement;
    const tidy = () => {
      const messages = log.querySelectorAll(":scope > .chat-message");
      for (let i = 0; i < messages.length - CHAT_HISTORY; i++) messages[i].remove();
      scroller.scrollTop = scroller.scrollHeight;
    };
    new MutationObserver(tidy).observe(log, { childList: true, subtree: true });
    // Images (portraits, item icons) change heights after load.
    log.addEventListener("load", tidy, true);
    tidy();
  }
};

async function waitFor(fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const result = fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

/* -------------------------------------------- */
/*  Party view                                  */
/* -------------------------------------------- */

const PartyView = {
  element: null,

  async init() {
    if (!(await streamDataReady())) return;
    this.element = document.createElement("div");
    this.element.id = "riv-party";
    document.body.append(this.element);
    this.render();
    Hooks.on("updateActor", actor => {
      if (this.slotIds().includes(actor.id)) this.render();
    });
  },

  slotIds() {
    const slots = game.settings.get(MODULE_ID, "slots") ?? [];
    return Array.from({ length: SLOT_COUNT }, (_, i) => slots[i] || null);
  },

  render() {
    if (!this.element) return;
    const useToken = game.settings.get(MODULE_ID, "portraitImage") === "token";
    const showNumbers = game.settings.get(MODULE_ID, "showHpNumbers");
    this.element.replaceChildren(...this.slotIds().map((id, index) => {
      const slot = document.createElement("div");
      slot.className = "riv-slot";
      slot.dataset.slot = index;
      const actor = id ? game.actors.get(id) : null;
      if (!actor) return slot;

      const img = document.createElement("img");
      img.className = "riv-portrait";
      img.src = (useToken ? actor.prototypeToken?.texture?.src : null) || actor.img;
      img.alt = actor.name;

      const hp = actor.system.attributes?.hp ?? {};
      const value = Math.max(Number(hp.value) || 0, 0);
      const max = Math.max(Number(hp.max) || 0, 1);
      const temp = Number(hp.temp) || 0;

      const bar = document.createElement("div");
      bar.className = "riv-hp";
      const fill = document.createElement("div");
      fill.className = "riv-hp-fill";
      fill.style.width = `${Math.min(value / max, 1) * 100}%`;
      bar.append(fill);
      if (showNumbers) {
        const label = document.createElement("span");
        label.className = "riv-hp-label";
        label.textContent = temp > 0 ? `${value} / ${max} (+${temp})` : `${value} / ${max}`;
        bar.append(label);
      }
      slot.append(img, bar);
      return slot;
    }));
  }
};

/* -------------------------------------------- */
/*  Slot configuration (GM)                     */
/* -------------------------------------------- */

class SlotsConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "riv-stream-overlay-slots",
    tag: "form",
    window: { title: "Stream Overlay: Party Slots", contentClasses: ["standard-form"] },
    position: { width: 480 },
    form: { handler: SlotsConfig.#onSubmit, closeOnSubmit: true }
  };

  async _renderHTML() {
    const slots = game.settings.get(MODULE_ID, "slots") ?? [];
    const characters = game.actors.filter(a => a.type === "character")
      .map(a => {
        const owners = game.users.filter(u => !u.isGM && a.testUserPermission(u, "OWNER")).map(u => u.name);
        const classes = Object.values(a.classes ?? {}).map(c => `${c.name} ${c.system.levels}`).join(" / ");
        const hp = a.system.attributes?.hp;
        const extra = [classes, hp ? `${hp.value}/${hp.max} HP` : null, owners.join(", "), a.folder?.name]
          .filter(Boolean).join(" · ");
        return { id: a.id, label: extra ? `${a.name} (${extra})` : a.name };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const esc = foundry.utils.escapeHTML ?? (s => s);
    const rows = Array.from({ length: SLOT_COUNT }, (_, i) => {
      const options = characters.map(c =>
        `<option value="${c.id}" ${slots[i] === c.id ? "selected" : ""}>${esc(c.label)}</option>`).join("");
      return `<div class="form-group">
        <label>Slot ${i + 1}</label>
        <div class="form-fields"><select name="slot${i}"><option value="">(empty)</option>${options}</select></div>
      </div>`;
    }).join("");
    return `<p class="hint">Left to right, matching the portrait windows on the overlay.</p>${rows}
      <footer class="form-footer"><button type="submit"><i class="fa-solid fa-save"></i> Save</button></footer>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => data[`slot${i}`] || "");
    await game.settings.set(MODULE_ID, "slots", slots);
  }
}

/* -------------------------------------------- */
/*  Start                                       */
/* -------------------------------------------- */

// Exposed for macros and debugging.
globalThis.RivStreamOverlay = { mode, CameraMirror, ChatView, PartyView };

if (mode) {
  const tagBody = () => document.body.classList.add("riv-stream", `riv-stream-${mode}`);
  if (document.body) tagBody();
  else document.addEventListener("DOMContentLoaded", tagBody);
}
if (mode === "chat") ChatView.init();
if (mode === "party") PartyView.init();
