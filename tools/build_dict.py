#!/usr/bin/env python3
"""Merge open-source Chinese lexical data into compact JS bundles for Hanzi Lens.

Usage: python3 -I build_dict.py <raw-dir> <plugin-ui-dir>

Sources (all downloaded unmodified into <raw-dir>):
  cedict.txt                 CC-CEDICT (MDBG)                         CC BY-SA 4.0
  canto/*.txt                CC-Canto readings for CC-CEDICT          CC BY-SA 3.0
  hsk.json                   complete-hsk-vocabulary (drkameleon)     MIT
  jieba_big.txt              jieba dict.txt.big word frequencies     MIT
  unihan/                    Unicode Unihan database                  Unicode License
  mmah_dictionary.txt        Make Me a Hanzi dictionary               LGPL / Arphic PL
  hwd/package/*.json         hanzi-writer-data stroke geometry        Arphic PL
  cmn_sentences.tsv etc.     Tatoeba sentence pairs                   CC BY 2.0 FR
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

raw, out = sys.argv[1], sys.argv[2]
data_dir = os.path.join(out, "data")
stroke_dir = os.path.join(out, "strokes")
os.makedirs(data_dir, exist_ok=True)
os.makedirs(stroke_dir, exist_ok=True)


def js_string(s):
    return json.dumps(s, ensure_ascii=False)


# ---------------------------------------------------------------- CC-CEDICT
line_re = re.compile(r"^(\S+) (\S+) \[([^\]]*)\] /(.*)/\s*$")
entries = []
for line in open(os.path.join(raw, "cedict.txt"), encoding="utf-8"):
    if line.startswith("#"):
        continue
    m = line_re.match(line)
    if not m:
        continue
    trad, simp, pinyin, defs = m.groups()
    pinyin = pinyin.replace("u:", "v")
    defs = [d for d in defs.split("/") if d]
    entries.append({"t": trad, "s": simp, "p": pinyin, "d": defs})
print("cedict entries", len(entries))


def norm_py(p):
    return re.sub(r"\s+", "", p.lower().replace("u:", "v"))


# ---------------------------------------------------------------- Cantonese
canto = {}
for path in glob.glob(os.path.join(raw, "canto", "*.txt")):
    for line in open(path, encoding="utf-8"):
        if line.startswith("#"):
            continue
        m = re.match(r"^(\S+) (\S+) \[([^\]]*)\] \{([^}]*)\}", line)
        if m:
            canto[(m.group(1), m.group(2), norm_py(m.group(3)))] = m.group(4)

# ---------------------------------------------------------------- HSK
hsk_new, hsk_old = {}, {}
for e in json.load(open(os.path.join(raw, "hsk.json"), encoding="utf-8")):
    levels = e["level"]
    newest = [int(l.split("-")[1]) for l in levels if l.startswith("newest-")]
    new = [int(l.split("-")[1]) for l in levels if l.startswith("new-")]
    old = [int(l.split("-")[1]) for l in levels if l.startswith("old-")]
    lvl = (newest or new or [None])[0]
    for f in e["forms"]:
        key = (e["simplified"], norm_py(f["transcriptions"]["numeric"]))
        if lvl:
            hsk_new.setdefault(key, lvl)
            hsk_new.setdefault((e["simplified"], None), lvl)
        if old:
            hsk_old.setdefault(key, old[0])
            hsk_old.setdefault((e["simplified"], None), old[0])

# ---------------------------------------------------------------- jieba frequency
freq = {}
for line in open(os.path.join(raw, "jieba_big.txt"), encoding="utf-8"):
    parts = line.split()
    if len(parts) >= 2:
        w, f = parts[0], int(parts[1])
        if f > freq.get(w, 0):
            freq[w] = f

# ---------------------------------------------------------------- merge words
exact_new = {s for e in entries for s in [e["s"]] if (s, norm_py(e["p"])) in hsk_new}
exact_old = {s for e in entries for s in [e["s"]] if (s, norm_py(e["p"])) in hsk_old}
rows = []
for e in entries:
    t, s, p = e["t"], e["s"], e["p"]
    np_ = norm_py(p)
    f = max(freq.get(s, 0), freq.get(t, 0))
    hn = hsk_new.get((s, np_)) or ""
    ho = hsk_old.get((s, np_)) or ""
    # Only fall back to word-level HSK when pinyin is unambiguous lower-case (not a name)
    if not hn and p[:1].islower() and s not in exact_new:
        hn = hsk_new.get((s, None)) or ""
    if not ho and p[:1].islower() and s not in exact_old:
        ho = hsk_old.get((s, None)) or ""
    jy = canto.get((t, s, np_), "")
    defs = "/".join(d.replace("\t", " ") for d in e["d"])
    rows.append("\t".join([t, s, p, defs, str(f) if f else "", str(hn), str(ho), jy]))

with open(os.path.join(data_dir, "words.js"), "w", encoding="utf-8") as fh:
    fh.write("window.HL_WORDS=" + js_string("\n".join(rows)) + ";\n")
print("words.js", os.path.getsize(os.path.join(data_dir, "words.js")) // 1024, "KB")

# ---------------------------------------------------------------- characters
chars = defaultdict(dict)
wanted = set()
for e in entries:
    wanted.update(c for c in e["t"] + e["s"] if "㐀" <= c <= "鿿" or "\U00020000" <= c <= "\U0002ffff")


def unihan(fname, fields):
    for line in open(os.path.join(raw, "unihan", fname), encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        cp, field, value = line.rstrip("\n").split("\t", 2)
        if field in fields:
            c = chr(int(cp[2:], 16))
            if c in wanted:
                yield c, field, value


for c, field, v in unihan("Unihan_Readings.txt", {"kDefinition", "kMandarin", "kCantonese"}):
    chars[c][{"kDefinition": "ud", "kMandarin": "um", "kCantonese": "uc"}[field]] = v
for c, field, v in unihan("Unihan_IRGSources.txt", {"kTotalStrokes", "kRSUnicode"}):
    if field == "kTotalStrokes":
        chars[c]["n"] = int(v.split()[0])
    else:
        chars[c]["rs"] = v.split()[0]


def var_list(v):
    return "".join(chr(int(x.split("<")[0][2:], 16)) for x in v.split())


for c, field, v in unihan("Unihan_Variants.txt", {"kTraditionalVariant", "kSimplifiedVariant"}):
    vs = var_list(v).replace(c, "")
    if vs:
        chars[c]["tv" if field == "kTraditionalVariant" else "sv"] = vs

for line in open(os.path.join(raw, "mmah_dictionary.txt"), encoding="utf-8"):
    d = json.loads(line)
    c = d["character"]
    rec = chars[c]
    if d.get("definition"):
        rec["md"] = d["definition"]
    if d.get("decomposition") and d["decomposition"] != "？":
        rec["dc"] = d["decomposition"]
    if d.get("radical"):
        rec["r"] = d["radical"]
    et = d.get("etymology")
    if et:
        rec["e"] = {k: v for k, v in et.items() if v}

# Character-level frequency from jieba (single-char words) for sorting.
for c, rec in chars.items():
    if freq.get(c):
        rec["f"] = freq[c]

with open(os.path.join(data_dir, "chars.js"), "w", encoding="utf-8") as fh:
    fh.write("window.HL_CHARS=" + json.dumps(chars, ensure_ascii=False, separators=(",", ":")) + ";\n")
print("chars.js", len(chars), os.path.getsize(os.path.join(data_dir, "chars.js")) // 1024, "KB")

# ---------------------------------------------------------------- stroke order
n = 0
for path in glob.glob(os.path.join(raw, "hwd", "package", "*.json")):
    c = os.path.basename(path)[:-5]
    if len(c) != 1:
        continue
    d = json.load(open(path, encoding="utf-8"))
    payload = {"s": d["strokes"], "m": d["medians"], "r": d.get("radStrokes", [])}
    with open(os.path.join(stroke_dir, "%x.js" % ord(c)), "w", encoding="utf-8") as fh:
        fh.write("HL_strokeLoaded(%s,%s);" % (js_string(c), json.dumps(payload, separators=(",", ":"))))
    n += 1
print("stroke files", n)

# ---------------------------------------------------------------- Tatoeba examples
cmn = {}
for line in open(os.path.join(raw, "cmn_sentences.tsv"), encoding="utf-8"):
    i, _, s = line.rstrip("\n").split("\t", 2)
    if len(s) <= 36:
        cmn[i] = s
links = defaultdict(list)
for line in open(os.path.join(raw, "cmn-eng_links.tsv"), encoding="utf-8"):
    a, b = line.split()
    if a in cmn:
        links[a].append(b)
need = {b for bs in links.values() for b in bs}
eng = {}
for line in open(os.path.join(raw, "eng_sentences.tsv"), encoding="utf-8"):
    i, _, s = line.rstrip("\n").split("\t", 2)
    if i in need:
        eng[i] = s
pairs, seen = [], set()
for i, s in cmn.items():
    ens = [eng[b] for b in links.get(i, []) if b in eng]
    if not ens or s in seen:
        continue
    seen.add(s)
    pairs.append(s.replace("\t", " ") + "\t" + min(ens, key=len).replace("\t", " "))
pairs.sort(key=len)
with open(os.path.join(data_dir, "examples.js"), "w", encoding="utf-8") as fh:
    fh.write("window.HL_EXAMPLES=" + js_string("\n".join(pairs)) + ";\n")
print("examples", len(pairs), os.path.getsize(os.path.join(data_dir, "examples.js")) // 1024, "KB")
