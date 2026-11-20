/* Hanzi Lens — dictionary engine shared by the overlay and the sidebar.
 * Requires data/words.js (HL_WORDS) and data/chars.js (HL_CHARS); data/examples.js is optional/lazy. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ pinyin
  const TONE_MARKS = {
    a: "āáǎàa", e: "ēéěèe", i: "īíǐìi", o: "ōóǒòo", u: "ūúǔùu", v: "ǖǘǚǜü",
  };

  function syllableToMarked(syl) {
    const m = /^([a-zA-ZüÜ:]+?)([1-5])?$/.exec(syl);
    if (!m) return syl;
    let base = m[1].replace(/u:/g, "v").replace(/U:/g, "V");
    const tone = m[2] ? parseInt(m[2], 10) : 5;
    const lower = base.toLowerCase();
    let idx = -1;
    if (lower.includes("a")) idx = lower.indexOf("a");
    else if (lower.includes("e")) idx = lower.indexOf("e");
    else if (lower.includes("ou")) idx = lower.indexOf("o");
    else {
      for (let i = lower.length - 1; i >= 0; i--) {
        if ("iouv".includes(lower[i])) { idx = i; break; }
      }
    }
    let out = "";
    for (let i = 0; i < base.length; i++) {
      const ch = base[i];
      const lc = ch.toLowerCase();
      let rep = lc === "v" ? "ü" : lc;
      if (i === idx && TONE_MARKS[lc]) rep = TONE_MARKS[lc][tone - 1];
      out += ch !== lc ? rep.toUpperCase() : rep;
    }
    return out;
  }

  /** "ni3 hao3" -> [{text:"nǐ", tone:3}, {text:"hǎo", tone:3}] */
  function syllables(numeric) {
    return numeric.split(/\s+/).filter(Boolean).map((s) => {
      const t = /([1-5])$/.exec(s);
      const isSyl = /^[a-zA-Z:]+[1-5]?$/.test(s) && /[aeiouvAEIOUV]|^[mnMN]g?\d?$|^r5$/.test(s);
      return { text: isSyl ? syllableToMarked(s) : s, tone: t ? parseInt(t[1], 10) : 0, raw: s };
    });
  }

  function marked(numeric) {
    return syllables(numeric).map((s) => s.text).join(" ");
  }

  /** Strip tones, spaces and case for fuzzy pinyin search: "Ni3 hao3" -> "nihao" */
  function toneless(numeric) {
    return numeric.toLowerCase().replace(/u:/g, "v").replace(/ü/g, "v").replace(/[1-5\s·,'-]/g, "");
  }

  // Zhuyin (bopomofo)
  const ZY_INITIALS = [
    ["zh", "ㄓ"], ["ch", "ㄔ"], ["sh", "ㄕ"], ["b", "ㄅ"], ["p", "ㄆ"], ["m", "ㄇ"], ["f", "ㄈ"],
    ["d", "ㄉ"], ["t", "ㄊ"], ["n", "ㄋ"], ["l", "ㄌ"], ["g", "ㄍ"], ["k", "ㄎ"], ["h", "ㄏ"],
    ["j", "ㄐ"], ["q", "ㄑ"], ["x", "ㄒ"], ["r", "ㄖ"], ["z", "ㄗ"], ["c", "ㄘ"], ["s", "ㄙ"],
  ];
  const ZY_FINALS = {
    a: "ㄚ", o: "ㄛ", e: "ㄜ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ", an: "ㄢ", en: "ㄣ", ang: "ㄤ",
    eng: "ㄥ", ong: "ㄨㄥ", er: "ㄦ", i: "ㄧ", ia: "ㄧㄚ", ie: "ㄧㄝ", iao: "ㄧㄠ", iu: "ㄧㄡ", ian: "ㄧㄢ",
    in: "ㄧㄣ", iang: "ㄧㄤ", ing: "ㄧㄥ", iong: "ㄩㄥ", u: "ㄨ", ua: "ㄨㄚ", uo: "ㄨㄛ", uai: "ㄨㄞ",
    ui: "ㄨㄟ", uan: "ㄨㄢ", un: "ㄨㄣ", uang: "ㄨㄤ", v: "ㄩ", ve: "ㄩㄝ", van: "ㄩㄢ", vn: "ㄩㄣ", r: "ㄦ",
  };
  const ZY_TONES = ["", "ˊ", "ˇ", "ˋ", "˙"];
  function syllableToZhuyin(raw) {
    const m = /^([a-zA-Z:]+?)([1-5])?$/.exec(raw);
    if (!m) return raw;
    let s = m[1].toLowerCase().replace("u:", "v");
    const tone = m[2] ? parseInt(m[2], 10) : 5;
    if (s === "r") return "ㄦ" + (tone === 5 ? "" : ZY_TONES[tone - 1]);
    let ini = "";
    for (const [p, z] of ZY_INITIALS) {
      if (s.startsWith(p)) { ini = z; s = s.slice(p.length); break; }
    }
    if (!ini) {
      if (s.startsWith("yu")) s = "v" + s.slice(2);
      else if (s.startsWith("y")) s = s === "yi" || s === "yin" || s === "ying" ? s.slice(1) : "i" + s.slice(1);
      else if (s.startsWith("w")) s = s === "wu" ? "u" : "u" + s.slice(1);
    } else if (ini && "ㄐㄑㄒ".includes(ini) && s.startsWith("u")) s = "v" + s.slice(1);
    if (ini && "ㄓㄔㄕㄖㄗㄘㄙ".includes(ini) && s === "i") s = "";
    const fin = s === "" ? "" : ZY_FINALS[s] || s;
    const t = tone === 5 ? "" : ZY_TONES[tone - 1];
    return (tone === 5 ? "˙" : "") + ini + fin + (tone === 5 ? "" : t);
  }

  // ------------------------------------------------------------------ words
  const W = { t: [], s: [], p: [], d: [], f: [], h: [], o: [], j: [] };
  const index = new Map(); // headword -> [entry ids]
  let maxLen = 1;
  let totalFreq = 0;
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    const lines = root.HL_WORDS.split("\n");
    root.HL_WORDS = null;
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i].split("\t");
      W.t.push(c[0]); W.s.push(c[1]); W.p.push(c[2]); W.d.push(c[3]);
      const f = c[4] ? +c[4] : 0;
      W.f.push(f); W.h.push(c[5] ? +c[5] : 0); W.o.push(c[6] ? +c[6] : 0); W.j.push(c[7] || "");
      add(c[1], i);
      if (c[0] !== c[1]) add(c[0], i);
      totalFreq += f;
      if (c[1].length > maxLen) maxLen = c[1].length;
    }
    if (maxLen > 12) maxLen = 12;
  }
  function add(k, i) {
    const a = index.get(k);
    if (a) { if (!a.includes(i)) a.push(i); } else index.set(k, [i]);
  }

  function entry(i) {
    return {
      id: i, trad: W.t[i], simp: W.s[i], pinyin: W.p[i], defs: W.d[i].split("/"),
      freq: W.f[i], hsk: W.h[i], hskOld: W.o[i], jyutping: W.j[i],
    };
  }

  const LOW_PRIORITY = /^(surname |variant of |old variant of |used in |see |\(archaic\)|erhua variant|Japanese variant|\(old\)|abbr\. for)/i;

  // Standalone readings for frequent polyphones, where Unihan's ordering misleads.
  const PREFERRED = {
    长: "chang2", 得: "de5", 只: "zhi3", 干: "gan4", 幹: "gan4", 发: "fa1", 少: "shao3", 好: "hao3", 难: "nan2",
    教: "jiao1", 当: "dang1", 数: "shu4", 便: "bian4", 乐: "le4", 大: "da4", 看: "kan4", 中: "zhong1",
    要: "yao4", 把: "ba3", 倒: "dao4", 假: "jia3", 调: "diao4", 应: "ying1", 传: "chuan2", 觉: "jue2",
    的: "de5", 地: "de5", 着: "zhe5", 了: "le5", 还: "hai2", 都: "dou1", 没: "mei2", 会: "hui4", 么: "me5",
    長: "chang2", 發: "fa1", 樂: "le4", 數: "shu4", 當: "dang1", 難: "nan2", 還: "hai2", 會: "hui4", 覺: "jue2",
    為: "wei4", 为: "wei4", 着: "zhe5", 著: "zhe5", 和: "he2", 那: "na4", 哪: "na3", 吗: "ma5", 嗎: "ma5", 么: "me5", 似: "si4", 处: "chu4",
  };

  function entryScore(i, word) {
    let s = 0;
    if (word && PREFERRED[word] === W.p[i]) s += 40;
    const p = W.p[i];
    if (p && p[0] !== p[0].toLowerCase()) s -= 40; // proper noun
    const d0 = W.d[i];
    if (LOW_PRIORITY.test(d0)) s -= 30;
    if (W.d[i].startsWith("surname")) s -= 10;
    if (W.h[i]) s += 20 - W.h[i];
    if (W.o[i]) s += 10 - W.o[i];
    s += Math.min(W.d[i].split("/").length, 8);
    // Unihan's first Mandarin reading is the most common one.
    if (word && word.length === 1) {
      const ch = root.HL_CHARS && root.HL_CHARS[word];
      if (ch && ch.um) {
        const first = toneless(ch.um.split(" ")[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "")).replace("ü", "v");
        const firstTone = toneOfMarked(ch.um.split(" ")[0]);
        if (toneless(p) === first) s += 6;
        if (toneless(p) === first && (parseInt(p.slice(-1), 10) || 5) === firstTone) s += 6;
      }
    }
    return s;
  }
  function toneOfMarked(syl) {
    const n = syl.normalize("NFD");
    if (n.includes("\u0304")) return 1;
    if (n.includes("\u0301")) return 2;
    if (n.includes("\u030c")) return 3;
    if (n.includes("\u0300")) return 4;
    return 5;
  }

  /** All entries for an exact headword (simplified or traditional), best first. */
  function lookup(word) {
    load();
    const ids = index.get(word);
    if (!ids) return [];
    return ids.slice().sort((a, b) => entryScore(b, word) - entryScore(a, word)).map(entry);
  }

  function has(word) { load(); return index.has(word); }

  function wordFreq(word) {
    load();
    const ids = index.get(word);
    if (!ids) return 0;
    let f = 0;
    for (const i of ids) if (W.f[i] > f) f = W.f[i];
    return f;
  }

  // ------------------------------------------------------------------ segmentation
  const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}〇]/u;
  function isHan(ch) { return HAN.test(ch); }

  /**
   * Max-probability segmentation (jieba-style DAG) restricted to dictionary words, so every
   * token can be looked up. Returns [{text, start, han, known}].
   */
  function segment(text) {
    load();
    const chars = Array.from(text);
    const tokens = [];
    let i = 0;
    let offset = 0;
    while (i < chars.length) {
      if (!isHan(chars[i])) {
        let j = i;
        let s = "";
        const alnum = /[A-Za-z0-9]/.test(chars[i]);
        while (j < chars.length && !isHan(chars[j]) && (alnum ? /[A-Za-z0-9'’.-]/.test(chars[j]) : !/[A-Za-z0-9]/.test(chars[j]))) {
          s += chars[j]; j++;
          if (!alnum) break; // punctuation / spaces one by one
        }
        tokens.push({ text: s, start: offset, han: false, known: false });
        offset += s.length; i = j; continue;
      }
      let j = i;
      while (j < chars.length && isHan(chars[j])) j++;
      const run = chars.slice(i, j);
      for (const t of segmentRun(run)) {
        tokens.push({ text: t, start: offset, han: true, known: index.has(t) });
        offset += t.length;
      }
      i = j;
    }
    return tokens;
  }

  function segmentRun(run) {
    const n = run.length;
    const logTotal = Math.log(totalFreq || 1);
    const unk = Math.log(1) - logTotal - 4; // unknown single char penalty
    const best = new Array(n + 1).fill(-Infinity);
    const back = new Array(n + 1).fill(0);
    best[n] = 0;
    for (let i = n - 1; i >= 0; i--) {
      let w = "";
      for (let k = i; k < Math.min(n, i + maxLen); k++) {
        w += run[k];
        let score;
        if (index.has(w)) {
          const f = wordFreq(w);
          score = Math.log(f > 0 ? f : (w.length > 1 ? 3 : 1)) - logTotal;
        } else if (k === i) score = unk;
        else continue;
        const total = score + best[k + 1];
        if (total > best[i]) { best[i] = total; back[i] = k + 1; }
      }
    }
    const out = [];
    let i = 0;
    while (i < n) { out.push(run.slice(i, back[i]).join("")); i = back[i]; }
    return out;
  }

  /** Every dictionary word that starts at `pos` within `text`, longest first (Pleco-style). */
  function prefixesAt(text, pos) {
    load();
    const chars = Array.from(text).slice(pos, pos + maxLen);
    const out = [];
    let w = "";
    for (const c of chars) {
      if (!isHan(c)) break;
      w += c;
      if (index.has(w)) out.push(w);
    }
    return out.reverse();
  }

  // ------------------------------------------------------------------ search
  let pinyinIndex = null;
  function buildPinyinIndex() {
    pinyinIndex = new Map();
    for (let i = 0; i < W.p.length; i++) {
      const k = toneless(W.p[i]);
      const a = pinyinIndex.get(k);
      if (a) a.push(i); else pinyinIndex.set(k, [i]);
    }
  }

  function rankIds(ids, primary) {
    return ids.sort((a, b) => {
      const pa = primary ? primary(a) : 0, pb = primary ? primary(b) : 0;
      if (pa !== pb) return pb - pa;
      return (W.f[b] - W.f[a]) || (W.s[a].length - W.s[b].length);
    });
  }

  /** Search by hanzi, pinyin (with or without tones/spaces) or English. */
  function search(query, limit) {
    load();
    limit = limit || 60;
    const q = query.trim();
    if (!q) return [];
    if (HAN.test(q)) {
      const ids = new Set(index.get(q) || []);
      const extra = [];
      for (let i = 0; i < W.s.length && extra.length < 4000; i++) {
        if (ids.has(i)) continue;
        if (W.s[i].startsWith(q) || W.t[i].startsWith(q)) extra.push(i);
      }
      const exact = rankIds([...ids], (i) => entryScore(i, q));
      const pre = rankIds(extra);
      let out = exact.concat(pre);
      if (out.length < limit) {
        const more = [];
        for (let i = 0; i < W.s.length && more.length < 2000; i++) {
          if (!ids.has(i) && !W.s[i].startsWith(q) && !W.t[i].startsWith(q) && (W.s[i].includes(q) || W.t[i].includes(q))) more.push(i);
        }
        out = out.concat(rankIds(more));
      }
      return out.slice(0, limit).map(entry);
    }
    const ascii = q.toLowerCase();
    const hasTones = /[1-5]/.test(ascii) || /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(ascii);
    if (!pinyinIndex) buildPinyinIndex();
    const pkey = toneless(ascii.normalize("NFD").replace(/[\u0300-\u036f]/g, "")).replace(/[^a-z]/g, "");
    let pyIds = [];
    if (pkey && /^[a-zü:\s1-5'āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/i.test(ascii)) {
      pyIds = (pinyinIndex.get(pkey) || []).slice();
      if (hasTones) {
        const wanted = numericFrom(ascii);
        if (wanted) pyIds = pyIds.filter((i) => W.p[i].toLowerCase().replace(/\s+/g, "") === wanted);
      }
      if (pyIds.length < limit && pkey.length >= 2 && !hasTones) {
        for (const [k, a] of pinyinIndex) {
          if (k !== pkey && k.startsWith(pkey)) pyIds.push(...a);
          if (pyIds.length > 3000) break;
        }
      }
      pyIds = rankIds(pyIds, (i) =>
        (toneless(W.p[i]) === pkey ? 4 : 0) +
        (W.p[i][0] === W.p[i][0].toLowerCase() ? 2 : 0) +
        (LOW_PRIORITY.test(W.d[i]) ? 0 : 1) + (W.h[i] || W.o[i] ? 0.5 : 0) + entryScore(i, W.s[i]) / 1000);
    }
    // English: whole-word match inside a definition, prefer definitions that *are* the query.
    const enIds = [];
    if (/^[a-z][a-z\s'-]*$/i.test(q) && q.length >= 2) {
      const re = new RegExp("(^|[^a-z])" + ascii.replace(/[-]/g, "\\-") + "($|[^a-z])", "i");
      for (let i = 0; i < W.d.length; i++) {
        const d = W.d[i];
        if (re.test(d) && re.test(d.replace(/\[[^\]]*\]/g, ""))) enIds.push(i);
      }
      const exactDef = (i) => {
        const ds = W.d[i].toLowerCase().split(/[\/;]/).map((x) => x.trim().replace(/^to /, "").replace(/\(.*?\)\s*/g, ""));
        return ds.includes(ascii.replace(/^to /, "")) ? 2 : ds[0].includes(ascii) ? 1 : 0;
      };
      rankIds(enIds, (i) => exactDef(i) * 1e9 + (W.p[i][0] === W.p[i][0].toLowerCase() ? 1e8 : 0) + W.f[i] / 1e3);
    }
    const seen = new Set();
    const out = [];
    const take = (ids) => { for (const i of ids) { if (!seen.has(i)) { seen.add(i); out.push(i); } } };
    const exactPinyin = pyIds.length && toneless(W.p[pyIds[0]]) === pkey;
    if (pyIds.length && (exactPinyin || hasTones || pyIds.length >= enIds.length)) { take(pyIds); take(enIds); }
    else { take(enIds); take(pyIds); }
    return out.slice(0, limit).map(entry);
  }

  /** "ni3 hao3" -> "ni3hao3"; tone-marked input ("nǐ hǎo") converts per space-separated syllable. */
  function numericFrom(s) {
    s = s.toLowerCase().replace(/ü/g, "v");
    if (/[1-5]/.test(s)) return s.replace(/\s+/g, "");
    const parts = s.split(/[\s']+/).filter(Boolean);
    return parts.map((p) => {
      const tone = toneOfMarked(p);
      return p.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/̈/g, "") + tone;
    }).join("");
  }

  // ------------------------------------------------------------------ characters & related words
  function charInfo(c) {
    const info = (root.HL_CHARS && root.HL_CHARS[c]) || {};
    return info;
  }

  function compounds(word, limit) {
    load();
    const out = [];
    for (let i = 0; i < W.s.length; i++) {
      if (W.s[i].length > word.length && (W.s[i].includes(word) || W.t[i].includes(word))) {
        if (W.p[i][0] !== W.p[i][0].toLowerCase()) continue;
        out.push(i);
      }
    }
    return rankIds(out, (i) => (W.s[i].startsWith(word) || W.t[i].startsWith(word) ? 0 : 0))
      .filter((i) => W.f[i] > 0 || W.h[i])
      .slice(0, limit || 24)
      .map(entry);
  }

  let examples = null;
  function examplesFor(word, alt, limit) {
    if (!examples) {
      if (!root.HL_EXAMPLES) return null;
      examples = root.HL_EXAMPLES.split("\n").map((l) => l.split("\t"));
      root.HL_EXAMPLES = null;
    }
    // Gather candidates, then prefer natural mid-length sentences in the same script as the word.
    const want = scriptOf(word);
    const cands = [];
    for (const ex of examples) {
      if (ex[0].includes(word) || (alt && ex[0].includes(alt))) {
        cands.push(ex);
        if (cands.length >= 400) break;
      }
    }
    const score = (ex) => {
      const n = Array.from(ex[0]).length;
      let s = -Math.abs(n - 13);
      if (n < 6) s -= 8;
      if (want === "zh-Hans" ? ex[0].includes(word) : (alt ? !ex[0].includes(alt) : true)) s += 6;
      if (scriptOf(ex[0]) === want) s += 6;
      return s;
    };
    return cands.map((ex) => [score(ex), ex]).sort((a, b) => b[0] - a[0]).slice(0, limit || 6)
      .map(([, ex]) => ({ zh: ex[0], en: ex[1] }));
  }

  // ------------------------------------------------------------------ Cantonese (Jyutping)
  /** Jyutping for every character of a line (one entry per code point, "" where there is none).
   *  CanCLID's ToJyutping reads characters in context (係咪 mai6, 喺度 dou6, 會 wui5/wui2); any character it
   *  leaves out falls back to the bundled CC-Canto / Unihan readings. */
  function jyutLine(text) {
    const chars = Array.from(text);
    let out = null;
    try {
      if (root.ToJyutping) {
        // ToJyutping is built on traditional characters; simplified text reads better converted first (种 → 種).
        const src = scriptOf(text) === "zh-Hans" ? toTraditional(text) : text;
        const list = root.ToJyutping.getJyutpingList(src);
        if (list.length === chars.length) out = list.map((x) => x[1] || "");
      }
    } catch (e) { out = null; }
    if (!out) out = chars.map(() => "");
    return out.map((r, i) => r || (isHan(chars[i]) ? dictJyut(chars[i]) : ""));
  }

  /** Word-by-word simplified → traditional through CC-CEDICT's pairs; keeps one character per character. */
  function toTraditional(text) {
    return segment(text).map((t) => {
      if (!t.han || !t.known) return t.text;
      const e = lookup(t.text).find((x) => x.simp === t.text);
      return e && Array.from(e.trad).length === Array.from(t.text).length ? e.trad : t.text;
    }).join("");
  }

  /** Jyutping for a word: in context from ToJyutping, else from the bundled data (dictJyut). */
  function jyutReading(word) {
    return jyutLine(word).filter(Boolean).join(" ");
  }

  /** Bundled data only: CC-Canto's reading of the best dictionary entry when it covers every character,
   *  otherwise character by character (the character's own CC-Canto entry, then Unihan's Cantonese reading). */
  function dictJyut(word) {
    load();
    const chars = Array.from(word);
    const best = (w) => {
      const ids = index.get(w);
      if (!ids) return "";
      const i = ids.slice().sort((a, b) => entryScore(b, w) - entryScore(a, w)).find((k) => W.j[k]);
      return i === undefined ? "" : W.j[i];
    };
    const whole = best(word);
    if (whole && whole.trim().split(/\s+/).length === chars.length) return whole.trim();
    return chars.map((c) => {
      if (!isHan(c)) return c;
      const own = best(c).trim().split(/\s+/)[0];
      if (own) return own;
      const uc = root.HL_CHARS && root.HL_CHARS[c] && root.HL_CHARS[c].uc;
      return uc ? uc.split(" ")[0] : "";
    }).join(" ").trim();
  }

  /** "ngo5 dei6" -> [{text:"ngo5", tone:5, raw:"ngo5"}, ...] (tones 1–6) */
  function jyutSyllables(s) {
    return (s || "").split(/\s+/).filter(Boolean).map((x) => {
      const m = /^[a-z]+([1-6])$/.exec(x);
      return { text: x, tone: m ? parseInt(m[1], 10) : 0, raw: x, jyut: true };
    });
  }

  /** Best single reading for a token (used for subtitle ruby). */
  function bestReading(word) {
    const e = lookup(word);
    return e.length ? e[0].pinyin : "";
  }

  /** Detect script: characters that never occur in a simplified headword are traditional-only, and
   *  vice versa (CC-CEDICT). Merged characters such as 了/后/发 count for neither. */
  let tradOnly = null, simpOnly = null;
  function buildScriptSets() {
    load();
    const inT = new Set(), inS = new Set();
    for (let i = 0; i < W.t.length; i++) {
      for (const c of W.t[i]) inT.add(c);
      for (const c of W.s[i]) inS.add(c);
    }
    tradOnly = new Set([...inT].filter((c) => !inS.has(c) && isHan(c)));
    simpOnly = new Set([...inS].filter((c) => !inT.has(c) && isHan(c)));
  }
  function scriptOf(text) {
    if (!tradOnly) buildScriptSets();
    let t = 0, s = 0;
    for (const c of text) {
      if (tradOnly.has(c)) t++;
      else if (simpOnly.has(c)) s++;
    }
    return t > s ? "zh-Hant" : "zh-Hans";
  }

  root.HL = {
    load, lookup, has, segment, prefixesAt, search, charInfo, compounds, examplesFor, bestReading, jyutReading, jyutLine, jyutSyllables,
    scriptOf, isHan, syllables, marked, toneless, syllableToZhuyin, entryScore,
  };
})(window);
