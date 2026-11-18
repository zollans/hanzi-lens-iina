/* Hanzi Lens — UI helpers shared by overlay and sidebar. */
(function (root) {
  "use strict";

  // Animation time scale. `?slow=10` in the page URL slows every animation for frame inspection.
  let slow = parseFloat(new URLSearchParams(location.search).get("slow") || "1") || 1;
  const T = (ms) => ms * slow;
  const setSlow = (n) => { slow = n > 0 ? n : 1; };

  // macOS-feeling curves.
  const EASE = {
    out: "cubic-bezier(0.16, 1, 0.3, 1)",        // spring-like settle (popover open, glide)
    inOut: "cubic-bezier(0.45, 0, 0.2, 1)",
    in: "cubic-bezier(0.5, 0, 0.75, 0)",          // quick exits
    std: "cubic-bezier(0.25, 0.1, 0.25, 1)",      // CSS ease, AppKit default-ish
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  /** Pinyin (numeric) -> fragment of tone-classed spans. */
  function pinyinNode(numeric, opts) {
    opts = opts || {};
    const frag = h("span", { class: "py" + (opts.colors === false ? " nocolor" : "") });
    const syls = HL.syllables(numeric);
    syls.forEach((s, i) => {
      const txt = opts.zhuyin && s.tone ? HL.syllableToZhuyin(s.raw) : s.text;
      const syl = h("span", { class: "t" + (s.tone || 0) }, txt);
      if (opts.shapes) syl.appendChild(toneShape(s.tone || 5));
      frag.appendChild(syl);
      if (i < syls.length - 1) frag.appendChild(document.createTextNode(opts.zhuyin ? " " : " "));
    });
    return frag;
  }

  /** Pitch contour for a tone (Chao tone letters 55, 35, 214, 51, neutral): a color-free cue. */
  const TONE_PATHS = {
    1: "M3 3.2H13",
    2: "M3 7.6L13 3.2",
    3: "M3 5.6C5.4 11.6 8.2 11.6 13 3.8",
    4: "M3 3.2L13 10",
  };
  const TONE_NAMES = { 1: "level tone", 2: "rising tone", 3: "dipping tone", 4: "falling tone", 5: "neutral tone" };
  function toneShape(tone) {
    const ns = "http://www.w3.org/2000/svg";
    const mk = (tag, attrs) => { const el = document.createElementNS(ns, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
    const svg = mk("svg", { viewBox: "0 0 16 13", class: "tshape", role: "img", "aria-label": TONE_NAMES[tone] || "" });
    svg.appendChild(mk("rect", { class: "frame", x: "0.5", y: "0.5", width: "15", height: "12", rx: "3" }));
    svg.appendChild(TONE_PATHS[tone] ? mk("path", { class: "contour", d: TONE_PATHS[tone] }) : mk("circle", { class: "contour", cx: "8", cy: "8", r: "1.7" }));
    return svg;
  }

  function sylText(s, zhuyin) {
    return zhuyin && s.tone ? HL.syllableToZhuyin(s.raw) : s.text;
  }

  /** Clean CC-CEDICT definition text and split out measure words ("CL:个[ge4],位[wei4]"). */
  function splitDefs(defs) {
    const out = [];
    const cls = [];
    for (let d of defs) {
      const m = /^CL:(.*)$/.exec(d);
      if (m) {
        for (const part of m[1].split(",")) {
          const mm = /^([^\[|]+)(?:\|([^\[]+))?\[([^\]]+)\]/.exec(part.trim());
          if (mm) cls.push({ trad: mm[1], simp: mm[2] || mm[1], pinyin: mm[3] });
        }
        continue;
      }
      out.push(d);
    }
    return { defs: out, classifiers: cls };
  }

  /** Render "see 道行[dao4 heng2]" style references as linked hanzi + marked pinyin. */
  function defNode(text, onWord, opts) {
    const el = h("span", { class: "def" });
    const re = /([㐀-鿿豈-﫿]+)(?:\|([㐀-鿿豈-﫿]+))?\[([^\]]+)\]|([㐀-鿿豈-﫿]+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      const word = m[4] || (opts && opts.trad ? m[1] : (m[2] || m[1]));
      const link = h("span", { class: "ref", "data-clickable": true, onclick: (e) => { e.stopPropagation(); onWord && onWord(word); } }, word);
      el.appendChild(link);
      if (m[3]) {
        const py = pinyinNode(m[3], opts);
        py.classList.add("refpy");
        el.appendChild(document.createTextNode(" "));
        el.appendChild(py);
      }
      last = re.lastIndex;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
    return el;
  }

  // ------------------------------------------------------------------ speech
  let voices = [];
  function loadVoices() { try { voices = speechSynthesis.getVoices(); } catch (e) { voices = []; } }
  if (root.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  function speak(text, lang) {
    if (!root.speechSynthesis) return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    lang = lang || "zh-CN";
    u.lang = lang;
    const exact = voices.filter((v) => v.lang.replace("_", "-") === lang);
    const any = voices.filter((v) => /^zh/i.test(v.lang));
    const pick = (list) => list.find((v) => /premium|enhanced/i.test(v.name)) || list.find((v) => !/compact/i.test(v.voiceURI)) || list[0];
    const v = pick(exact) || pick(any);
    if (v) u.voice = v;
    u.rate = 0.9;
    speechSynthesis.speak(u);
    return true;
  }

  // ------------------------------------------------------------------ messaging
  function onMessage(name, cb) {
    iina.onMessage(name, (data) => {
      let d = data;
      if (typeof d === "string") {
        try { d = JSON.parse(decodeURIComponent(d)); } catch (e) { /* plain string */ }
      }
      cb(d);
    });
  }
  function post(name, data) { iina.postMessage(name, data === undefined ? {} : data); }

  /** Mark an element and all descendants as hit-testable for IINA's overlay. */
  function clickable(el) {
    el.dataset.clickable = "";
    el.querySelectorAll("*").forEach((n) => { n.dataset.clickable = ""; });
    return el;
  }

  const ICONS = {
    gear: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.6 2.8h2.8l.4 1.9 1.3.6 1.7-1 2 2-1 1.7.6 1.3 1.9.4v2.8l-1.9.4-.6 1.3 1 1.7-2 2-1.7-1-1.3.6-.4 1.9H8.6l-.4-1.9-1.3-.6-1.7 1-2-2 1-1.7-.6-1.3-1.9-.4V8.9l1.9-.4.6-1.3-1-1.7 2-2 1.7 1 1.3-.6z" transform="translate(1.2 1.2) scale(.88)" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    speaker: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5h2.6L10 4.3v11.4l-3.9-3.2H3.5a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5z" fill="currentColor"/><path d="M12.6 7.2a3.8 3.8 0 0 1 0 5.6M14.7 5.2a6.6 6.6 0 0 1 0 9.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    star: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.9l2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.7 5.7 16l.9-4.8L3.1 7.9l4.8-.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    starFill: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.9l2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.7 5.7 16l.9-4.8L3.1 7.9l4.8-.6z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    sidebar: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12.25 4.5v11" stroke="currentColor" stroke-width="1.4"/></svg>',
    chevronLeft: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevronRight: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12.4 12.4l4.1 4.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    clear: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="currentColor"/><path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2" stroke="var(--clear-x, #fff)" stroke-width="1.5" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 4.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L7.4 4.1a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.75" y="6.75" width="9.5" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M13.25 4.5v-.25a1.5 1.5 0 0 0-1.5-1.5h-6.5a1.5 1.5 0 0 0-1.5 1.5v8a1.5 1.5 0 0 0 1.5 1.5h.25" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  };

  root.UI = { h, T, EASE, setSlow, pinyinNode, sylText, splitDefs, defNode, speak, onMessage, post, clickable, ICONS };
})(window);
