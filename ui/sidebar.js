/* Hanzi Lens — sidebar: full dictionary entries, search, transcript, starred words. */
(function () {
  "use strict";
  const { h, T, EASE, ICONS } = UI;

  const $ = (id) => document.getElementById(id);
  const panes = { dict: $("pane-dict"), lines: $("pane-lines"), starred: $("pane-starred"), settings: $("pane-settings") };
  const $q = $("q");
  const $searchWrap = $("search-wrap");

  $("search-icon").innerHTML = ICONS.search;
  $("q-clear").innerHTML = ICONS.clear;
  $("nav-back").innerHTML = ICONS.chevronLeft;
  $("nav-fwd").innerHTML = ICONS.chevronRight;
  $("open-settings").innerHTML = ICONS.gear;

  const S = {
    settings: { toneColors: false, zhuyin: false },
    tab: "dict",
    lastTab: "dict",
    hist: [],
    hpos: -1,
    lines: [],
    fromFile: false,
    tr: new Map(),
    current: null,
    starred: [],
    trStatus: null,
    userScrolledAt: 0,
    kb: -1,
  };

  const pyOpts = () => ({ colors: S.settings.toneColors === true });
  const langOf = (t) => HL.scriptOf(t);

  // ------------------------------------------------------------------ tabs (segmented control)
  const $seg = $("seg");
  const $thumb = $("seg-thumb");
  const tabs = Array.from($seg.querySelectorAll("button"));
  function thumbX(tab) {
    const i = Math.max(0, tabs.findIndex((b) => b.dataset.tab === tab));
    return i * ($thumb.offsetWidth);
  }
  function setTab(tab, animate) {
    const wasSettings = S.tab === "settings";
    const from = thumbX(wasSettings ? S.lastTab : S.tab);
    if (tab !== "settings") S.lastTab = tab;
    S.tab = tab;
    const isSettings = tab === "settings";
    tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    for (const k in panes) panes[k].hidden = k !== tab;
    $("open-settings").setAttribute("aria-pressed", String(isSettings));
    $seg.classList.toggle("none", isSettings);
    if (isSettings) { renderSettings(); panes.settings.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T(160), easing: EASE.std }); return; }
    const to = thumbX(tab);
    $thumb.style.transform = `translateX(${to}px)`;
    if (animate && from !== to && !wasSettings) {
      $thumb.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
        { duration: T(260), easing: EASE.out });
    }
    if (tab === "lines") scrollToCurrent(false);
  }
  tabs.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab, true)));
  $("open-settings").addEventListener("click", () => setTab(S.tab === "settings" ? S.lastTab : "settings", true));
  window.addEventListener("resize", () => { $thumb.style.transform = `translateX(${thumbX(S.tab)}px)`; });

  // ------------------------------------------------------------------ navigation history
  function navigate(view, opts) {
    opts = opts || {};
    if (!opts.replace) {
      S.hist = S.hist.slice(0, S.hpos + 1);
      const cur = S.hist[S.hpos];
      if (!cur || JSON.stringify(cur) !== JSON.stringify(view)) { S.hist.push(view); S.hpos = S.hist.length - 1; }
    } else if (S.hpos >= 0) S.hist[S.hpos] = view;
    else { S.hist.push(view); S.hpos = 0; }
    render(view);
    if (S.tab !== "dict") setTab("dict", true);
  }
  function go(delta) {
    const n = S.hpos + delta;
    if (n < 0 || n >= S.hist.length) return;
    S.hpos = n;
    const v = S.hist[n];
    if (v.type === "search") { $q.value = v.q; syncSearchUI(); } else if ($q.value) { $q.value = ""; syncSearchUI(); }
    render(v);
    if (S.tab !== "dict") setTab("dict", true);
  }
  function updateNav() {
    $("nav-back").disabled = S.hpos <= 0;
    $("nav-fwd").disabled = S.hpos >= S.hist.length - 1;
  }
  $("nav-back").addEventListener("click", () => go(-1));
  $("nav-fwd").addEventListener("click", () => go(1));

  function render(view) {
    const p = panes.dict;
    p.textContent = "";
    S.kb = -1;
    if (view.type === "word") p.appendChild(entryView(view.word, view.context));
    else if (view.type === "search") p.appendChild(searchView(view.q));
    else if (view.type === "line") p.appendChild(lineView(view.text));
    else p.appendChild(emptyView());
    p.scrollTop = 0;
    p.firstChild && p.firstChild.animate && p.firstChild.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T(160), easing: EASE.std });
    updateNav();
  }

  // ------------------------------------------------------------------ shared bits
  /** Chinese text as clickable segmented words; optionally highlight a word. */
  function zhText(text, highlight, cls) {
    const wrap = h("span", { class: (cls || "") + " zh", lang: langOf(text) });
    for (const t of HL.segment(text)) {
      if (t.han && (t.known || HL.charInfo(t.text).ud)) {
        const s = h("span", { class: "wl", dataset: { w: t.text, ctx: text } }, t.text);
        if (highlight && t.text === highlight) wrap.appendChild(h("mark", null, s));
        else wrap.appendChild(s);
      } else if (highlight && t.text.includes(highlight)) {
        // highlight even inside an unsegmented run
        const i = t.text.indexOf(highlight);
        wrap.appendChild(document.createTextNode(t.text.slice(0, i)));
        wrap.appendChild(h("mark", null, highlight));
        wrap.appendChild(document.createTextNode(t.text.slice(i + highlight.length)));
      } else wrap.appendChild(document.createTextNode(t.text));
    }
    // Words that segmentation merged into larger tokens still get highlighted.
    if (highlight && !wrap.querySelector("mark")) {
      wrap.querySelectorAll(".wl").forEach((s) => {
        const i = s.textContent.indexOf(highlight);
        if (i >= 0 && !wrap.querySelector("mark")) {
          const txt = s.textContent;
          s.textContent = "";
          s.append(txt.slice(0, i), h("mark", null, highlight), txt.slice(i + highlight.length));
        }
      });
    }
    return wrap;
  }

  document.addEventListener("click", (e) => {
    const w = e.target.closest(".wl");
    if (w) { e.stopPropagation(); navigate({ type: "word", word: w.dataset.w, context: w.dataset.ctx || "" }); }
  });

  function speakBtn(text) {
    const b = h("button", { class: "ib", title: "Speak", "aria-label": "Speak", html: ICONS.speaker });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (UI.speak(text, langOf(text) === "zh-Hant" ? "zh-TW" : "zh-CN")) {
        b.classList.add("speaking");
        setTimeout(() => b.classList.remove("speaking"), 1000);
      }
    });
    return b;
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
    } catch (e) { /* fall through */ }
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } }, text);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  function groupEntries(entries) {
    const groups = [];
    for (const e of entries) {
      const g = groups.find((x) => x.pinyin.toLowerCase() === e.pinyin.toLowerCase());
      if (g) { g.defs = g.defs.concat(e.defs); g.hsk = g.hsk || e.hsk; g.hskOld = g.hskOld || e.hskOld; g.jyutping = g.jyutping || e.jyutping; g.freq = Math.max(g.freq, e.freq); }
      else groups.push(Object.assign({}, e, { defs: e.defs.slice() }));
    }
    return groups;
  }

  function section(title, count, ...kids) {
    return h("div", { class: "section" }, h("h4", null, title, count ? h("span", { class: "count" }, String(count)) : null), ...kids);
  }

  function shortGloss(e) {
    const d = UI.splitDefs(e.defs).defs;
    return d.slice(0, 3).join("; ");
  }

  function isStarred(e) { return S.starred.some((x) => x.simp === e.simp && x.pinyin === e.pinyin); }

  // ------------------------------------------------------------------ empty state
  function emptyView() {
    return h("div", { class: "empty" },
      h("div", { class: "glyph" }, "字"),
      h("h3", null, "Click any word in the subtitles"),
      h("p", null, "Its full entry appears here: readings, definitions, stroke order, related words and example sentences. You can also search by hanzi, pinyin or English."));
  }

  // ------------------------------------------------------------------ entry view
  function entryView(word, context) {
    const raw = HL.lookup(word);
    const groups = groupEntries(raw);
    const isTrad = langOf(word) === "zh-Hant";
    const root = h("div", { class: "entry" });

    if (!groups.length) {
      const info = HL.charInfo(word);
      root.appendChild(h("div", { class: "e-head" }, h("div", { class: "e-head-main" },
        h("div", { class: "e-hw", lang: isTrad ? "zh-Hant" : "zh-Hans" }, word),
        info.um ? h("div", { class: "e-py" }, info.um) : null)));
      root.appendChild(section("Meaning", 0, h("ol", { class: "defs single" }, h("li", null, info.md || info.ud || "No dictionary entry."))));
      if (Array.from(word).length === 1) root.appendChild(charsSection(word));
      return root;
    }

    const first = groups[0];
    const alt = isTrad ? first.simp : first.trad;
    const star = h("button", { class: "ib" + (isStarred(first) ? " on" : ""), title: "Star", "aria-label": "Star", html: isStarred(first) ? ICONS.starFill : ICONS.star });
    star.addEventListener("click", () => {
      UI.post("star", { simp: first.simp, trad: first.trad, pinyin: first.pinyin, def: shortGloss(first), context: context || "" });
      const on = !star.classList.contains("on");
      star.classList.toggle("on", on);
      star.innerHTML = on ? ICONS.starFill : ICONS.star;
      star.firstChild.animate([{ transform: "scale(1)" }, { transform: "scale(1.28)" }, { transform: "scale(1)" }], { duration: T(260), easing: EASE.out });
    });
    const copy = h("button", { class: "ib", title: "Copy", "aria-label": "Copy", html: ICONS.copy });
    copy.addEventListener("click", () => {
      copyText(word + "\t" + HL.marked(first.pinyin) + "\t" + shortGloss(first));
      copy.animate([{ transform: "scale(1)" }, { transform: "scale(0.86)" }, { transform: "scale(1)" }], { duration: T(220), easing: EASE.out });
    });

    const sub = h("div", { class: "e-sub" });
    {
      sub.appendChild(h("span", null, h("span", { class: "k" }, "Zhuyin"), h("span", { class: "zy" }, HL.syllables(first.pinyin).map((s) => HL.syllableToZhuyin(s.raw)).join(" "))));
    }
    if (first.jyutping) sub.appendChild(h("span", null, h("span", { class: "k" }, "Cantonese"), first.jyutping));

    const badges = h("div", { class: "badges" });
    if (first.hsk) badges.appendChild(h("span", { class: "badge strong", title: "HSK 3.0 (2021) level" }, "HSK 3.0 · " + (first.hsk >= 7 ? "7–9" : first.hsk)));
    if (first.hskOld) badges.appendChild(h("span", { class: "badge", title: "HSK 2.0 level" }, "HSK 2.0 · " + first.hskOld));
    const fr = freqLabel(first.freq);
    if (fr) badges.appendChild(h("span", { class: "badge", title: "Corpus frequency (jieba)" }, fr));

    root.appendChild(h("div", { class: "e-head" },
      h("div", { class: "e-head-main" },
        h("div", null,
          h("span", { class: "e-hw", lang: isTrad ? "zh-Hant" : "zh-Hans" }, word),
          alt && alt !== word ? h("span", { class: "e-alt", lang: isTrad ? "zh-Hans" : "zh-Hant" }, alt) : null),
        h("div", { class: "e-py" }, UI.pinyinNode(first.pinyin, Object.assign(pyOpts(), { shapes: S.settings.toneShapes !== false }))),
        sub,
        badges.childNodes.length ? badges : null),
      h("div", { class: "e-actions" }, speakBtn(word), star, copy)));

    // Definitions, grouped by reading
    const defsWrap = h("div", null);
    groups.forEach((g, gi) => {
      const box = h("div", { class: "group" });
      if (groups.length > 1) {
        box.appendChild(h("div", { class: "group-py" }, UI.pinyinNode(g.pinyin, pyOpts()), g.jyutping && gi > 0 ? h("span", { class: "jy" }, g.jyutping) : null));
      }
      const { defs, classifiers } = UI.splitDefs(g.defs);
      const ol = h("ol", { class: "defs" + (defs.length === 1 ? " single" : "") });
      defs.forEach((d) => ol.appendChild(h("li", null, UI.defNode(d, (w) => navigate({ type: "word", word: w }), { trad: isTrad, colors: S.settings.toneColors === true }))));
      box.appendChild(ol);
      if (classifiers.length) {
        const cl = h("div", { class: "cls" }, h("b", null, "Measure word"));
        classifiers.forEach((c, i) => {
          if (i) cl.appendChild(h("span", { class: "sep" }, "·"));
          const w = isTrad ? c.trad : c.simp;
          cl.appendChild(h("span", { class: "c", onclick: () => navigate({ type: "word", word: w }) }, w));
          cl.appendChild(UI.pinyinNode(c.pinyin, pyOpts()));
        });
        box.appendChild(cl);
      }
      defsWrap.appendChild(box);
    });
    root.appendChild(section("Definitions", 0, defsWrap));

    // Context: the subtitle line it came from
    if (context && context.includes(word)) {
      const tr = S.tr.get(context);
      root.appendChild(section("In this line", 0, h("div", { class: "ctx" },
        h("div", { class: "zhl" }, zhText(context, word)),
        tr ? h("div", { class: "enl" }, tr) : null)));
    }

    root.appendChild(charsSection(word));

    // Related words
    const comp = HL.compounds(word, 18);
    if (comp.length) {
      const box = h("div", { class: "compounds" });
      comp.forEach((e) => {
        const w = isTrad ? e.trad : e.simp;
        box.appendChild(h("div", { class: "cw", onclick: () => navigate({ type: "word", word: w }) },
          h("span", { class: "zh", lang: isTrad ? "zh-Hant" : "zh-Hans" }, w),
          UI.pinyinNode(e.pinyin, pyOpts()),
          h("span", { class: "g" }, UI.splitDefs(e.defs).defs[0] || "")));
      });
      root.appendChild(section("Words with " + word, comp.length, box));
    }

    // Examples
    const exBox = h("div", null);
    root.appendChild(section("Examples", 0, exBox));
    fillExamples(exBox, word, alt);

    root.appendChild(h("div", { class: "credits" },
      "CC-CEDICT · Unihan · Make Me a Hanzi · HSK lists (complete-hsk-vocabulary) · jieba frequencies · CC-Canto · Tatoeba (CC BY 2.0 FR)"));
    return root;
  }

  function freqLabel(f) {
    if (!f) return "";
    if (f >= 20000) return "Very common";
    if (f >= 3000) return "Common";
    if (f >= 300) return "Less common";
    return "Rare";
  }

  function fillExamples(box, word, alt) {
    const doFill = () => {
      const ex = HL.examplesFor(word, alt, 6);
      if (ex === null) { setTimeout(doFill, 200); return; }
      box.textContent = "";
      if (!ex.length) {
        box.closest(".section").remove();
        return;
      }
      ex.forEach((x) => {
        const FW = { "，": ",", "。": ".", "！": "!", "？": "?", "、": ",", "；": ";", "：": ":", "“": "\u201c", "”": "\u201d", "（": "(", "）": ")" };
        const pinyin = HL.segment(x.zh)
          .map((t) => (t.han ? HL.marked(HL.bestReading(t.text).toLowerCase()) : (FW[t.text] || t.text)))
          .join(" ").replace(/\s+([,.!?;:)\u201d])/g, "$1").replace(/([(\u201c])\s+/g, "$1").replace(/\s+/g, " ").trim();
        box.appendChild(h("div", { class: "ex" },
          h("div", { class: "zhl" }, zhText(x.zh, word, "txt"), speakBtn(x.zh)),
          h("div", { class: "pyl" }, pinyin),
          h("div", { class: "enl" }, x.en)));
      });
    };
    doFill();
  }

  // ------------------------------------------------------------------ characters
  function charsSection(word) {
    const chars = Array.from(new Set(Array.from(word).filter((c) => HL.isHan(c))));
    const box = h("div", { class: "chars" });
    const widgets = [];
    chars.forEach((c) => {
      const info = HL.charInfo(c);
      const e = HL.lookup(c)[0];
      const w = HLStrokes.widget(c, { T, radical: true });
      widgets.push(w);
      const replay = h("span", { class: "so-replay", html: ICONS.play });
      const soBox = h("div", { class: "so-box", title: "Replay stroke order" }, w.el, h("div", { class: "so-fallback" }, c), replay);
      soBox.addEventListener("click", () => w.play());

      const meta = h("div", { class: "char-meta" });
      if (info.n) meta.appendChild(h("span", null, h("span", { class: "k" }, "Strokes"), String(info.n)));
      if (info.r) meta.appendChild(h("span", null, h("span", { class: "k" }, "Radical"), h("span", { class: "zh comp", onclick: () => navigate({ type: "word", word: info.r }) }, info.r)));
      if (info.dc && /[⿰-⿻]/.test(info.dc)) {
        const comps = h("span", { class: "zh" });
        for (const p of Array.from(info.dc)) {
          if (/[⿰-⿻？]/.test(p)) continue;
          comps.appendChild(h("span", { class: "comp", onclick: () => navigate({ type: "word", word: p }) }, p));
        }
        if (comps.childNodes.length) meta.appendChild(h("span", null, h("span", { class: "k" }, "Parts"), comps));
      }
      if (info.tv && !word.includes(info.tv)) meta.appendChild(h("span", null, h("span", { class: "k" }, "Trad."), h("span", { class: "zh comp", lang: "zh-Hant", onclick: () => navigate({ type: "word", word: info.tv[0] }) }, info.tv)));
      if (info.sv && !word.includes(info.sv)) meta.appendChild(h("span", null, h("span", { class: "k" }, "Simp."), h("span", { class: "zh comp", onclick: () => navigate({ type: "word", word: info.sv[0] }) }, info.sv)));

      const ety = info.e && (info.e.hint || info.e.type)
        ? h("div", { class: "char-ety" }, h("span", { class: "k" }, info.e.type || "Origin"), etyText(info.e))
        : null;

      const defText = e ? shortGloss(e) : (info.md || info.ud || "");
      box.appendChild(h("div", { class: "char" },
        soBox,
        h("div", { class: "char-info" },
          h("div", { class: "char-top" },
            h("span", { class: "c", lang: langOf(c), onclick: () => { if (c !== word) navigate({ type: "word", word: c }); } }, c),
            e ? UI.pinyinNode(e.pinyin, pyOpts()) : (info.um ? h("span", { class: "py" }, info.um) : null)),
          defText ? h("div", { class: "char-def" }, defText) : null,
          meta,
          ety)));
    });
    // Play each character's animation once it scrolls into view.
    const io = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        const w = widgets.find((x) => x.el === en.target);
        if (w) w.ready.then((ok) => { if (ok) setTimeout(() => w.play(), T(120)); });
      });
    }, { threshold: 0.6 });
    requestAnimationFrame(() => widgets.forEach((w) => io.observe(w.el)));
    return section(chars.length > 1 ? "Characters" : "Character", 0, box);
  }

  function etyText(e) {
    const s = h("span", null);
    let txt = e.hint || "";
    if (e.type === "pictophonetic" && (e.semantic || e.phonetic)) {
      txt = [e.semantic ? e.semantic + " meaning" : "", e.phonetic ? e.phonetic + " sound" : ""].filter(Boolean).join(" + ") + (e.hint ? ". " + e.hint : "");
    }
    // Make embedded characters clickable
    for (const ch of Array.from(txt)) {
      if (HL.isHan(ch)) s.appendChild(h("span", { class: "wl zh" , dataset: { w: ch } }, ch));
      else s.appendChild(document.createTextNode(ch));
    }
    return s;
  }

  // ------------------------------------------------------------------ search
  function searchView(q) {
    const results = HL.search(q, 80);
    const root = h("div", null);
    if (!results.length) {
      root.appendChild(h("div", { class: "empty" }, h("h3", null, "No results"), h("p", null, "Try hanzi, pinyin with or without tones (ni3hao3, nihao), or an English word.")));
      return root;
    }
    const rows = h("div", { class: "rows", id: "results" });
    results.forEach((e, i) => {
      const isT = langOf(q) === "zh-Hant";
      const hw = isT ? e.trad : e.simp;
      const alt = isT ? e.simp : e.trad;
      const row = h("div", { class: "row", dataset: { i: i } },
        h("div", null, h("span", { class: "r-hw", lang: isT ? "zh-Hant" : "zh-Hans" }, hw), alt !== hw ? h("span", { class: "r-alt" }, alt) : null),
        h("div", { class: "r-body" },
          h("div", { class: "r-py" }, UI.pinyinNode(e.pinyin, pyOpts())),
          h("div", { class: "r-def" }, shortGloss(e))));
      row.addEventListener("click", () => navigate({ type: "word", word: hw }));
      rows.appendChild(row);
    });
    root.appendChild(rows);
    return root;
  }

  function syncSearchUI() { $searchWrap.classList.toggle("has-text", !!$q.value); }
  let searchTimer = 0;
  $q.addEventListener("input", () => {
    syncSearchUI();
    clearTimeout(searchTimer);
    const q = $q.value.trim();
    searchTimer = setTimeout(() => {
      if (!q) {
        const cur = S.hist[S.hpos];
        if (cur && cur.type === "search") {
          S.hist.splice(S.hpos, 1);
          S.hpos = Math.min(S.hpos, S.hist.length) - 1;
          render(S.hist[S.hpos] || { type: "empty" });
        }
        return;
      }
      const cur = S.hist[S.hpos];
      navigate({ type: "search", q }, { replace: cur && cur.type === "search" });
    }, 140);
  });
  $q.addEventListener("keydown", (e) => {
    const rows = Array.from(document.querySelectorAll("#results .row"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      S.kb = Math.max(0, Math.min(rows.length - 1, S.kb + (e.key === "ArrowDown" ? 1 : -1)));
      rows.forEach((r, i) => r.classList.toggle("kb", i === S.kb));
      rows[S.kb].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const r = rows[S.kb >= 0 ? S.kb : 0];
      if (r) r.click();
    } else if (e.key === "Escape") {
      $q.value = ""; syncSearchUI(); $q.blur();
      $q.dispatchEvent(new Event("input"));
    }
  });
  $("q-clear").addEventListener("click", (e) => { e.preventDefault(); $q.value = ""; syncSearchUI(); $q.dispatchEvent(new Event("input")); $q.focus(); });

  // ------------------------------------------------------------------ line breakdown
  function lineView(text) {
    const root = h("div", { class: "entry" });
    const tr = S.tr.get(text);
    root.appendChild(h("div", { class: "lb-line" }, zhText(text)));
    if (tr) root.appendChild(h("div", { class: "lb-tr" }, tr));
    const rows = h("div", { class: "rows lb-rows" });
    const seen = new Set();
    for (const t of HL.segment(text)) {
      if (!t.han || seen.has(t.text)) continue;
      seen.add(t.text);
      const e = HL.lookup(t.text)[0];
      const row = h("div", { class: "row" },
        h("div", null, h("span", { class: "r-hw", lang: langOf(text) }, t.text)),
        h("div", { class: "r-body" },
          e ? h("div", { class: "r-py" }, UI.pinyinNode(e.pinyin, pyOpts())) : null,
          h("div", { class: "r-def" }, e ? shortGloss(e) : (HL.charInfo(t.text).ud || ""))));
      row.addEventListener("click", () => navigate({ type: "word", word: t.text, context: text }));
      rows.appendChild(row);
    }
    root.appendChild(section("Words", seen.size, rows));
    return root;
  }

  // ------------------------------------------------------------------ transcript
  function fmtTime(s) {
    if (!isFinite(s)) return "";
    s = Math.max(0, Math.floor(s));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
  }
  function lineRow(l) {
    const tr = S.tr.get(l.text) || l.tr || "";
    const row = h("div", { class: "tl-row", dataset: { start: l.start } },
      h("div", { class: "tl-t", title: "Jump to this line" }, fmtTime(l.start)),
      h("div", null, h("div", { class: "tl-zh" }, zhText(l.text)), h("div", { class: "tl-tr" }, tr)));
    row._line = l;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".wl")) return;
      UI.post("seek", { time: l.start });
    });
    return row;
  }
  function renderTranscript() {
    const p = panes.lines;
    p.textContent = "";
    if (S.trStatus) p.appendChild(trNotice());
    if (!S.lines.length) {
      p.appendChild(h("div", { class: "empty" },
        h("div", { class: "glyph" }, "文"),
        h("h3", null, "No lines yet"),
        h("p", null, "Subtitle lines appear here as they play. With an external .srt or .ass file, the whole transcript loads at once.")));
      return;
    }
    p.appendChild(h("div", { class: "tl-head" }, h("span", null, S.fromFile ? `${S.lines.length} lines` : "Lines seen so far")));
    const list = h("div", { class: "tl", id: "tl" });
    const frag = document.createDocumentFragment();
    S.lines.forEach((l) => frag.appendChild(lineRow(l)));
    list.appendChild(frag);
    p.appendChild(list);
    markCurrent();
  }
  function markCurrent() {
    const list = $("tl");
    if (!list || !S.current) return;
    let best = null;
    for (const r of list.children) {
      const l = r._line;
      if (l.text === S.current.text && Math.abs(l.start - S.current.start) < 1.5) { best = r; break; }
    }
    list.querySelectorAll(".tl-row.cur").forEach((r) => { if (r !== best) r.classList.remove("cur"); });
    if (best && !best.classList.contains("cur")) {
      best.classList.add("cur");
      scrollToCurrent(true);
    }
  }
  function scrollToCurrent(smooth) {
    const r = panes.lines.querySelector(".tl-row.cur");
    if (!r || S.tab !== "lines") return;
    if (Date.now() - S.userScrolledAt < 4000) return;
    const p = panes.lines;
    const target = r.offsetTop - p.clientHeight * 0.38;
    p.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
  }
  panes.lines.addEventListener("wheel", () => { S.userScrolledAt = Date.now(); }, { passive: true });

  function trNotice() {
    const isMissing = S.trStatus === "supported";
    return h("div", { class: "notice" },
      isMissing
        ? [h("b", null, "Translation needs a language download. "), "In System Settings › General › Language & Region › Translation Languages, download Chinese and your language. Lines will then translate on this Mac."]
        : [h("b", null, "On-device translation isn't available "), "for this language pair. Choose another target language in Hanzi Lens settings."]);
  }

  // ------------------------------------------------------------------ starred
  function renderStarred() {
    const p = panes.starred;
    p.textContent = "";
    if (!S.starred.length) {
      p.appendChild(h("div", { class: "empty" },
        h("div", { class: "glyph" }, "★"),
        h("h3", null, "No starred words"),
        h("p", null, "Star words from the subtitle card (press S) or from an entry. Export them as a Pleco flashcard file.")));
      return;
    }
    p.appendChild(h("div", { class: "tl-head" }, h("span", null, S.starred.length + (S.starred.length === 1 ? " word" : " words")),
      h("div", { class: "btn-row" },
        h("button", { class: "btn", onclick: () => copyText(S.starred.map((x) => x.simp + "\t" + HL.marked(x.pinyin) + "\t" + x.def).join("\n")) }, "Copy"),
        h("button", { class: "btn", onclick: () => UI.post("exportStarred", {}) }, "Export for Pleco…"))));
    const rows = h("div", { class: "rows has-x" });
    S.starred.forEach((x) => {
      const rm = h("button", { class: "r-x", title: "Remove", "aria-label": "Remove", html: ICONS.clear.replace('fill="currentColor"', 'fill="none"') });
      rm.innerHTML = '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      rm.addEventListener("click", (e) => { e.stopPropagation(); UI.post("star", x); });
      const row = h("div", { class: "row" },
        h("div", null, h("span", { class: "r-hw" }, x.simp), x.trad && x.trad !== x.simp ? h("span", { class: "r-alt" }, x.trad) : null),
        h("div", { class: "r-body" }, h("div", { class: "r-py" }, UI.pinyinNode(x.pinyin, pyOpts())), h("div", { class: "r-def" }, x.def)),
        rm);
      row.addEventListener("click", () => navigate({ type: "word", word: x.simp, context: x.context }));
      rows.appendChild(row);
    });
    p.appendChild(rows);
  }

  // ------------------------------------------------------------------ settings
  const SETTINGS = [
    ["Subtitles", [
      ["enabled", "Interactive Chinese subtitles", "Draws the subtitle line so every word can be clicked.", "⌥⌘L"],
      ["autoSelect", "Pick the Chinese track automatically", "When a file opens with no subtitle track selected."],
    ]],
    ["Reading aids", [
      ["pinyin", "Pinyin above characters", null, "⌥⌘P"],
      ["zhuyin", "Zhuyin instead of pinyin", "Bopomofo, as used in Taiwan."],
      ["toneShapes", "Tone shapes", "A small pitch contour beside each syllable in word cards. Works without color."],
      ["toneColors", "Tone colors", "Red, green, blue and purple by tone. Hard to tell apart with color-vision deficiency."],
    ]],
    ["Translation", [
      ["translate", "Translation under each line", null, "⌥⌘T"],
      ["useSecondary", "Prefer the file’s English subtitles", "Uses the show’s own English track when it has one. On-device translation fills any gaps.", null, "translate"],
      ["blurTranslation", "Blur until clicked", "Keeps the translation hidden until you want it.", null, "translate"],
      ["targetLang", "Language", "A code such as en, fr, de or ja for on-device translation.", null, "translate", "text"],
    ]],
    ["Playback", [
      ["pauseOnLookup", "Pause while a word card is open"],
    ]],
  ];
  function setPref(key, value) {
    S.settings[key] = value;
    UI.post("setPref", { key, value });
  }
  function renderSettings() {
    const p = panes.settings;
    const keep = p.scrollTop;
    p.textContent = "";
    const s = S.settings;
    for (const [title, rows] of SETTINGS) {
      const group = h("div", { class: "set-group" });
      for (const [key, label, help, shortcut, dependsOn, kind] of rows) {
        const off = dependsOn && s[dependsOn] === false;
        let control;
        if (kind === "text") {
          control = h("input", { class: "set-text", type: "text", value: s[key] || "", placeholder: "Auto", maxlength: "8", spellcheck: "false", autocomplete: "off", "aria-label": label });
          control.addEventListener("change", () => setPref(key, control.value.trim()));
          control.addEventListener("keydown", (e) => { if (e.key === "Enter") control.blur(); e.stopPropagation(); });
          if (off) control.disabled = true;
        } else {
          const on = key === "toneShapes" ? s[key] !== false : !!s[key];
          control = h("button", { class: "sw", role: "switch", "aria-checked": String(on), "aria-label": label });
          control.appendChild(h("span", { class: "knob" }));
          if (off) control.disabled = true;
          control.addEventListener("click", (e) => {
            e.stopPropagation();
            const next = control.getAttribute("aria-checked") !== "true";
            control.setAttribute("aria-checked", String(next));
            setPref(key, next);
            // Rows that depend on this one enable/disable without rebuilding (keeps the knob animating).
            p.querySelectorAll(`[data-dep="${key}"]`).forEach((r) => {
              r.classList.toggle("off", !next);
              r.querySelectorAll("button, input").forEach((c) => { c.disabled = !next; });
            });
          });
        }
        const row = h("div", { class: "set-row" + (off ? " off" : ""), "data-key": key, "data-dep": dependsOn || null },
          h("div", { class: "set-text-col" },
            h("div", { class: "set-label" }, label, shortcut ? h("kbd", null, shortcut) : null),
            help ? h("div", { class: "set-help" }, help) : null),
          control);
        if (kind !== "text") row.addEventListener("click", () => { if (!control.disabled) control.click(); });
        group.appendChild(row);
      }
      p.appendChild(h("div", { class: "section set-section" }, h("h4", null, title), group));
    }
    p.appendChild(h("p", { class: "set-foot" }, "Subtitle font, size, color and position follow IINA’s own Subtitles settings."));
    p.scrollTop = keep;
  }

  // ------------------------------------------------------------------ messages
  UI.onMessage("settings", (s) => {
    const changed = s.toneColors !== S.settings.toneColors || s.toneShapes !== S.settings.toneShapes || s.zhuyin !== S.settings.zhuyin;
    S.settings = Object.assign(S.settings, s);
    if (s.debugSlow) UI.setSlow(s.debugSlow);
    if (changed && S.hpos >= 0) render(S.hist[S.hpos]);
    if (S.tab === "settings" && !panes.settings.contains(document.activeElement)) syncSettings();
  });
  /** Reflect changes made elsewhere (menu, shortcuts) without rebuilding the rows. */
  function syncSettings() {
    panes.settings.querySelectorAll(".set-row").forEach((r) => {
      const key = r.dataset.key, v = S.settings[key];
      const sw = r.querySelector(".sw"), tx = r.querySelector(".set-text");
      if (sw) sw.setAttribute("aria-checked", String(key === "toneShapes" ? v !== false : !!v));
      if (tx && document.activeElement !== tx) tx.value = v || "";
      const off = r.dataset.dep && S.settings[r.dataset.dep] === false;
      r.classList.toggle("off", !!off);
      r.querySelectorAll("button, input").forEach((c) => { c.disabled = !!off; });
    });
  }
  UI.onMessage("showSettings", () => setTab("settings", true));
  UI.onMessage("lookup", (d) => {
    if (!d || !d.word) return;
    $q.value = ""; syncSearchUI();
    navigate({ type: "word", word: d.word, context: d.context || "" });
  });
  UI.onMessage("lookupLine", (d) => { if (d && d.text) navigate({ type: "line", text: d.text }); });
  UI.onMessage("transcript", (d) => {
    S.lines = d.lines || [];
    S.fromFile = !!d.fromFile;
    S.lines.forEach((l) => { if (l.tr) S.tr.set(l.text, l.tr); });
    renderTranscript();
  });
  UI.onMessage("line", (l) => {
    if (S.fromFile) return;
    S.lines.push(l);
    const list = $("tl");
    if (!list) { renderTranscript(); return; }
    const row = lineRow(l);
    list.appendChild(row);
    row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T(200), easing: EASE.std });
  });
  UI.onMessage("current", (c) => { S.current = c; markCurrent(); });
  UI.onMessage("translation", (d) => {
    S.tr.set(d.text, d.translation);
    const list = $("tl");
    if (list) {
      for (const r of list.children) {
        if (r._line.text === d.text) {
          const el = r.querySelector(".tl-tr");
          if (el && !el.textContent) {
            el.textContent = d.translation;
            el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T(180), easing: EASE.std });
          }
        }
      }
    }
    const v = S.hist[S.hpos];
    if (v && S.tab === "dict" && ((v.type === "line" && v.text === d.text) || (v.type === "word" && v.context === d.text))) {
      const st = panes.dict.scrollTop; render(v); panes.dict.scrollTop = st;
    }
  });
  UI.onMessage("translationStatus", (d) => { S.trStatus = d.status; renderTranscript(); });
  UI.onMessage("ping", () => { UI.post("ready", { again: true }); lastState = ""; reportState(); });
  UI.onMessage("starred", (d) => {
    S.starred = d.items || [];
    renderStarred();
  });

  // ------------------------------------------------------------------ boot
  HL.load();
  setTab("dict", false);
  render({ type: "empty" });
  renderTranscript();
  renderStarred();
  // IINA's sidebar floats over the video; tell the plugin when this one is showing so the subtitle
  // line can center itself in the part of the picture that is still visible.
  let lastState = "";
  function reportState() {
    const st = { visible: document.visibilityState === "visible" && window.innerWidth > 0, width: window.innerWidth };
    const key = JSON.stringify(st);
    if (key === lastState) return;
    lastState = key;
    UI.post("sidebarState", st);
  }
  document.addEventListener("visibilitychange", reportState);
  window.addEventListener("resize", reportState);
  setInterval(reportState, 1000);
  UI.post("ready", {});
  reportState();
  window.HLSidebar = { S, navigate, setTab, render };
})();
