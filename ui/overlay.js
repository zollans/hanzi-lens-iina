/* Hanzi Lens — video overlay: interactive subtitle line + lookup card. */
(function () {
  "use strict";
  const { h, T, EASE, ICONS } = UI;

  const $sub = document.getElementById("sub");
  const $zh = document.getElementById("zh");
  const $tr = document.getElementById("tr");
  const $card = document.getElementById("card");
  const $body = document.getElementById("card-body");
  const $clip = $card.querySelector(".card-clip");
  const $arrow = document.getElementById("card-arrow");

  const S = {
    settings: { enabled: true, pinyin: true, zhuyin: false, toneColors: false, blurTranslation: false },
    style: null,
    line: null,          // {id, text}
    tokens: [],          // [{text, han, known, el, lineText, pos}]
    sel: -1,             // selected token index
    stack: [],           // drill-down history: [{word}]
    word: null,          // word shown in card
    open: false,
    closing: null,
    starred: new Set(),
    lastPlacement: null, // {mode, x, y, ax}
    visible: true,
  };

  // ------------------------------------------------------------------ settings & style
  function applySettings() {
    const s = S.settings;
    document.body.classList.toggle("tones", s.toneColors === true);
    document.body.classList.toggle("shapes", s.toneShapes !== false);
    document.body.classList.toggle("zhuyin", !!s.zhuyin);
    document.body.classList.toggle("blur-tr", !!s.blurTranslation);
    document.body.classList.toggle("no-tr", s.translate === false);
    document.body.classList.toggle("off", s.enabled === false || !S.visible);
    if (s.debugSlow) UI.setSlow(s.debugSlow);
  }

  function mpvColor(c, fallback) {
    // mpv colors: "#AARRGGBB" or "#RRGGBB" or "r/g/b/a" floats
    if (!c) return fallback;
    let m = /^#([0-9a-f]{2})?([0-9a-f]{6})$/i.exec(c);
    if (m) {
      const a = m[1] ? parseInt(m[1], 16) / 255 : 1;
      const rgb = m[2];
      return `rgba(${parseInt(rgb.slice(0, 2), 16)},${parseInt(rgb.slice(2, 4), 16)},${parseInt(rgb.slice(4, 6), 16)},${a})`;
    }
    m = /^([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?$/.exec(c);
    if (m) return `rgba(${m[1] * 255},${m[2] * 255},${m[3] * 255},${m[4] === undefined ? 1 : m[4]})`;
    return fallback;
  }

  function applyStyle() {
    // Mirror libass: metrics are in "scaled pixels" against a 720-line OSD when subtitles scale
    // with the window, or fixed when IINA's "scale with window" is off.
    const st = S.style || {};
    const H = window.innerHeight || 720, W = window.innerWidth || 1280;
    const k = st.scaleByWindow === false ? 1 : H / 720;
    const size = (st.fontSize || 55) * (st.scale || 1) * k * 0.92; // CJK glyphs read larger than libass metrics
    const sk = (st.scale || 1) * k;                                  // outline/shadow/spacing scale like the font
    const r = document.documentElement.style;
    r.setProperty("--sub-size", size.toFixed(2) + "px");
    r.setProperty("--sub-border", Math.max(0, (st.border === undefined ? 3 : st.border) * sk * 0.62).toFixed(2) + "px");
    r.setProperty("--sub-color", mpvColor(st.color, "#fff"));
    r.setProperty("--sub-border-color", mpvColor(st.borderColor, "#000"));
    const back = mpvColor(st.backColor, "rgba(0,0,0,0)");
    const box = /box/.test(st.borderStyle || "");
    const sh = (st.shadow || 0) * sk;
    // outline-and-shadow: the back color is the drop shadow; the box styles paint it behind each line.
    const halo = "0 0 0.07em rgba(0,0,0,0.42), 0 0.03em 0.26em rgba(0,0,0,0.34)";
    const own = !box && sh > 0 ? `${sh.toFixed(2)}px ${sh.toFixed(2)}px 0 ${back}` : "";
    r.setProperty("--sub-shadow", box ? "none" : [own, halo].filter(Boolean).join(", "));
    r.setProperty("--sub-box", box ? back : "transparent");
    r.setProperty("--sub-spacing", ((st.spacing || 0) * sk).toFixed(2) + "px");
    r.setProperty("--sub-blur", st.blur > 0 ? `blur(${(st.blur * sk * 0.5).toFixed(2)}px)` : "none");
    const font = st.font && !/^(sans-serif|serif|monospace)$/i.test(st.font) ? `"${st.font.replace(/"/g, "")}"` : '"PingFang SC"';
    r.setProperty("--sub-font", font);
    $zh.classList.toggle("bold", !!st.bold);
    $sub.classList.toggle("italic", !!st.italic);
    $sub.classList.toggle("boxed", box);

    // Position: alignment + margins + IINA's position slider (sub-pos, 100 = bottom).
    const mY = (st.marginY === undefined ? 22 : st.marginY) * k;
    const mX = (st.marginX === undefined ? 25 : st.marginX) * k;
    // The part of the window not covered by the plugin sidebar (ignored if too little is left).
    let iL = (S.inset && S.inset.l) || 0, iR = (S.inset && S.inset.r) || 0;
    if (W - iL - iR < 320) iL = iR = 0;
    const free = W - iL - iR;
    const pos = st.pos === undefined ? 100 : st.pos;
    const ay = st.alignY || "bottom", ax = st.alignX || "center";
    const s2 = $sub.style;
    s2.top = s2.bottom = s2.left = s2.right = "";
    let tx = "0", ty = "0";
    if (ay === "top") s2.top = mY.toFixed(2) + "px";
    else if (ay === "center") { s2.top = "50%"; ty = "-50%"; }
    else {
      const b = Math.max(mY + ((100 - pos) / 100) * H, S.oscShown ? controlBarClearance() : 0);
      s2.bottom = `calc(${b.toFixed(2)}px + var(--tr-reserve) + var(--tr-extra, 0px))`;
    }
    if (ax === "left") { s2.left = (iL + mX).toFixed(2) + "px"; }
    else if (ax === "right") { s2.right = (iR + mX).toFixed(2) + "px"; }
    else { S.centerX = iL + free / 2; }
    S.centered = ax === "center";
    s2.transform = `translate(${tx}, ${ty})`;
    s2.textAlign = ax === "left" ? "left" : ax === "right" ? "right" : "center";
    s2.maxWidth = (free - 2 * mX).toFixed(0) + "px";
    $tr.style.maxWidth = s2.maxWidth;
    $tr.style.left = ax === "left" ? "0" : "auto";
    $tr.style.right = ax === "right" ? "0" : "auto";
    $tr.style.transform = "none";
    snapLine();
  }
  /** Centers the line and its translation on whole pixels. Centering with translate(-50%) lands odd
   *  widths on half pixels, and WebKit then draws new text soft for a moment before sharpening it. */
  function snapLine() {
    if (!S.centered) return;
    const w = $sub.offsetWidth;
    $sub.style.left = Math.round(S.centerX - w / 2) + "px";
    $tr.style.left = Math.round((w - $tr.offsetWidth) / 2) + "px";
  }
  /** Distance from the window bottom the subtitle must keep to stay clear of IINA's controls. */
  // ------------------------------------------------------------------ dodging IINA's controls
  // Plugins get no event when IINA shows or hides its control bar, so mirror IINA's own rule
  // (MainWindowController.mouseMoved/mouseExited): any pointer movement in the window shows it;
  // it stays while the pointer is over it; it hides after controlBarAutoHideTimeout seconds of
  // stillness or when the pointer leaves the window. The line rises only while the bar is up.
  S.oscShown = true;
  let oscTimer = 0;
  function oscRect() {
    const o = S.osc;
    if (!o) return null;
    const W = window.innerWidth, H = window.innerHeight;
    if (o.pos === 1) return { l: 0, t: 0, r: W, b: 56 };
    if (o.pos === 2) return { l: 0, t: H - 56, r: W, b: H };
    const w = 460, hgt = 67;
    let bottom = Math.max(0, H * o.v);
    if (bottom + hgt + 25 > H) bottom = H - hgt - 25;
    const cx = Math.min(Math.max(W * o.h, w / 2), W - w / 2);
    return { l: cx - w / 2, t: H - bottom - hgt, r: cx + w / 2, b: H - bottom };
  }
  function setOscShown(v) {
    if (S.osc && S.osc.autoHide === false) v = true;
    if (v === S.oscShown) return;
    if (!v && S.open) { armOscTimer(); return; }   // keep the line put while a card hangs off it
    S.oscShown = v;
    $sub.classList.add("dodging");
    applyStyle();
    clearTimeout(setOscShown.t);
    setOscShown.t = setTimeout(() => { $sub.classList.remove("dodging"); publishHitmap(); }, 300);
  }
  function armOscTimer() {
    clearTimeout(oscTimer);
    const secs = (S.osc && S.osc.timeout) || 2.5;
    oscTimer = setTimeout(() => setOscShown(false), secs * 1000);
  }
  document.addEventListener("mousemove", (e) => {
    setOscShown(true);
    const r = oscRect();
    const inBar = r && e.clientX >= r.l && e.clientX <= r.r && e.clientY >= r.t && e.clientY <= r.b;
    const inTitle = e.clientY < 28;
    if (inBar || inTitle) clearTimeout(oscTimer); else armOscTimer();
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { clearTimeout(oscTimer); setOscShown(false); });
  armOscTimer();

  function controlBarClearance() {
    const o = S.osc;
    if (!o) return 0;
    const W = window.innerWidth, H = window.innerHeight;
    if (o.pos === 1) return 0;                 // controls on top
    if (o.pos === 2) return 56 + 14;           // full-width bottom bar
    // Floating bar: IINA's own geometry (OSCFloatingView: 460×67pt, clamped inside the window).
    const oscH = 67;
    let bottom = Math.max(0, H * o.v);
    if (bottom + oscH + 25 > H) bottom = H - oscH - 25;
    if (bottom > H * 0.45) return 0;           // bar dragged up out of the subtitle's way
    // Bar dragged off to one side: only dodge when this line would actually run into it.
    const r = oscRect();
    const box = $sub.getBoundingClientRect();
    const half = Math.max(box.width, $tr.offsetWidth) / 2, mid = box.left + box.width / 2;
    if (r && box.width && (mid + half + 14 < r.l || mid - half - 14 > r.r)) return 0;
    return bottom + oscH + 16;
  }

  window.addEventListener("resize", () => {
    applyStyle();
    fitPlates();
    publishHitmap();
    if (S.open) placeCard(false);
  });

  // ------------------------------------------------------------------ subtitle rendering
  function renderLine(line) {
    S.line = line;
    S.tokens = [];
    $zh.textContent = "";
    $tr.textContent = "";
    $tr.classList.remove("shown");
    fitTranslation();
    if (!line || !line.text) { $sub.hidden = true; publishHitmap(); return; }
    $sub.hidden = false;
    const lang = HL.scriptOf(line.text);
    $zh.lang = lang;
    const ruby = !!S.settings.pinyin;
    $zh.classList.toggle("ruby", ruby);
    for (const lineText of line.text.split("\n")) {
      const row = h("span", { class: "line" });
      const toks = HL.segment(lineText);
      for (const t of toks) {
        const idx = S.tokens.length;
        const tok = { text: t.text, han: t.han, known: t.known, pos: t.start, lineText };
        const canLook = t.han && (t.known || Array.from(t.text).some((c) => HL.charInfo(c).ud || HL.charInfo(c).md));
        let el;
        if (t.han) {
          el = h("span", { class: "w" + (canLook ? "" : " plain"), dataset: { i: idx } });
          // Reading aids over the line are lower-case (CC-CEDICT capitalises names and weekdays).
          const reading = ruby && t.known ? HL.bestReading(t.text).toLowerCase() : "";
          const syls = reading ? sandhi(t.text, HL.syllables(reading), toks, toks.indexOf(t)) : [];
          const chars = Array.from(t.text);
          if (ruby && syls.length === chars.length) {
            chars.forEach((c, i) => el.appendChild(h("ruby", null, c, h("rt", { class: "t" + syls[i].tone }, UI.sylText(syls[i], S.settings.zhuyin)))));
          } else if (ruby && syls.length) {
            el.appendChild(h("ruby", null, t.text, h("rt", { class: "t0" }, syls.map((s) => UI.sylText(s, S.settings.zhuyin)).join(" "))));
          } else if (ruby) {
            const info = chars.length === 1 ? HL.charInfo(chars[0]) : null;
            const um = info && info.um ? info.um.split(" ")[0] : "";
            el.appendChild(h("ruby", null, t.text, h("rt", { class: "t0" }, um || " ")));
          } else {
            el.textContent = t.text;
          }
          if (canLook) el.addEventListener("click", onWordClick);
        } else {
          el = h("span", { class: "w plain" }, t.text);
        }
        tok.el = el;
        S.tokens.push(tok);
        row.appendChild(el);
      }
      $zh.appendChild(row);
    }
    if (S.osc && S.osc.pos === 0 && S.oscShown && !S.open) applyStyle();   // new line width: re-check the bar
    fitPlates();
    snapLine();
    UI.clickable($sub);
    publishHitmap();
  }

  /** Spoken tone changes for 一 and 不 (dictionary form stays in the card). */
  function sandhi(word, syls, toks, ti) {
    if (word !== "一" && word !== "不") return syls;
    const next = toks[ti + 1];
    if (!next || !next.han) return syls;
    const nr = HL.bestReading(next.text);
    const nt = nr ? HL.syllables(nr)[0] : null;
    if (!nt || !nt.tone) return syls;
    const prev = toks[ti - 1];
    // Ordinals / numbers keep yī (第一, 一一, 十一); 一 at a list end too.
    if (word === "一" && prev && /[第十〇零一二三四五六七八九百千万]$/.test(prev.text)) return syls;
    let tone;
    if (word === "不") tone = nt.tone === 4 ? 2 : 4;
    else tone = nt.tone === 4 || nt.tone === 5 ? 2 : 4;
    const raw = (word === "一" ? "yi" : "bu") + tone;
    return [{ text: HL.syllables(raw)[0].text, tone, raw }];
  }

  $tr.addEventListener("click", (e) => { e.stopPropagation(); $tr.classList.toggle("revealed"); });

  /** A translation that still wraps (long or two-speaker lines) lifts the Chinese line by the extra
   *  height, so it never runs into IINA's controls or off the bottom of the window. */
  function fitTranslation() {
    const reserve = parseFloat(getComputedStyle($tr).fontSize) * 1.55 || 0;
    const extra = $tr.textContent ? Math.max(0, $tr.offsetHeight - reserve) : 0;
    document.documentElement.style.setProperty("--tr-extra", extra.toFixed(1) + "px");
    if (S.osc && S.osc.pos === 0 && S.oscShown && !S.open) applyStyle();   // line width changed: re-check the bar
    snapLine();
  }
  function showTranslation(text) {
    $tr.classList.remove("revealed");
    $tr.textContent = text || "";
    UI.clickable($tr);
    if (!text) { $tr.classList.remove("shown"); return; }
    // Fade in only when it arrives late; when it's already known with the line, show at once like a real subtitle.
    fitTranslation();
    $tr.classList.add("shown");
    publishHitmap();
  }

  // Keep the card attached to its word if the line reflows (font change, window resize, wrap).
  new ResizeObserver(() => { snapLine(); if (S.open && !S.closing) placeCard(true); }).observe($zh);


  // ------------------------------------------------------------------ selection
  function onWordClick(e) {
    e.stopPropagation();
    const i = +e.currentTarget.dataset.i;
    if (S.open && S.sel === i && S.stack.length === 0) { closeCard(); return; }
    select(i);
  }

  function select(i) {
    const tok = S.tokens[i];
    if (!tok) return;
    S.tokens.forEach((t) => t.el.classList.remove("sel"));
    tok.el.classList.add("sel");
    S.sel = i;
    S.stack = [];
    showWord(tok.text, { context: tok.lineText });
  }

  function selectable(i) {
    const t = S.tokens[i];
    return t && t.han && !t.el.classList.contains("plain");
  }
  function step(dir) {
    if (!S.tokens.length) return;
    let i = S.sel;
    for (let n = 0; n < S.tokens.length; n++) {
      i += dir;
      if (i < 0 || i >= S.tokens.length) return;
      if (selectable(i)) { select(i); return; }
    }
  }

  // ------------------------------------------------------------------ card content
  function groupEntries(entries) {
    // Merge entries that share a reading (CC-CEDICT splits some by traditional form).
    const groups = [];
    for (const e of entries) {
      const g = groups.find((x) => x.pinyin.toLowerCase() === e.pinyin.toLowerCase());
      if (g) { g.defs = g.defs.concat(e.defs); g.hsk = g.hsk || e.hsk; g.hskOld = g.hskOld || e.hskOld; }
      else groups.push(Object.assign({}, e, { defs: e.defs.slice() }));
    }
    return groups;
  }

  function shortGloss(c) {
    const e = HL.lookup(c)[0];
    let d = e ? UI.splitDefs(e.defs).defs[0] : (HL.charInfo(c).md || HL.charInfo(c).ud || "");
    d = (d || "").replace(/\(.*?\)\s*/g, "").replace(/\[.*?\]/g, "").split(/[;,]/)[0].trim();
    return d.length > 18 ? d.slice(0, 17) + "…" : d;
  }

  function pyOpts() { return { colors: S.settings.toneColors === true, zhuyin: false }; }

  function buildCard(word) {
    const entries = groupEntries(HL.lookup(word));
    const frag = document.createDocumentFragment();
    const isTrad = HL.scriptOf(word) === "zh-Hant";

    if (S.stack.length) {
      const prev = S.stack[S.stack.length - 1];
      frag.appendChild(h("div", { class: "back", onclick: (e) => { e.stopPropagation(); goBack(); } },
        h("span", { html: ICONS.chevronLeft }), prev.word));
    }

    if (!entries.length) {
      const info = HL.charInfo(word);
      const box = h("div", { class: "empty" },
        h("div", { class: "hw", lang: isTrad ? "zh-Hant" : "zh-Hans" }, word),
        info.um ? h("div", { class: "pyline" }, h("span", { class: "py" }, info.um)) : null,
        h("ul", { class: "defs single" }, h("li", null, info.md || info.ud || "No dictionary entry")));
      frag.appendChild(box);
      return frag;
    }

    const first = entries[0];
    const alt = isTrad ? first.simp : first.trad;
    const key = first.simp + "|" + first.pinyin;
    const starred = S.starred.has(key);

    const speakBtn = h("button", { class: "ib", title: "Speak (P)", "aria-label": "Speak", html: ICONS.speaker, onclick: (e) => { e.stopPropagation(); speakWord(word, speakBtn); } });
    const starBtn = h("button", { class: "ib" + (starred ? " on" : ""), title: "Star (S)", "aria-label": "Star", html: starred ? ICONS.starFill : ICONS.star, onclick: (e) => { e.stopPropagation(); starWord(first, starBtn); } });

    const badges = h("span", { class: "badges" },
      first.hsk ? h("span", { class: "badge hsk", title: "HSK 3.0 level" }, "HSK " + (first.hsk >= 7 ? "7–9" : first.hsk)) : null,
      !first.hsk && first.hskOld ? h("span", { class: "badge", title: "HSK 2.0 level" }, "HSK " + first.hskOld) : null);

    const pyl = h("div", { class: "pyline" }, UI.pinyinNode(first.pinyin, Object.assign(pyOpts(), { shapes: S.settings.toneShapes !== false })));
    if (S.settings.zhuyin) pyl.appendChild(h("span", { class: "zy" }, HL.syllables(first.pinyin).map((s) => HL.syllableToZhuyin(s.raw)).join(" ")));
    if (badges.childNodes.length) pyl.appendChild(badges);

    frag.appendChild(h("div", { class: "hd" },
      h("div", { class: "hd-main" },
        h("div", { class: "hw", lang: isTrad ? "zh-Hant" : "zh-Hans" }, word, alt && alt !== word ? h("span", { class: "alt" }, alt) : null),
        pyl),
      h("div", { class: "tools" }, speakBtn, starBtn)));

    frag.appendChild(defsBlock(first, 5, isTrad));

    const others = entries.slice(1);
    others.slice(0, 2).forEach((e) => {
      const r = h("div", { class: "reading" }, h("div", { class: "pyline" }, UI.pinyinNode(e.pinyin, pyOpts())));
      r.appendChild(defsBlock(e, 2, isTrad));
      frag.appendChild(r);
    });
    if (others.length > 2) {
      frag.appendChild(h("div", { class: "more-readings" }, `${others.length - 2} more reading${others.length - 2 > 1 ? "s" : ""} in the sidebar`));
    }

    const chars = Array.from(word);
    if (chars.length > 1) {
      const syls = HL.syllables(first.pinyin);
      const row = h("div", { class: "chars" });
      chars.forEach((c, i) => {
        const s = syls.length === chars.length ? syls[i] : null;
        row.appendChild(h("span", { class: "chip", title: "Look up " + c, onclick: (e) => { e.stopPropagation(); drill(c); } },
          h("span", { class: "ch", lang: isTrad ? "zh-Hant" : "zh-Hans" }, c),
          s ? (() => { const p = UI.pinyinNode(s.raw, pyOpts()); return p; })() : null,
          h("span", { class: "gl" }, shortGloss(c))));
      });
      frag.appendChild(row);
    }

    const hint = chars.length > 1
      ? [h("span", { class: "kbd" }, "←"), h("span", { class: "kbd" }, "→"), " words  ", h("span", { class: "kbd" }, "↓"), " characters"]
      : S.stack.length ? [h("span", { class: "kbd" }, "↑"), " back  ", h("span", { class: "kbd" }, "←"), h("span", { class: "kbd" }, "→"), " words"]
        : [h("span", { class: "kbd" }, "←"), h("span", { class: "kbd" }, "→"), " words  ", h("span", { class: "kbd" }, "esc"), " close"];
    frag.appendChild(h("div", { class: "ft" },
      h("span", { class: "hint" }, ...hint),
      h("button", { class: "btn", title: "Open full entry in the sidebar (⌥⌘D or Return)", onclick: (e) => { e.stopPropagation(); openSidebar(); } },
        h("span", { html: ICONS.sidebar }), "Details")));
    return frag;
  }

  function defsBlock(entry, max, isTrad) {
    const { defs, classifiers } = UI.splitDefs(entry.defs);
    const shown = defs.slice(0, max);
    const wrap = document.createDocumentFragment();
    const ul = h("ol", { class: "defs" + (shown.length === 1 ? " single" : "") });
    shown.forEach((d) => ul.appendChild(h("li", null, UI.defNode(d, drill, { trad: isTrad, colors: S.settings.toneColors === true }))));
    wrap.appendChild(ul);
    if (defs.length > max) wrap.appendChild(h("div", { class: "more-defs" }, `${defs.length - max} more in Details`));
    if (classifiers.length && max > 2) {
      const cl = h("div", { class: "cls" }, h("b", null, "Measure word"));
      classifiers.slice(0, 3).forEach((c, i) => {
        if (i) cl.appendChild(h("span", { class: "sep" }, "·"));
        const w = isTrad ? c.trad : c.simp;
        cl.appendChild(h("span", { class: "c", onclick: (e) => { e.stopPropagation(); drill(w); } }, w));
        const p = UI.pinyinNode(c.pinyin, { colors: S.settings.toneColors === true });
        cl.appendChild(p);
      });
      wrap.appendChild(cl);
    }
    return wrap;
  }

  function speakWord(word, btn) {
    const isTrad = HL.scriptOf(word) === "zh-Hant";
    if (UI.speak(word, isTrad ? "zh-TW" : "zh-CN") && btn) {
      btn.classList.add("speaking");
      setTimeout(() => btn.classList.remove("speaking"), 900);
    }
  }

  function starWord(entry, btn) {
    const key = entry.simp + "|" + entry.pinyin;
    const on = !S.starred.has(key);
    if (on) S.starred.add(key); else S.starred.delete(key);
    if (btn) {
      btn.classList.toggle("on", on);
      btn.innerHTML = on ? ICONS.starFill : ICONS.star;
      UI.clickable(btn);
      // A small, AppKit-like confirmation bounce.
      btn.firstChild.animate([{ transform: "scale(1)" }, { transform: "scale(1.28)" }, { transform: "scale(1)" }],
        { duration: T(260), easing: EASE.out });
    }
    UI.post("star", { simp: entry.simp, trad: entry.trad, pinyin: entry.pinyin, def: UI.splitDefs(entry.defs).defs.slice(0, 3).join("; "), context: S.line ? S.line.text : "" });
  }

  function openSidebar() {
    const tok = S.tokens[S.sel];
    UI.post("openSidebar", { word: S.word, context: tok ? tok.lineText : "" });
    // The sidebar takes over; keep playback paused while the full entry is read.
    S.keepPaused = true;
    closeCard();
  }

  function drill(word) {
    if (!word || word === S.word) return;
    S.stack.push({ word: S.word });
    showWord(word, {});
  }
  function goBack() {
    const prev = S.stack.pop();
    if (prev) showWord(prev.word, {});
  }

  // ------------------------------------------------------------------ card placement & animation
  const GAP = 3;     // between anchor and arrow tip
  const ARROW = 9;
  const EDGE = 10;

  /** Word box including its ruby annotations (WebKit lays <rt> outside the inline-block's box). */
  function wordRect(el) {
    const r = el.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    el.querySelectorAll("rt").forEach((rt) => {
      const q = rt.getBoundingClientRect();
      if (!q.width) return;
      top = Math.min(top, q.top); bottom = Math.max(bottom, q.bottom);
      left = Math.min(left, q.left); right = Math.max(right, q.right);
    });
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  function anchorRect() {
    const tok = S.tokens[S.sel];
    if (tok && tok.el.isConnected) return wordRect(tok.el);
    return null;
  }
  /** Size the hover/selection plate so it also covers the word's pinyin. */
  function fitPlates() {
    if (!S.settings.pinyin) return;
    for (const t of S.tokens) {
      if (!t.han) continue;
      const r = t.el.getBoundingClientRect();
      const w = wordRect(t.el);
      t.el.style.setProperty("--plate-top", (w.top - r.top).toFixed(2) + "px");
      t.el.style.setProperty("--plate-x", Math.max(0, (r.left - w.left)).toFixed(2) + "px");
    }
  }

  const TOP_INSET = 34; // keep clear of the window's title bar / traffic lights

  /** Fit the card into the space beside the word: compact layout first, then a scrolling cap. */
  function fitCard(r) {
    const H = window.innerHeight;
    const above = r.top - GAP - ARROW - TOP_INSET;
    const below = H - r.bottom - GAP - ARROW - EDGE;
    const room = Math.max(above, below);
    $card.classList.remove("compact", "tiny");
    $clip.style.maxHeight = "";
    if ($card.offsetHeight > room) $card.classList.add("compact");
    // Still too tall: keep the headword, reading, first definition and the Details button.
    if ($card.offsetHeight > room) $card.classList.add("tiny");
    if ($card.offsetHeight > room) $clip.style.maxHeight = Math.max(120, room) + "px";
  }

  function computePlacement() {
    const r = anchorRect() || (S.lastPlacement && S.lastPlacement.rect);
    if (!r) return null;
    const W = window.innerWidth, H = window.innerHeight;
    fitCard(r);
    const cw = $card.offsetWidth, chh = $card.offsetHeight;
    const cx = r.left + r.width / 2;
    let mode = "above";
    if (r.top - GAP - ARROW - chh < TOP_INSET && H - r.bottom > r.top) mode = "below";
    const x = Math.round(Math.min(Math.max(cx - cw / 2, EDGE), W - cw - EDGE));
    const ax = Math.round(Math.min(Math.max(cx - x - ARROW, 12), cw - 2 * ARROW - 12));
    // "above": anchored by its bottom edge so height changes grow upward without moving the arrow.
    const y = mode === "above" ? Math.round(H - (r.top - GAP - ARROW)) : Math.round(r.bottom + GAP + ARROW);
    return { mode, x, y, ax, rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom } };
  }

  function transformFor(p) {
    return p.mode === "above" ? `translate(${p.x}px, ${-p.y}px)` : `translate(${p.x}px, ${p.y}px)`;
  }

  function setPlacement(p) {
    $card.classList.toggle("above", p.mode === "above");
    $card.classList.toggle("below", p.mode === "below");
    $card.style.top = p.mode === "above" ? "auto" : "0px";
    $card.style.bottom = p.mode === "above" ? "0px" : "auto";
    $card.style.transform = transformFor(p);
    $arrow.style.left = p.ax + "px";
    const ox = p.ax + ARROW;
    $card.style.transformOrigin = p.mode === "above" ? `${ox}px calc(100% + ${ARROW}px)` : `${ox}px ${-ARROW}px`;
    S.lastPlacement = p;
  }

  function placeCard(animate) {
    const p = computePlacement();
    if (!p) return;
    publishHitmapAfterMotion();
    const prev = S.lastPlacement;
    setPlacement(p);
    if (animate && prev && prev.mode === p.mode && (prev.x !== p.x || prev.y !== p.y || prev.ax !== p.ax)) {
      $card.animate([{ transform: transformFor(prev) }, { transform: transformFor(p) }],
        { duration: T(300), easing: EASE.out });
      $arrow.animate([{ left: prev.ax + "px" }, { left: p.ax + "px" }], { duration: T(300), easing: EASE.out });
    }
  }

  let openAnims = [];
  function cancelAnims() { openAnims.forEach((a) => a.cancel()); openAnims = []; }

  function showWord(word, opts) {
    const wasOpen = S.open && !S.closing;
    S.word = word;
    if (S.closing) { S.closing.cancel(); S.closing = null; }

    if (!wasOpen) {
      cancelAnims();
      $body.textContent = "";
      $body.appendChild(buildCard(word));
      UI.clickable($card);
      $card.hidden = false;
      $card.style.visibility = "hidden";
      S.lastPlacement = null;
      placeCard(false);
      $card.style.visibility = "";
      S.open = true;
      UI.post("card", { open: true });
      publishHitmapAfterMotion();
      // Popover appearance: quick fade, spring-settled scale from the arrow tip.
      const tf = $card.style.transform;
      openAnims.push($card.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: T(150), easing: EASE.std }));
      openAnims.push($card.animate(
        [{ transform: tf + " scale(0.92)" }, { transform: tf + " scale(1)" }],
        { duration: T(320), easing: EASE.out }));
      return;
    }

    // Already open: crossfade content, animate height, glide to the new anchor.
    const oldH = $clip.offsetHeight;
    const ghost = $body.cloneNode(true);
    ghost.classList.add("ghost");
    Object.assign(ghost.style, { position: "absolute", left: "0", top: "0", right: "0", pointerEvents: "none" });
    $body.textContent = "";
    $body.appendChild(buildCard(word));
    UI.clickable($card);
    $clip.appendChild(ghost);
    const newH = $clip.offsetHeight;
    placeCard(true);
    const ease = EASE.out;
    if (Math.abs(newH - oldH) > 0.5) {
      $clip.animate([{ height: oldH + "px" }, { height: newH + "px" }], { duration: T(300), easing: ease });
    }
    // Sequential-ish crossfade: the old content is nearly gone before the new one rises,
    // so text never double-exposes at mid opacity.
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T(80), easing: "cubic-bezier(0.2, 0, 0.4, 1)", fill: "forwards" })
      .finished.then(() => ghost.remove(), () => ghost.remove());
    setTimeout(() => ghost.remove(), T(80) + 60);
    $body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T(170), delay: T(40), easing: EASE.std, fill: "backwards" });
  }

  function closeCard() {
    if (!S.open || S.closing) return;
    cancelAnims();
    const tf = $card.style.transform;
    // Fade starts immediately (like NSPopover's transient close); the slight shrink accelerates out.
    const fade = $card.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: T(150), easing: "cubic-bezier(0.2, 0, 0.6, 1)", fill: "forwards" });
    openAnims.push($card.animate([{ transform: tf + " scale(1)" }, { transform: tf + " scale(0.96)" }],
      { duration: T(150), easing: EASE.in, fill: "forwards" }));
    S.closing = fade;
    S.tokens.forEach((t) => t.el.classList.remove("sel"));
    // Finish on the animation *or* a timer: WebKit freezes animations while the window is occluded.
    const finish = () => {
      if (S.closing !== fade) return;
      fade.cancel();
      cancelAnims();
      S.closing = null;
      $card.hidden = true;
      S.open = false;
      S.sel = -1;
      S.stack = [];
      UI.post("card", { open: false, keepPaused: !!S.keepPaused });
      S.keepPaused = false;
      publishHitmap();
    };
    fade.finished.then(finish, () => {});
    setTimeout(finish, T(150) + 60);
  }

  // ------------------------------------------------------------------ keys (forwarded by main.js)
  function onKey(k) {
    if (!S.open) return;
    switch (k) {
      case "left": step(-1); break;
      case "right": step(1); break;
      case "down": {
        const chars = Array.from(S.word || "");
        if (chars.length > 1) drill(chars[0]);
        else if (S.stack.length) {
          // walk to the next character of the parent word
          const parent = Array.from(S.stack[S.stack.length - 1].word);
          const i = parent.indexOf(S.word);
          if (i >= 0 && i < parent.length - 1) { S.word = parent[i + 1]; showWord(parent[i + 1], {}); }
        }
        break;
      }
      case "up": goBack(); break;
      case "escape": case "dismiss":
        if (k === "escape" && S.stack.length) goBack(); else closeCard();
        break;
      case "enter": openSidebar(); break;
      case "star": {
        const e = HL.lookup(S.word)[0];
        if (e) starWord(e, $card.querySelector(".tools .ib:nth-child(2)"));
        break;
      }
      case "speak": speakWord(S.word, $card.querySelector(".tools .ib:first-child")); break;
    }
  }

  // ------------------------------------------------------------------ hit map + taps
  // IINA never routes pointer events here (the overlay isn't clickable — see main.js). We publish the
  // rectangles that should take clicks; main.js hit-tests mouse events and sends taps back.
  let hitmapTimer = 0;
  function publishHitmap() {
    clearTimeout(hitmapTimer);
    hitmapTimer = setTimeout(() => {
      const rects = [];
      const shown = !$sub.hidden && S.visible && S.settings.enabled !== false;
      if (shown) {
        for (const t of S.tokens) {
          if (!t.han || t.el.classList.contains("plain")) continue;
          const r = wordRect(t.el);
          rects.push([r.left, r.top, r.right, r.bottom]);
        }
        if (S.settings.blurTranslation && $tr.classList.contains("shown") && !document.body.classList.contains("no-tr")) {
          const r = $tr.getBoundingClientRect();
          if (r.width) rects.push([r.left, r.top, r.right, r.bottom]);
        }
      }
      if (S.open && !S.closing) {
        const r = $card.getBoundingClientRect();
        const a = $arrow.getBoundingClientRect();
        rects.push([Math.min(r.left, a.left), Math.min(r.top, a.top), Math.max(r.right, a.right), Math.max(r.bottom, a.bottom)]);
      }
      UI.post("hitmap", { h: window.innerHeight, rects: rects.map((q) => q.map((n) => Math.round(n * 10) / 10)) });
    }, 0);
  }
  // Card geometry settles after its open/glide animations; publish again once they've finished.
  function publishHitmapAfterMotion() { publishHitmap(); setTimeout(publishHitmap, T(340)); }

  UI.onMessage("tap", (d) => {
    const el = document.elementFromPoint(d.x, d.y);
    if (!el || !(el.closest("#card") || el.closest(".w") || el.closest("#tr"))) { closeCard(); return; }
    el.click();
  });

  // ------------------------------------------------------------------ messages
  UI.onMessage("settings", (s) => {
    const rerender = S.line && (s.pinyin !== S.settings.pinyin || s.zhuyin !== S.settings.zhuyin);
    S.settings = Object.assign(S.settings, s);
    applySettings();
    if (rerender) {
      const tr = $tr.textContent;
      const selWord = S.open ? S.sel : -1;
      renderLine(S.line);
      if (tr) { $tr.textContent = tr; $tr.classList.add("shown"); UI.clickable($tr); }
      if (selWord >= 0 && S.tokens[selWord]) { S.tokens[selWord].el.classList.add("sel"); placeCard(true); }
    }
    if (S.open) {
      // refresh card content (e.g. tone colors / zhuyin)
      $body.textContent = ""; $body.appendChild(buildCard(S.word)); UI.clickable($card);
      placeCard(false);
    }
    publishHitmap();
  });
  UI.onMessage("inset", (d) => {
    S.inset = d;
    $sub.classList.add("shifting");
    applyStyle(); fitPlates(); if (S.open) placeCard(false);
    setTimeout(() => { $sub.classList.remove("shifting"); publishHitmap(); }, 300);
  });
  UI.onMessage("osc", (o) => { S.osc = o; applyStyle(); fitPlates(); if (S.open) placeCard(false); publishHitmap(); });
  UI.onMessage("style", (st) => { S.style = st; applyStyle(); fitPlates(); if (S.open) placeCard(false); publishHitmap(); });
  UI.onMessage("visible", (d) => { S.visible = !!d.visible; applySettings(); if (!S.visible) closeCard(); publishHitmap(); });
  UI.onMessage("sub", (line) => {
    if (S.line && line.text === S.line.text && line.text) return;
    if (S.open) closeCard();
    renderLine(line);
  });
  UI.onMessage("translation", (d) => {
    if (S.line && d.text === S.line.text) showTranslation(d.translation);
  });
  UI.onMessage("starred", (d) => { S.starred = new Set(d.keys || []); });
  UI.onMessage("key", (d) => onKey(d.key));
  UI.onMessage("ping", () => UI.post("ready", { href: location.href, again: true }));

  // ------------------------------------------------------------------ boot
  HL.load();
  applySettings();
  applyStyle();
  UI.post("ready", { href: location.href });

  // Expose for debugging and for the preview harness.
  window.HLOverlay = { S, select, closeCard, onKey, renderLine, showTranslation, publishHitmap };
})();
