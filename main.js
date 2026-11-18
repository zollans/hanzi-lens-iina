/* Hanzi Lens — IINA player-instance entry.
 * Owns mpv/IINA integration: subtitle tracking, native-subtitle takeover, translation, input,
 * menu and the message plumbing between the video overlay and the sidebar. */
const { core, event, overlay, sidebar, menu, utils, preferences, input, console, file } = iina;

// IINA destroys mpv right after the player window closes (quit, or closing the window), while this
// script's timers keep firing; reading a property then crashes IINA inside libmpv. So every mpv
// access goes through this guard, which goes quiet from "window-will-close" until a file loads again.
let dormant = false;
const mpv = {
  getString: (k) => (dormant ? "" : iina.mpv.getString(k)),
  getNumber: (k) => (dormant ? NaN : iina.mpv.getNumber(k)),
  getFlag: (k) => (dormant ? false : iina.mpv.getFlag(k)),
  getNative: (k) => (dormant ? null : iina.mpv.getNative(k)),
  set: (k, v) => { if (!dormant) iina.mpv.set(k, v); },
};

// ---------------------------------------------------------------------------- plugin root
const ROOT = (() => {
  try { throw new Error("root"); } catch (e) {
    const m = /file:\/\/(\/[^\s:]*?)\/main\.js/.exec(String(e.stack || ""));
    return m ? decodeURIComponent(m[1]) : null;
  }
})();
const HELPER = ROOT ? ROOT + "/bin/hl-translate" : null;

// ---------------------------------------------------------------------------- debug log (@data/debug.log)
// Off by default; set the "debug" preference to true to write @data/debug.log.
const debugLines = [];
function dlog(msg) {
  if (!preferences.get("debug")) return;
  debugLines.push(new Date().toISOString().slice(11, 23) + " " + msg);
  if (debugLines.length > 300) debugLines.shift();
  try { file.write("@data/debug.log", debugLines.join("\n") + "\n"); } catch (e) { /* ignore */ }
}
dlog("main.js loaded, root=" + ROOT);

// ---------------------------------------------------------------------------- preferences
const DEFAULTS = {
  enabled: true, pinyin: true, zhuyin: false, toneColors: false, toneShapes: true, translate: true,
  useSecondary: true, autoSelect: true, pauseOnLookup: true, blurTranslation: false, targetLang: "",
};
function pref(k) {
  const v = preferences.get(k);
  return v === undefined || v === null ? DEFAULTS[k] : v;
}
function setPref(k, v) { preferences.set(k, v); preferences.sync(); }
// 1.1: tone colors are off by default (they rely on red/green), tone shapes replace them.
if (preferences.get("migrated11") !== true) {
  preferences.set("toneColors", false);
  preferences.set("migrated11", true);
  preferences.sync();
}
function settings() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = pref(k);
  return s;
}
function targetLang() {
  let t = String(pref("targetLang") || "").trim();
  if (!t) {
    const locs = utils.preferredLocalizations() || [];
    t = (locs.find((l) => !/^zh/i.test(l)) || "en").split(/[-_]/)[0];
  }
  return t;
}

// ---------------------------------------------------------------------------- messaging
// Payloads are URI-encoded JSON so nothing in subtitle text can break IINA's template-literal bridge.
const enc = (o) => encodeURIComponent(JSON.stringify(o));
let overlayReady = false;
let sidebarReady = false;
const pendingOverlay = [];
function toOverlay(name, data) {
  if (!overlayReady) { pendingOverlay.push([name, data]); return; }
  overlay.postMessage(name, enc(data));
}
function toSidebar(name, data) {
  if (!sidebarReady) return;
  sidebar.postMessage(name, enc(data));
}

// ---------------------------------------------------------------------------- state
const state = {
  line: null,          // {id, text, start, end}
  seq: 0,
  lines: [],           // transcript (seen or parsed)
  transcriptFromFile: false,
  cache: new Map(),    // text -> translation
  inflight: new Set(),
  helperStatus: "unknown",
  cardOpen: false,
  pausedByUs: false,
  subVisBefore: null,
  takeover: false,
  userHidden: false,   // IINA's own "show subtitles" toggle, applied to Hanzi Lens's line
  trackChangedAt: 0,   // IINA re-shows mpv subtitles by itself right after a file/track loads
  secondaryByUs: false, // we picked the English track as mpv's (hidden) secondary subtitle
  secVisBefore: null,
  waitTimer: 0,
};

// ---------------------------------------------------------------------------- native subtitle takeover
function hasChinese(s) { return /[㐀-鿿豈-﫿]/.test(s || ""); }

function applyTakeover() {
  state.trackChangedAt = Math.max(state.trackChangedAt, Date.now() - 2000);
  const want = pref("enabled") && hasSubTrack();
  if (want && !state.takeover) {
    state.subVisBefore = mpv.getFlag("sub-visibility");
    mpv.set("sub-visibility", false);
    state.takeover = true;
  } else if (!want && state.takeover) {
    mpv.set("sub-visibility", state.subVisBefore === null ? true : state.subVisBefore);
    state.takeover = false;
  }
  syncSecondary();
  toOverlay("visible", { visible: !!want && !state.userHidden });
}
/** If no subtitle track is selected, pick a Chinese one (embedded or external) when the file has it. */
const isZhTrack = (t) => /^(zh|chi|zho|cmn|chs|cht|yue|chinese)/i.test(t.lang || "") ||
  /chinese|mandarin|中文|简体|簡體|繁體|繁体|國語|国语|普通话|粵語/i.test((t.title || "") + " " + (t["external-filename"] || ""));
function autoSelectChineseTrack() {
  // Runs when a file loads. IINA picks the subtitle track by its own language preference (often
  // English); when the file also has a Chinese track, that one becomes the main line and the
  // English one is picked up as the translation by syncSecondary().
  if (!pref("enabled") || !pref("autoSelect")) return false;
  let tracks = [];
  try { tracks = mpv.getNative("track-list") || []; } catch (e) { return false; }
  const subs = tracks.filter((t) => t.type === "sub");
  dlog("sub tracks: " + subs.map((t) => t.id + ":" + (t.lang || "?") + ":" + (t.title || "") + (t.selected ? "*" : "")).join(" | "));
  const sid = mpv.getString("sid");
  // mpv marks the secondary track "selected" too, so the main track is found by id.
  const cur = subs.find((t) => String(t.id) === sid);
  if (cur && isZhTrack(cur)) return false;
  const zh = subs.filter(isZhTrack).sort((a, b) => (a.forced ? 1 : 0) - (b.forced ? 1 : 0));
  const pick = zh[0];
  dlog("autoSelect: picked " + (pick ? pick.id + " " + (pick.lang || "") + " " + (pick.title || "") : "none"));
  if (!pick) return false;
  // If our (hidden) secondary line was this track's partner, free it so the two don't collide.
  if (mpv.getString("secondary-sid") === String(pick.id)) mpv.set("secondary-sid", "no");
  mpv.set("sid", String(pick.id));
  core.osd("Hanzi Lens: Chinese subtitles selected");
  return true;
}

function hasSubTrack() {
  const sid = mpv.getString("sid");
  return !!sid && sid !== "no" && sid !== "false";
}

// ---------------------------------------------------------------------------- English track as translation
// When the file also carries English subtitles, they become the translation line: mpv loads them as
// its secondary subtitle (kept invisible while Hanzi Lens draws), and the plugin reads their text.
const isOn = (v) => !!v && v !== "no" && v !== "false" && v !== "auto";
function isEnglish(t) {
  return /^(en|eng)([-_].*)?$/i.test(t.lang || "") ||
    /\benglish\b|英文|英语|英語/i.test((t.title || "") + " " + (t["external-filename"] || ""));
}
function englishScore(t) {
  // Prefer the full dialogue track over SDH/CC (sound captions) and forced (signs-only) tracks.
  const name = (t.title || "") + " " + (t["external-filename"] || "");
  let s = 0;
  if (t.forced || /forced|signs/i.test(name)) s -= 4;
  if (/sdh|\bcc\b|hearing/i.test(name)) s -= 2;
  if (t.default) s += 1;
  return s;
}
function wantsEnglishTrack() {
  return pref("enabled") && pref("translate") && pref("useSecondary");
}
function hasSecondary() { return isOn(mpv.getString("secondary-sid")); }
function syncSecondary() {
  if (!wantsEnglishTrack()) {
    if (state.secondaryByUs) { mpv.set("secondary-sid", "no"); state.secondaryByUs = false; }
  } else {
    let tracks = [];
    try { tracks = mpv.getNative("track-list") || []; } catch (e) { tracks = []; }
    const sid = mpv.getString("sid");
    if (state.secondaryByUs && hasSecondary()) {
      // Ours from an earlier file or before a track switch: keep it only if it is still an English
      // track other than the primary one.
      const cur = tracks.find((t) => t.type === "sub" && String(t.id) === mpv.getString("secondary-sid"));
      if (!tracks.length) return finishSecondary();
      if (!cur || !isEnglish(cur) || String(cur.id) === sid) mpv.set("secondary-sid", "no");
    }
    if (hasSecondary()) return finishSecondary();
    state.secondaryByUs = false;
    const en = tracks.filter((t) => t.type === "sub" && String(t.id) !== sid && isEnglish(t))
      .sort((a, b) => englishScore(b) - englishScore(a));
    dlog("english tracks: " + en.map((t) => t.id + ":" + (t.title || t.lang || "")).join(", "));
    if (en.length) {
      mpv.set("secondary-sid", String(en[0].id));
      state.secondaryByUs = true;
      if (state.line) provideTranslation(state.line.id, state.line.text);
    }
  }
  finishSecondary();
}
function finishSecondary() {
  // mpv's own rendering of the secondary line stays hidden while Hanzi Lens shows it.
  if (state.takeover && hasSecondary()) {
    if (state.secVisBefore === null) state.secVisBefore = mpv.getFlag("secondary-sub-visibility");
    if (mpv.getFlag("secondary-sub-visibility")) mpv.set("secondary-sub-visibility", false);
  } else if (state.secVisBefore !== null) {
    mpv.set("secondary-sub-visibility", state.secVisBefore);
    state.secVisBefore = null;
  }
}
/** The secondary (English) cue on screen now, if it belongs to the given Chinese line. */
function secondaryFor(line) {
  if (!line || !hasSecondary()) return "";
  const sec = (mpv.getString("secondary-sub-text") || "").replace(/\r/g, "").trim();
  if (!sec || hasChinese(sec)) return "";
  // Broadcast English cues are pre-broken into two short lines; the translation line flows as one.
  // (Dialogue between two speakers, "- A\n- B", keeps its break.)
  const flowed = /^\s*[-–]/.test(sec) ? sec : sec.replace(/\s*\n\s*/g, " ");
  const s = mpv.getNumber("secondary-sub-start"), e = mpv.getNumber("secondary-sub-end");
  if (isFinite(s) && isFinite(e) && e > s && isFinite(line.start) && isFinite(line.end) && line.end > line.start) {
    const overlap = Math.min(e, line.end) - Math.max(s, line.start);
    if (overlap < Math.min(0.25, (line.end - line.start) / 2)) return "";
  }
  return flowed;
}

function subStyle() {
  // Every subtitle option IINA's Subtitles settings and quick settings drive (see MPVController).
  const n = (p, d) => { const v = mpv.getNumber(p); return isFinite(v) ? v : d; };
  const str = (p, d) => mpv.getString(p) || d;
  return {
    font: str("sub-font", ""),
    fontSize: n("sub-font-size", 55) || 55,
    scale: n("sub-scale", 1) || 1,
    scaleByWindow: mpv.getFlag("sub-scale-by-window"),
    bold: mpv.getFlag("sub-bold"),
    italic: mpv.getFlag("sub-italic"),
    color: str("sub-color", "#FFFFFFFF"),
    border: n("sub-outline-size", n("sub-border-size", 3)),
    borderColor: str("sub-outline-color", str("sub-border-color", "#FF000000")),
    backColor: str("sub-back-color", "#00000000"),
    borderStyle: str("sub-border-style", "outline-and-shadow"),
    shadow: n("sub-shadow-offset", 0),
    blur: n("sub-blur", 0),
    spacing: n("sub-spacing", 0),
    alignX: str("sub-align-x", "center"),
    alignY: str("sub-align-y", "bottom"),
    marginX: n("sub-margin-x", 25),
    marginY: n("sub-margin-y", 22),
    pos: n("sub-pos", 100),
  };
}

// ---------------------------------------------------------------------------- IINA control bar placement
// The overlay keeps the subtitle clear of IINA's on-screen controls. IINA doesn't expose them to
// plugins, so read its saved control-bar position (it changes when the user drags the bar).
let oscInfo = null;
function readIINAPref(key) {
  return utils.exec("/usr/bin/defaults", ["read", "com.colliderli.iina", key]).then(
    (r) => (r.status === 0 ? String(r.stdout).trim() : null), () => null);
}
/** Width of the video covered by this plugin's sidebar, on whichever side IINA puts it. */
function pushInset() {
  const sb = state.sidebar;
  const w = sb && sb.visible ? sb.width : 0;
  const inset = oscInfo && oscInfo.sidebarLeading === false ? { l: 0, r: w } : { l: w, r: 0 };
  const key = JSON.stringify(inset);
  if (key === state.insetKey) return;
  state.insetKey = key;
  toOverlay("inset", inset);
}
function refreshOSC() {
  Promise.all(["oscPosition", "controlBarPositionHorizontal", "controlBarPositionVertical",
    "enableControlBarAutoHide", "controlBarAutoHideTimeout", "sidebarPluginsDisplayAtLeading"].map(readIINAPref))
    .then(([pos, h, v, autoHide, timeout, sbLeading]) => {
      const info = {
        pos: pos === null ? 0 : parseInt(pos, 10) || 0,     // 0 floating, 1 top, 2 bottom
        h: h === null ? 0.5 : parseFloat(h),
        v: v === null ? 0.1 : parseFloat(v),
        autoHide: autoHide === null ? true : autoHide !== "0",
        timeout: timeout === null || !(parseFloat(timeout) > 0) ? 2.5 : parseFloat(timeout),
        sidebarLeading: sbLeading === null ? true : sbLeading !== "0",
      };
      const changed = JSON.stringify(info) !== JSON.stringify(oscInfo);
      oscInfo = info;
      if (changed) toOverlay("osc", info);
      state.insetKey = ""; pushInset();
    });
}
let oscRefreshAt = 0;
function refreshOSCSoon() {
  // After a click/drag the user may have moved the control bar; re-read at most every 2 s.
  if (Date.now() - oscRefreshAt < 2000) return;
  oscRefreshAt = Date.now();
  setTimeout(refreshOSC, 300);
}
refreshOSC();
setInterval(refreshOSC, 8000);

// ---------------------------------------------------------------------------- subtitle lines
function onSubText() {
  const text = (mpv.getString("sub-text") || "").replace(/\r/g, "").trim();
  dlog("line: " + JSON.stringify(text).slice(0, 40));
  if (!pref("enabled")) return;
  if (!text) {
    state.line = null;
    toOverlay("sub", { id: ++state.seq, text: "" });
    return;
  }
  const start = mpv.getNumber("sub-start");
  const end = mpv.getNumber("sub-end");
  if (state.line && state.line.text === text && Math.abs((state.line.start || 0) - start) < 0.01) return;
  const id = ++state.seq;
  state.line = { id, text, start, end };
  toOverlay("sub", { id, text, start, end });
  recordLine(text, start, end);
  provideTranslation(id, text);
}

function recordLine(text, start, end) {
  if (state.transcriptFromFile) {
    toSidebar("current", { start, text });
    return;
  }
  const last = state.lines[state.lines.length - 1];
  if (last && last.text === text) return;
  const ln = { text, start, end, tr: state.cache.get(text) || "" };
  // Keep chronological order even after seeking back.
  let i = state.lines.length;
  while (i > 0 && state.lines[i - 1].start > start) i--;
  if (state.lines[i - 1] && state.lines[i - 1].text === text) return;
  state.lines.splice(i, 0, ln);
  if (state.lines.length > 2000) state.lines.shift();
  toSidebar("line", ln);
  toSidebar("current", { start, text });
}

function onSecondaryText() {
  if (!state.line || !pref("translate") || !pref("useSecondary")) return;
  const sec = secondaryFor(state.line);
  if (sec) { clearTimeout(state.waitTimer); deliverTranslation(state.line.id, state.line.text, sec, "track"); }
}

// ---------------------------------------------------------------------------- translation
function deliverTranslation(id, text, tr, source) {
  state.cache.set(text, tr);
  if (source === "track") (state.trackTr || (state.trackTr = new Map())).set(text, tr);
  toOverlay("translation", { id, text, translation: tr, source });
  toSidebar("translation", { text, translation: tr });
}

function provideTranslation(id, text) {
  if (!hasChinese(text) || !pref("translate")) return;
  clearTimeout(state.waitTimer);
  if (pref("useSecondary") && hasSecondary()) {
    const sec = secondaryFor(state.line && state.line.id === id ? state.line : null);
    if (sec) { deliverTranslation(id, text, sec, "track"); return; }
    if (state.trackTr && state.trackTr.has(text)) { deliverTranslation(id, text, state.trackTr.get(text), "track"); return; }
    // The English cue may start a beat after the Chinese one; only translate on-device if it never comes.
    state.waitTimer = setTimeout(() => {
      if (state.line && state.line.id === id && !secondaryFor(state.line)) machineTranslate(id, text);
    }, 450);
    return;
  }
  machineTranslate(id, text);
}

function machineTranslate(id, text) {
  if (state.cache.has(text)) { deliverTranslation(id, text, state.cache.get(text), "cache"); return; }
  translateLines([text]).then(() => {
    if (state.cache.has(text) && state.line && state.line.id === id) {
      toOverlay("translation", { id, text, translation: state.cache.get(text), source: "apple" });
    }
  });
}

function sourceLang(texts) {
  // Traditional-only characters frequently seen in subtitles.
  const trad = /[們這說個會來時為麼還過對發後現與實點樣頭應經機關問題動開長電話誰嗎讓從聽覺東車國愛寫買賣場氣進見間學當業總]/g;
  const simp = /[们这说个会来时为么还过对发后现与实点样头应经机关问题动开长电话谁吗让从听觉东车国爱写买卖场气进见间学当业总]/g;
  const joined = texts.join("");
  return (joined.match(trad) || []).length > (joined.match(simp) || []).length ? "zh-Hant" : "zh-Hans";
}

function translateLines(texts) {
  texts = texts.filter((t) => hasChinese(t) && !state.cache.has(t) && !state.inflight.has(t));
  if (!texts.length || !HELPER) return Promise.resolve();
  if (state.helperStatus === "unavailable") return Promise.resolve();
  texts.forEach((t) => state.inflight.add(t));
  const src = sourceLang(texts);
  const tgt = targetLang();
  let args;
  let tmp = null;
  if (texts.length === 1) {
    args = ["text", src, tgt, texts[0]];
  } else {
    tmp = "@tmp/batch-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".json";
    file.write(tmp, JSON.stringify(texts));
    args = ["file", src, tgt, utils.resolvePath(tmp)];
  }
  const cleanup = () => { if (tmp) { try { file.delete(tmp); } catch (e) { /* ignore */ } } };
  return utils.exec(HELPER, args).then((res) => {
    cleanup();
    texts.forEach((t) => state.inflight.delete(t));
    let out = null;
    try { out = JSON.parse(String(res.stdout).trim().split("\n").pop()); } catch (e) { out = null; }
    if (!out) { console.error("hl-translate: " + res.stderr); return; }
    if (out.status && out.status !== "installed") {
      state.helperStatus = out.status;
      toOverlay("translationStatus", { status: out.status, source: src, target: tgt });
      toSidebar("translationStatus", { status: out.status, source: src, target: tgt });
      return;
    }
    state.helperStatus = "installed";
    (out.results || []).forEach((tr, i) => {
      if (tr) {
        state.cache.set(texts[i], tr);
        toSidebar("translation", { text: texts[i], translation: tr });
      }
    });
  }, (err) => {
    cleanup();
    texts.forEach((t) => state.inflight.delete(t));
    console.error("hl-translate failed: " + err);
  });
}

// ---------------------------------------------------------------------------- external subtitle files
function parseTime(s) {
  const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + parseFloat("0." + m[4]);
}
function parseSubtitleFile(text) {
  const out = [];
  text = text.replace(/^﻿/, "").replace(/\r/g, "");
  if (/^\[Script Info\]/m.test(text)) {
    let fmt = null;
    for (const line of text.split("\n")) {
      if (/^Format:/i.test(line) && fmt === null && /Text/.test(line) && /Start/.test(line)) {
        fmt = line.slice(7).split(",").map((s) => s.trim().toLowerCase());
      } else if (/^Dialogue:/i.test(line) && fmt) {
        const parts = line.slice(9).split(",");
        const ti = fmt.indexOf("text");
        const t = parts.slice(ti).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();
        if (t) out.push({ start: parseTime(parts[fmt.indexOf("start")]), end: parseTime(parts[fmt.indexOf("end")]), text: t });
      }
    }
  } else {
    for (const block of text.split(/\n{2,}/)) {
      const m = /(\d[\d:.,]+)\s*-->\s*(\d[\d:.,]+)[^\n]*\n([\s\S]*)/.exec(block);
      if (!m) continue;
      const t = m[3].replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
      if (t) out.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: t });
    }
  }
  out.sort((a, b) => a.start - b.start);
  // mpv joins simultaneous events with newlines; merge identical-time events the same way.
  const merged = [];
  for (const l of out) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.start - l.start) < 0.001 && Math.abs(prev.end - l.end) < 0.001) prev.text += "\n" + l.text;
    else merged.push(Object.assign({}, l));
  }
  return merged;
}

function loadTranscript() {
  state.lines = [];
  state.transcriptFromFile = false;
  let tracks = [];
  try { tracks = mpv.getNative("track-list") || []; } catch (e) { tracks = []; }
  const sid = mpv.getString("sid");
  const cur = tracks.find((t) => t.type === "sub" && String(t.id) === sid);
  if (cur && cur.external && cur["external-filename"] && /\.(srt|ass|ssa|vtt)$/i.test(cur["external-filename"])) {
    try {
      const path = decodeURIComponent(String(cur["external-filename"]).replace(/^file:\/\//, ""));
      const content = file.read(path, {});
      if (content) {
        const lines = parseSubtitleFile(String(content));
        if (lines.length) {
          state.lines = lines.map((l) => ({ text: l.text, start: l.start, end: l.end, tr: state.cache.get(l.text) || "" }));
          state.transcriptFromFile = true;
          prefetchTranslations();
        }
      }
    } catch (e) {
      console.warn("Could not read subtitle file: " + e);
    }
  }
  toSidebar("transcript", { lines: state.lines, fromFile: state.transcriptFromFile });
}

function prefetchTranslations() {
  if (!pref("translate") || !state.transcriptFromFile) return;
  // Translate outward from the current position, in batches, one batch at a time.
  const pos = mpv.getNumber("time-pos") || 0;
  const todo = state.lines
    .filter((l) => hasChinese(l.text) && !state.cache.has(l.text))
    .sort((a, b) => {
      const da = a.start >= pos - 5 ? a.start - pos : 1e6 + pos - a.start;
      const db = b.start >= pos - 5 ? b.start - pos : 1e6 + pos - b.start;
      return da - db;
    })
    .map((l) => l.text);
  const step = () => {
    if (!pref("translate")) return;
    const batch = todo.splice(0, 40).filter((t) => !state.cache.has(t));
    if (!batch.length || state.helperStatus === "supported" || state.helperStatus === "unsupported") return;
    translateLines(batch).then(() => setTimeout(step, 50));
  };
  step();
}

// ---------------------------------------------------------------------------- playback helpers
function pauseForLookup() {
  if (!pref("pauseOnLookup")) return;
  if (!mpv.getFlag("pause")) { core.pause(); state.pausedByUs = true; }
}
function resumeAfterLookup() {
  if (state.pausedByUs) { state.pausedByUs = false; core.resume(); }
}

// ---------------------------------------------------------------------------- overlay messages
function bindOverlay() {
  overlay.onMessage("ready", () => {
    dlog("overlay ready (pending " + pendingOverlay.length + ")");
    overlayReady = true;
    toOverlay("settings", settings());
    toOverlay("style", subStyle());
    if (oscInfo) toOverlay("osc", oscInfo);
    toOverlay("starred", { keys: starred().map((x) => x.simp + "|" + x.pinyin) });
    applyTakeover();
    while (pendingOverlay.length) { const [n, d] = pendingOverlay.shift(); toOverlay(n, d); }
    onSubText();
  });
  overlay.onMessage("card", (d) => {
    const open = !!(d && d.open);
    if (open && !state.cardOpen) pauseForLookup();
    if (!open && state.cardOpen) {
      if (d && d.keepPaused) state.pausedByUs = false; else resumeAfterLookup();
    }
    state.cardOpen = open;
  });
  overlay.onMessage("openSidebar", (d) => {
    openSidebar();
    toSidebar("lookup", d);
  });
  overlay.onMessage("star", (d) => toggleStar(d));
  overlay.onMessage("translateNow", (d) => {
    if (d && d.text) translateLines([d.text]).then(() => {
      if (state.cache.has(d.text)) toOverlay("translation", { id: d.id, text: d.text, translation: state.cache.get(d.text), source: "apple" });
    });
  });
  overlay.onMessage("hitmap", (d) => { hitmap = d; });
  overlay.onMessage("log", (d) => dlog("[overlay] " + JSON.stringify(d)));
}

function bindSidebar() {
  sidebar.onMessage("ready", () => {
    dlog("sidebar ready");
    sidebarReady = true;
    toSidebar("settings", settings());
    toSidebar("starred", { items: starred() });
    toSidebar("transcript", { lines: state.lines, fromFile: state.transcriptFromFile });
    if (state.line) toSidebar("current", { start: state.line.start, text: state.line.text });
    if (state.helperStatus === "supported" || state.helperStatus === "unsupported") {
      toSidebar("translationStatus", { status: state.helperStatus, source: "zh-Hans", target: targetLang() });
    }
  });
  sidebar.onMessage("seek", (d) => {
    if (d && typeof d.time === "number") { core.seekTo(Math.max(0, d.time + 0.01)); }
  });
  sidebar.onMessage("star", (d) => toggleStar(d));
  sidebar.onMessage("exportStarred", () => exportStarred());
  sidebar.onMessage("sidebarState", (d) => {
    state.sidebar = { visible: !!(d && d.visible), width: (d && +d.width) || 0 };
    pushInset();
  });
  sidebar.onMessage("setPref", (d) => {
    if (!d || typeof d.key !== "string") return;
    const def = DEFAULTS[d.key];
    if (typeof def === "boolean") changePref(d.key, !!d.value);
    else if (typeof def === "string") changePref(d.key, String(d.value || "").slice(0, 12));
  });
  sidebar.onMessage("openSettings", () => utils.open("iina://open-preferences?pane=plugins"));
  sidebar.onMessage("log", (d) => dlog("[sidebar] " + JSON.stringify(d)));
}

function openSidebar() {
  sidebar.show();
}

// ---------------------------------------------------------------------------- starred words
function starred() {
  try { return JSON.parse(preferences.get("starred") || "[]"); } catch (e) { return []; }
}
function toggleStar(d) {
  if (!d || !d.simp) return;
  let items = starred();
  const key = d.simp + "|" + d.pinyin;
  const i = items.findIndex((x) => x.simp + "|" + x.pinyin === key);
  if (i >= 0) items.splice(i, 1);
  else items.unshift({ simp: d.simp, trad: d.trad, pinyin: d.pinyin, def: d.def, added: Date.now(), context: d.context || "" });
  setPref("starred", JSON.stringify(items));
  toSidebar("starred", { items });
  toOverlay("starred", { keys: items.map((x) => x.simp + "|" + x.pinyin) });
  core.osd(i >= 0 ? "Removed " + d.simp + " from Starred" : "Starred " + d.simp);
}
function exportStarred() {
  const items = starred();
  if (!items.length) { core.osd("No starred words to export"); return; }
  // Pleco flashcard import format: headword[trad] <tab> pinyin <tab> definition
  const body = items.map((x) => {
    const head = x.trad && x.trad !== x.simp ? x.simp + "[" + x.trad + "]" : x.simp;
    return head + "\t" + x.pinyin + "\t" + String(x.def || "").replace(/\s+/g, " ");
  }).join("\n") + "\n";
  const stamp = new Date().toISOString().slice(0, 10);
  const path = "~/Downloads/Hanzi Lens Starred " + stamp + ".txt";
  file.write(path, body);
  file.showInFinder(path);
  core.osd("Exported " + items.length + " words for Pleco");
}

// ---------------------------------------------------------------------------- input
// High priority so we run before IINA's own bindings, and only consume keys while a card is open.
const PRIORITY_HIGH = 200;
function cardKey(name) {
  return () => {
    if (!state.cardOpen) return false;
    toOverlay("key", { key: name });
    return true;
  };
}
input.onKeyDown("LEFT", cardKey("left"), PRIORITY_HIGH);
input.onKeyDown("RIGHT", cardKey("right"), PRIORITY_HIGH);
input.onKeyDown("UP", cardKey("up"), PRIORITY_HIGH);
input.onKeyDown("DOWN", cardKey("down"), PRIORITY_HIGH);
input.onKeyDown("ESC", cardKey("escape"), PRIORITY_HIGH);
input.onKeyDown("ENTER", cardKey("enter"), PRIORITY_HIGH);
input.onKeyDown("s", cardKey("star"), PRIORITY_HIGH);
input.onKeyDown("p", cardKey("speak"), PRIORITY_HIGH);
// Clicks: the overlay is NOT made clickable (IINA's clickable-overlay hit test spins a nested run
// loop on every cursor update, which has crashed IINA). Instead the overlay publishes the rectangles
// of its interactive parts; we hit-test mouse events here and forward taps to the overlay.
let hitmap = null;      // {h, rects: [[l, t, r, b], ...]} in overlay (top-left) coordinates
let down = null;        // mouse-down that landed on an interactive part
function hitAt(ev) {
  if (!hitmap || !ev) return null;
  const x = ev.x, y = hitmap.h - ev.y;  // IINA passes window coordinates (origin bottom-left)
  for (const r of hitmap.rects) if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return { x, y };
  return null;
}
input.onMouseDown(input.MOUSE, (ev) => {
  const hit = hitAt(ev);
  down = hit;
  if (!hit && state.cardOpen) toOverlay("key", { key: "dismiss" });
  return !!hit;
}, PRIORITY_HIGH);
input.onMouseUp(input.MOUSE, (ev) => {
  refreshOSCSoon();
  if (!down) return false;
  const start = down;
  down = null;
  const hit = hitAt(ev);
  // A drag (e.g. moving the window) that started on a word is not a click.
  if (!hit || Math.abs(hit.x - start.x) > 4 || Math.abs(hit.y - start.y) > 4) return true;
  toOverlay("tap", { x: hit.x, y: hit.y });
  return true;   // don't let IINA also run its single/double-click action
}, PRIORITY_HIGH);

// ---------------------------------------------------------------------------- menu
// IINA's JS menu items keep an *unowned* reference to their NSMenuItem, which IINA frees whenever it
// rebuilds the Plugin menu. Setting `.selected` on an old item afterwards aborts IINA, so items are
// never mutated: the whole menu is rebuilt from current preferences instead.
// IINA shows only five first-level items per plugin and pushes the rest into a "More…" submenu, so
// the menu carries the three shortcuts worth a key binding; everything else lives in the sidebar's
// Settings view.
const AFTER = {
  enabled: () => {
    applyTakeover();
    core.osd(pref("enabled") ? "Hanzi Lens on" : "Hanzi Lens off");
    onSubText();
  },
  translate: () => {
    core.osd(pref("translate") ? "Translation shown" : "Translation hidden");
    if (pref("translate") && state.line) provideTranslation(state.line.id, state.line.text);
    if (pref("translate")) prefetchTranslations();
  },
  useSecondary: () => {
    syncSecondary();
    if (state.line) provideTranslation(state.line.id, state.line.text);
  },
  autoSelect: () => { autoSelectChineseTrack(); },
};
function changePref(key, value) {
  if (!(key in DEFAULTS)) return;
  setPref(key, value);
  settingsChanged();
  if (AFTER[key]) AFTER[key]();
}
const TOGGLES = [
  ["enabled", "Interactive Chinese Subtitles", "Alt+Meta+l"],
  ["pinyin", "Show Pinyin", "Alt+Meta+p"],
  ["translate", "Show Translation", "Alt+Meta+t"],
];
function buildMenu() {
  menu.removeAllItems();
  for (const [key, title, keyBinding] of TOGGLES) {
    menu.addItem(menu.item(title, () => changePref(key, !pref(key)), { selected: !!pref(key), keyBinding }));
  }
  menu.addItem(menu.item("Show Dictionary", () => {
    openSidebar();
    if (state.line) toSidebar("lookupLine", { text: state.line.text });
  }, { keyBinding: "Alt+Meta+d" }));
  menu.addItem(menu.item("Settings…", () => { openSidebar(); toSidebar("showSettings", {}); }, { keyBinding: "Alt+Meta+," }));
}
let menuRebuildPending = false;
function rebuildMenuSoon() {
  // Deferred: never rebuild from inside a menu action while AppKit is still dispatching it.
  if (menuRebuildPending) return;
  menuRebuildPending = true;
  setTimeout(() => { menuRebuildPending = false; buildMenu(); menu.forceUpdate(); }, 0);
}
function pushSettings() {
  toOverlay("settings", settings());
  toSidebar("settings", settings());
}
let lastSettings = JSON.stringify(settings());
function settingsChanged() {
  const now = JSON.stringify(settings());
  if (now === lastSettings) return;
  const was = JSON.parse(lastSettings);
  lastSettings = now;
  pushSettings();
  rebuildMenuSoon();
  if (was.enabled !== pref("enabled")) applyTakeover();
  else if (was.translate !== pref("translate") || was.useSecondary !== pref("useSecondary")) syncSecondary();
}
buildMenu();

// Preferences can also change from the IINA settings page; pick those up.
setInterval(settingsChanged, 1500);

// ---------------------------------------------------------------------------- events
event.on("iina.window-loaded", () => {
  overlay.loadFile("ui/overlay.html");
  sidebar.loadFile("ui/sidebar.html");
  setTimeout(() => {
    bindOverlay();
    bindSidebar();
    overlay.setClickable(false);
    overlay.show();
  }, 0);
});
// IINA only accepts overlay listeners once the page has finished loading, and the page announces
// "ready" while still loading — so after each load, bind and ask both pages to announce again.
event.on("iina.plugin-overlay-loaded", () => {
  dlog("plugin-overlay-loaded");
  bindOverlay();
  bindSidebar();
  overlay.postMessage("ping", enc({}));
  sidebar.postMessage("ping", enc({}));
});
// IINA observes mpv properties as numbers, so string properties (sub-text, sid, sub-color…) never
// raise change events for plugins. Poll them instead: a property read is a cheap synchronous call.
const polled = { text: null, sec: null, sid: null, style: null };
setInterval(() => {
  const text = mpv.getString("sub-text") || "";
  if (text !== polled.text) { polled.text = text; onSubText(); }
  const sec = mpv.getString("secondary-sub-text") || "";
  if (sec !== polled.sec) { polled.sec = sec; onSecondaryText(); }
  const sid = mpv.getString("sid") || "";
  if (sid !== polled.sid) {
    const first = polled.sid === null;
    polled.sid = sid;
    state.trackChangedAt = Date.now();
    if (!first) { dlog("sid -> " + sid); applyTakeover(); loadTranscript(); onSubText(); }
    else syncSecondary();
  }
  if (state.takeover && hasSecondary() && mpv.getFlag("secondary-sub-visibility")) mpv.set("secondary-sub-visibility", false);
  if (state.takeover && mpv.getFlag("sub-visibility")) {
    // mpv's own copy stays hidden while Hanzi Lens draws the line. Two things turn it back on:
    // IINA itself right after a file/track loads (ignored), and the user's Show/Hide Subtitles
    // toggle — mpv's flag is always off, so every press arrives here as "on" and flips our line.
    mpv.set("sub-visibility", false);
    if (Date.now() - state.trackChangedAt > 2500) {
      state.userHidden = !state.userHidden;
      toOverlay("visible", { visible: !state.userHidden });
      setTimeout(() => core.osd(state.userHidden ? "Subtitles hidden" : "Subtitles shown"), 50);
    }
  }
}, 80);
setInterval(() => {
  const st = JSON.stringify(subStyle());
  if (st !== polled.style) { polled.style = st; toOverlay("style", subStyle()); }
}, 1000);
event.on("iina.window-will-close", () => { dormant = true; });
event.on("mpv.file-loaded", () => {
  dormant = false;
  state.trackChangedAt = Date.now();
  autoSelectChineseTrack();
  state.line = null;
  state.cardOpen = false;
  state.pausedByUs = false;
  toOverlay("sub", { id: ++state.seq, text: "" });
  state.trackTr = new Map();
  applyTakeover();
  loadTranscript();
  // Streams can list their tracks a moment after the file loads.
  setTimeout(() => { if (!dormant) { autoSelectChineseTrack(); syncSecondary(); } }, 1500);
});


