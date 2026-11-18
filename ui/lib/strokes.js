/* Hanzi Lens — stroke-order animation from Make Me a Hanzi / hanzi-writer-data geometry.
 * Each stroke is an outline polygon; we reveal it by drawing a fat line along its median
 * (stroke-dashoffset) clipped to the outline, the way a brush would. */
(function (root) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const cache = new Map();
  const waiting = new Map();
  let uid = 0;

  root.HL_strokeLoaded = function (c, data) {
    cache.set(c, data);
    (waiting.get(c) || []).forEach((r) => r(data));
    waiting.delete(c);
  };

  function load(c) {
    if (cache.has(c)) return Promise.resolve(cache.get(c));
    return new Promise((resolve) => {
      if (waiting.has(c)) { waiting.get(c).push(resolve); return; }
      waiting.set(c, [resolve]);
      const s = document.createElement("script");
      s.src = "strokes/" + c.codePointAt(0).toString(16) + ".js";
      s.onerror = () => { cache.set(c, null); (waiting.get(c) || []).forEach((r) => r(null)); waiting.delete(c); s.remove(); };
      s.onload = () => s.remove();
      document.head.appendChild(s);
    });
  }

  function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function medianPath(pts) {
    // Extend the start backwards a little so the brush fully covers the stroke's head.
    const [a, b] = pts;
    let p = pts;
    if (b) {
      const dx = a[0] - b[0], dy = a[1] - b[1];
      const len = Math.hypot(dx, dy) || 1;
      p = [[a[0] + (dx / len) * 50, a[1] + (dy / len) * 50]].concat(pts);
    }
    return "M" + p.map((q) => q[0] + " " + q[1]).join(" L");
  }

  /**
   * Create a stroke-order widget. Returns {el, play(), ready: Promise<boolean>}.
   * opts: {size, T (time scale fn), radical: bool}
   */
  function widget(c, opts) {
    opts = opts || {};
    const T = opts.T || ((ms) => ms);
    const id = "hlso" + (++uid);
    const svg = el("svg", { viewBox: "0 0 1024 1024", class: "so", role: "img", "aria-label": "Stroke order for " + c });
    // Practice-paper guides (田字格 with diagonals)
    const guide = el("g", { class: "so-guide" });
    guide.appendChild(el("rect", { x: 6, y: 6, width: 1012, height: 1012, rx: 56 }));
    guide.appendChild(el("path", { d: "M512 24V1000M24 512H1000", class: "so-cross" }));
    guide.appendChild(el("path", { d: "M60 60L964 964M964 60L60 964", class: "so-diag" }));
    svg.appendChild(guide);
    const g = el("g", { transform: "translate(0, 900) scale(1, -1)" });
    svg.appendChild(g);

    let data = null;
    let strokes = [];
    let token = 0;

    const ready = load(c).then((d) => {
      data = d;
      if (!d) { svg.classList.add("so-missing"); return false; }
      const defs = el("defs", {});
      g.appendChild(defs);
      const rad = new Set(d.r || []);
      d.s.forEach((path, i) => {
        const bg = el("path", { d: path, class: "so-bg" });
        g.appendChild(bg);
        const cp = el("clipPath", { id: id + "c" + i });
        cp.appendChild(el("path", { d: path }));
        defs.appendChild(cp);
        const line = el("path", {
          d: medianPath(d.m[i]), class: "so-ink" + (opts.radical && rad.has(i) ? " so-rad" : ""),
          "clip-path": "url(#" + id + "c" + i + ")",
        });
        g.appendChild(line);
        strokes.push(line);
      });
      // Measure once in the DOM; lengths are only valid when attached, so defer.
      return true;
    });

    function measure() {
      strokes.forEach((s) => {
        if (s._len) return;
        let len = 0;
        try { len = s.getTotalLength(); } catch (e) { len = 1200; }
        s._len = len + 10;
        s.style.strokeDasharray = s._len + " " + s._len;
      });
    }

    function showAll() {
      measure();
      strokes.forEach((s) => { s.getAnimations().forEach((a) => a.cancel()); s.style.strokeDashoffset = "0"; });
    }

    async function play() {
      if (!data) return;
      const my = ++token;
      measure();
      strokes.forEach((s) => { s.getAnimations().forEach((a) => a.cancel()); s.style.strokeDashoffset = String(s._len); });
      svg.classList.add("so-playing");
      for (const s of strokes) {
        if (my !== token) return;
        const dur = T(Math.min(820, 220 + s._len * 0.55));
        const a = s.animate([{ strokeDashoffset: s._len }, { strokeDashoffset: 0 }],
          { duration: dur, easing: "cubic-bezier(0.42, 0, 0.36, 1)", fill: "forwards" });
        try { await a.finished; } catch (e) { return; }
        s.style.strokeDashoffset = "0";
        a.cancel();
        if (my !== token) return;
        await new Promise((r) => setTimeout(r, T(110)));
      }
      if (my === token) svg.classList.remove("so-playing");
    }

    function stop() { token++; showAll(); svg.classList.remove("so-playing"); }

    return { el: svg, play, stop, showAll, ready, count: () => (data ? data.s.length : 0) };
  }

  root.HLStrokes = { widget, load };
})(window);
