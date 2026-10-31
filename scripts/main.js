/**
 * Riv Stream Overlay
 *
 * Views, chosen by URL, meant to be loaded in OBS browser sources by a non-GM observer user:
 *   /game   (inside OBS, or with #map)  -> map only, camera mirrors the GM's view
 *   /stream                             -> chat log only, styled for the overlay
 *   /stream#party                       -> party portraits with HP bars
 *
 * The GM's own client broadcasts its camera and chat (scroll position, expanded rolls and
 * cards); observers follow it. The map only follows while showing the same scene.
 * Shift+M pauses and resumes both.
 */

const MODULE_ID = "riv-stream-overlay";
const SOCKET = `module.${MODULE_ID}`;
const SLOT_COUNT = 5;
const CHAT_HISTORY = 100;

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
    name: "Pause / resume stream mirroring",
    hint: "While paused, the stream's map and chat stay where they are when you move your view or chat.",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => {
      CameraMirror.togglePause();
      return true;
    }
  });

});

let socketRegistered = false;

/** Listen for mirror messages. Called from "setup" and, since /stream never fires it, from the stream views. */
function registerSocket() {
  if (socketRegistered || !game.socket) return;
  socketRegistered = true;
  game.socket.on(SOCKET, message => {
    switch (message.type) {
      case "request":
        CameraMirror.broadcast();
        ChatMirror.sendScroll();
        break;
      case "view": return CameraMirror.onMessage(message);
      case "chatScroll": return ChatView.onScroll(message);
      case "chatToggle": return ChatView.onToggle(message);
    }
  });
}

Hooks.once("setup", registerSocket);

Hooks.once("ready", () => ChatMirror.init());

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
      ? "Stream paused. The map and chat will stay where they are until you resume (Shift+M)."
      : "Stream resumed. The map and chat are following you again.");
    if (!this.paused) {
      this.broadcast();
      ChatMirror.sendScroll();
    }
  },

  onMessage(message) {
    if (mode !== "map") return;
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

/**
 * Foundry only loads registered fonts (CONFIG.fontDefinitions, e.g. dnd5e's Roboto family)
 * on the game page, so the /stream page would otherwise fall back to system fonts.
 */
function loadRegisteredFonts() {
  const route = url => foundry.utils.getRoute?.(url) ?? `/${url}`;
  for (const [family, definition] of Object.entries(CONFIG.fontDefinitions ?? {})) {
    for (const font of definition.fonts ?? []) {
      if (!font.urls?.length) continue;
      const source = font.urls.map(url => `url("${route(url)}")`).join(", ");
      const face = new FontFace(family, source, { weight: font.weight ?? "normal", style: font.style ?? "normal" });
      document.fonts.add(face);
      face.load().catch(() => {});
    }
  }
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
  scroller: null,
  targetTop: 0,
  gliding: false,

  /** The GM's scroll anchor ({messageId, fraction}); null means follow the newest message. */
  anchor: null,

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
    loadRegisteredFonts();
    this.log = log;
    this.scroller = log.closest(".chat-scroll") ?? log.parentElement;
    this.applyStyle();
    const tidy = () => {
      const messages = log.querySelectorAll(":scope > .chat-message");
      for (let i = 0; i < messages.length - CHAT_HISTORY; i++) messages[i].remove();
      this.scroll(false);
    };
    new MutationObserver(tidy).observe(log, { childList: true, subtree: true });
    // Images (portraits, item icons) change heights after load.
    log.addEventListener("load", tidy, true);
    tidy();
    registerSocket();
    game.socket.emit(SOCKET, { type: "request" });
  },

  /** Scroll to the newest message, or line up the GM's anchor message with the bottom edge. */
  scroll(smooth) {
    const scroller = this.scroller;
    if (!scroller) return;
    let top = scroller.scrollHeight - scroller.clientHeight;
    if (this.anchor) {
      const message = this.findMessage(this.anchor.messageId);
      if (!message) return;
      const rect = message.getBoundingClientRect();
      const bottom = scroller.getBoundingClientRect().bottom;
      top = scroller.scrollTop + (rect.top + (this.anchor.fraction * rect.height)) - bottom;
    }
    this.targetTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    if (!smooth) scroller.scrollTop = this.targetTop;
    else if (!this.gliding) this.glide();
  },

  /** Ease towards the latest target every frame, so frequent small updates read as one smooth motion. */
  glide() {
    this.gliding = true;
    let last = performance.now();
    const step = now => {
      const scroller = this.scroller;
      const distance = this.targetTop - scroller.scrollTop;
      if (Math.abs(distance) < 0.5) {
        scroller.scrollTop = this.targetTop;
        this.gliding = false;
        return;
      }
      // Cover ~90% of the remaining distance every 150ms, independent of frame rate.
      const t = 1 - Math.pow(0.1, (now - last) / 150);
      last = now;
      scroller.scrollTop += distance * t;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  findMessage(id) {
    return this.log?.querySelector(`:scope > .chat-message[data-message-id="${CSS.escape(id)}"]`) ?? null;
  },

  onScroll(message) {
    if (mode !== "chat") return;
    this.anchor = message.atBottom ? null : { messageId: message.messageId, fraction: message.fraction };
    this.scroll(true);
  },

  onToggle(message) {
    if (mode !== "chat") return;
    const root = this.findMessage(message.messageId);
    const element = root && resolveElementPath(root, message.path, message.changed);
    if (!element) return;
    if (message.attribute === "open") element.toggleAttribute("open", message.value);
    else {
      element.classList.add(...message.added);
      element.classList.remove(...message.removed);
    }
    // Expanding changes heights; re-align once any transition has settled.
    setTimeout(() => this.scroll(true), 50);
    setTimeout(() => this.scroll(true), 450);
  }
};

/* -------------------------------------------- */
/*  Chat mirroring (GM side)                    */
/* -------------------------------------------- */

/** Classes that describe state rather than identity, ignored when matching elements. */
const STATE_CLASSES = new Set(["expanded", "collapsed", "open", "active", "hidden", "visible", "selected", "shown"]);

function elementSignature(element, ignore) {
  const classes = [...element.classList].filter(c => !STATE_CLASSES.has(c) && !ignore.includes(c)).sort();
  return [element.tagName, ...classes].join(".");
}

/**
 * Describe where an element sits inside a chat message as a list of {signature, index} steps.
 * Matching by tag and classes (not raw child index) tolerates elements only the GM sees.
 */
function elementPath(element, root, changed) {
  const path = [];
  for (let el = element; el !== root; el = el.parentElement) {
    const parent = el.parentElement;
    if (!parent) return null;
    const ignore = el === element ? changed : [];
    const signature = elementSignature(el, ignore);
    const index = [...parent.children].filter(c => elementSignature(c, ignore) === signature).indexOf(el);
    path.unshift({ signature, index });
  }
  return path;
}

function resolveElementPath(root, path, changed) {
  let element = root;
  path.forEach((step, i) => {
    if (!element) return;
    const ignore = i === path.length - 1 ? changed : [];
    element = [...element.children].filter(c => elementSignature(c, ignore) === step.signature)[step.index] ?? null;
  });
  return element;
}

const ChatMirror = {
  lastClick: null,

  get active() {
    return game.user.isGM && !mode && !CameraMirror.paused;
  },

  init() {
    if (!game.user.isGM || mode) return;
    const sendScroll = foundry.utils.throttle(() => this.sendScroll(), 50);
    document.addEventListener("scroll", event => {
      if ((event.target instanceof Element) && event.target.matches("#chat .chat-scroll")) sendScroll();
    }, true);
    document.addEventListener("click", event => {
      const message = event.target.closest?.("#chat .chat-message");
      if (message) this.lastClick = { id: message.dataset.messageId, time: Date.now() };
    }, true);
    new MutationObserver(mutations => this.onMutations(mutations)).observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ["class", "open"], attributeOldValue: true
    });
  },

  /** Forward expand/collapse changes that follow a click on a chat message. */
  onMutations(mutations) {
    if (!this.active || !this.lastClick || (Date.now() - this.lastClick.time > 1500)) return;
    let sent = false;
    for (const mutation of mutations) {
      const message = mutation.target.closest?.("#chat .chat-message");
      if (message?.dataset.messageId !== this.lastClick.id) continue;
      const payload = { type: "chatToggle", messageId: this.lastClick.id };
      if (mutation.attributeName === "open") {
        Object.assign(payload, { attribute: "open", value: mutation.target.hasAttribute("open"), changed: [] });
      } else {
        const before = new Set((mutation.oldValue ?? "").split(/\s+/).filter(Boolean));
        const after = new Set(mutation.target.classList);
        const added = [...after].filter(c => !before.has(c));
        const removed = [...before].filter(c => !after.has(c));
        if (!added.length && !removed.length) continue;
        Object.assign(payload, { added, removed, changed: [...added, ...removed] });
      }
      payload.path = elementPath(mutation.target, message, payload.changed);
      if (!payload.path) continue;
      game.socket.emit(SOCKET, payload);
      sent = true;
    }
    if (sent) setTimeout(() => this.sendScroll(), 450);
  },

  /** Send which public message sits at the bottom of the GM's chat, and how far into it. */
  sendScroll() {
    if (!this.active) return;
    const scroller = document.querySelector("#chat .chat-scroll");
    if (!scroller?.offsetParent) return;
    if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 8) {
      return game.socket.emit(SOCKET, { type: "chatScroll", atBottom: true });
    }
    const bottom = scroller.getBoundingClientRect().bottom;
    let anchor = null;
    for (const element of scroller.querySelectorAll(".chat-message")) {
      const rect = element.getBoundingClientRect();
      if (rect.top >= bottom) break;
      // Whispers and blind rolls never reach the stream, so they can't be anchors.
      const doc = game.messages.get(element.dataset.messageId);
      if (doc && !doc.whisper?.length && !doc.blind) anchor = { element, rect };
    }
    if (!anchor) return;
    const fraction = Math.min(Math.max((bottom - anchor.rect.top) / anchor.rect.height, 0), 1);
    game.socket.emit(SOCKET, { type: "chatScroll", messageId: anchor.element.dataset.messageId, fraction });
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
    loadRegisteredFonts();
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
globalThis.RivStreamOverlay = { mode, CameraMirror, ChatMirror, ChatView, PartyView };

if (mode) {
  const tagBody = () => document.body.classList.add("riv-stream", `riv-stream-${mode}`);
  if (document.body) tagBody();
  else document.addEventListener("DOMContentLoaded", tagBody);
}
if (mode === "chat") ChatView.init();
if (mode === "party") PartyView.init();
