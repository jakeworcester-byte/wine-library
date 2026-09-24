(function () {
  "use strict";

  var YEAR = new Date().getFullYear();
  var SCALE_START = 2024;
  var SCALE_END = 2050;
  var OCCASION_LABELS = {
    "Steak Saturday": "Steak Saturday",
    "Special Occasion": "Special Occasion",
    "Tuesday Night": "Tuesday Night",
    "Bridge / Pre-Dinner": "Pre-Dinner",
    "Exploratory": "Exploratory"
  };

  var state = { q: "", ready: "all", occasion: null, sort: "producer" };
  var wines = [];
  var byId = {};

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function range(text) {
    if (!text) return null;
    var m = String(text).match(/(now|\d{4})\s*-\s*(\d{4})/i);
    if (!m) return null;
    return [m[1].toLowerCase() === "now" ? YEAR : +m[1], +m[2]];
  }

  function readiness(w) {
    var win = range(w.window);
    var pk = range(w.peak);
    if (!win) return { cls: "ready", label: "Ready to drink", open: true };
    if (win[0] > YEAR) return { cls: "hold", label: "Hold until " + win[0], open: false };
    if (YEAR > win[1]) return { cls: "late", label: "Drink soon", open: true };
    if (pk) {
      if (YEAR >= pk[0] && YEAR <= pk[1]) return { cls: "peak", label: "At its peak", open: true };
      if (YEAR < pk[0]) return { cls: "ready", label: "Ready, peaks " + pk[0], open: true };
      return { cls: "late", label: "Past peak, drink soon", open: true };
    }
    return { cls: "ready", label: "Ready to drink", open: true };
  }

  function scoreValue(s) {
    if (!s) return -1;
    var nums = String(s).match(/\d+/g);
    return nums ? Math.max.apply(null, nums.map(Number)) : -1;
  }

  function vintageValue(v) {
    var m = String(v).match(/^\d{4}/);
    return m ? +m[0] : 9999;
  }

  function placeholder(color) {
    var fill = color === "white" ? "#d8c98f" : "#5a1a26";
    return '<svg class="ph" viewBox="0 0 40 140" aria-hidden="true">' +
      '<path d="M15 2h10v30c0 6 11 12 11 26v76a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V58c0-14 11-20 11-26z" fill="' + fill + '"/>' +
      '<rect x="7" y="72" width="26" height="30" rx="2" fill="#f6f1ea" opacity=".9"/></svg>';
  }

  function bottle(w, withCount) {
    var img = w.image
      ? '<img src="' + esc(w.image) + '" alt="Bottle of ' + esc(w.producer + " " + w.name) + '" loading="lazy">'
      : placeholder(w.color);
    var count = withCount ? '<span class="count">' + w.onHand + (w.onHand === 1 ? " bottle" : " bottles") + "</span>" : "";
    return '<div class="bottle">' + img + count + "</div>";
  }

  function refLine(w) {
    if (!w.otherScores || !w.otherScores.length) return "";
    var parts = w.otherScores.map(function (o) { return "the " + esc(o.vintage) + " at <b>" + esc(o.score) + "</b>"; });
    var list = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
    return "Not yet scored. Jake rated " + list + ".";
  }

  function card(w) {
    var r = readiness(w);
    var score = w.jakeScore
      ? '<span class="seal"><small>Jake</small><span>' + esc(w.jakeScore) + "</span></span>"
      : "";
    var ref = !w.jakeScore && w.otherScores && w.otherScores.length ? '<span class="ref">' + refLine(w) + "</span>" : "";
    var notesHint = w.jakeNote ? '<span class="has-notes">Jake\'s Notes</span>' : "";
    var occ = w.category ? '<span class="tag">' + esc(OCCASION_LABELS[w.category] || w.category) + "</span>" : "";
    return '<button class="card" type="button" data-id="' + esc(w.id) + '">' +
      bottle(w, true) +
      '<div class="info">' +
        '<span class="producer">' + esc(w.producer) + "</span>" +
        '<h2 class="title">' + esc(w.name) + "</h2>" +
        '<span class="vintage">' + esc(w.vintage) + "</span>" +
        '<span class="region">' + esc(w.region) + "</span>" +
        '<div class="meta"><span class="pill ' + r.cls + '">' + esc(r.label) + "</span>" + occ + "</div>" +
        ((score || ref || notesHint) ? '<div class="score-row">' + score + ref + (score ? notesHint : "") + "</div>" : "") +
      "</div></button>";
  }

  function matches(w) {
    if (state.occasion && w.category !== state.occasion) return false;
    if (state.ready !== "all") {
      var open = readiness(w).open;
      if (state.ready === "ready" && !open) return false;
      if (state.ready === "hold" && open) return false;
    }
    if (state.q) {
      var hay = [w.producer, w.name, w.vintage, w.region, w.category, w.blend].join(" ").toLowerCase();
      var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  function sorter(a, b) {
    var byProducer = (a.producer + a.name).localeCompare(b.producer + b.name) || vintageValue(a.vintage) - vintageValue(b.vintage);
    switch (state.sort) {
      case "score": return scoreValue(b.jakeScore) - scoreValue(a.jakeScore) || byProducer;
      case "vintage": return vintageValue(a.vintage) - vintageValue(b.vintage) || byProducer;
      case "bottles": return b.onHand - a.onHand || byProducer;
      case "ready":
        var ra = range(a.window) || [YEAR, YEAR], rb = range(b.window) || [YEAR, YEAR];
        return Math.max(ra[0], YEAR) - Math.max(rb[0], YEAR) || ra[1] - rb[1] || byProducer;
      default: return byProducer;
    }
  }

  function render() {
    var list = wines.filter(matches).sort(sorter);
    $("grid").innerHTML = list.map(card).join("");
    $("empty").hidden = list.length > 0;
  }

  function renderStats() {
    var bottles = 0, ready = 0;
    wines.forEach(function (w) {
      bottles += w.onHand;
      if (readiness(w).open) ready += w.onHand;
    });
    $("stats").innerHTML = "<b>" + wines.length + "</b> wines &middot; <b>" + bottles + "</b> bottles &middot; <b>" + ready + "</b> ready to open now";
  }

  function renderChips() {
    var present = {};
    wines.forEach(function (w) { if (w.category) present[w.category] = (present[w.category] || 0) + w.onHand; });
    var order = ["Steak Saturday", "Special Occasion", "Tuesday Night", "Bridge / Pre-Dinner", "Exploratory"];
    var html = '<button type="button" class="chip" data-occ="" aria-pressed="true">All occasions</button>';
    order.forEach(function (c) {
      if (present[c]) html += '<button type="button" class="chip" data-occ="' + esc(c) + '" aria-pressed="false">' + esc(OCCASION_LABELS[c]) + "</button>";
    });
    $("chips").innerHTML = html;
  }

  function timeline(w) {
    var win = range(w.window);
    if (!win) return "";
    var pk = range(w.peak);
    var span = SCALE_END - SCALE_START;
    var pos = function (y) { return Math.max(0, Math.min(100, ((y - SCALE_START) / span) * 100)); };
    var bar = function (cls, r) {
      return '<span class="' + cls + '" style="left:' + pos(r[0]) + "%;width:" + Math.max(1.5, pos(r[1] + 1) - pos(r[0])) + '%"></span>';
    };
    var windowText = w.window.replace(/^now/i, "Now");
    return '<section class="timeline"><h3>Drinking window</h3>' +
      '<div class="track"><span class="rail"></span>' + bar("win", win) + (pk ? bar("pk", pk) : "") +
      '<span class="now" style="left:' + pos(YEAR + (new Date().getMonth() / 12)) + '%"></span></div>' +
      '<div class="scale"><span>' + SCALE_START + "</span><span>" + (SCALE_START + span / 2) + "</span><span>" + SCALE_END + "</span></div>" +
      '<div class="legend"><span><i style="background:color-mix(in srgb, var(--wine) 35%, transparent)"></i>Window ' + esc(windowText) + "</span>" +
      (pk ? '<span><i style="background:var(--wine)"></i>Peak ' + esc(w.peak.replace(/^now/i, "Now")) + "</span>" : "") +
      "</div></section>";
  }

  function detail(w) {
    var r = readiness(w);
    var facts = [
      ["Bottles", w.onHand],
      ["Occasion", w.category ? (OCCASION_LABELS[w.category] || w.category) : null],
      ["Blend", w.blend],
      ["Window", w.window ? w.window.replace(/^now/i, "Now") : null]
    ].filter(function (f) { return f[1] != null && f[1] !== ""; })
     .map(function (f) { return '<div class="fact"><dt>' + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd></div>"; }).join("");

    var notes = "";
    if (w.jakeNote) {
      notes += '<div class="note jake"><div class="label"><span class="mono">jw</span><strong>Jake\'s Notes</strong>' +
        (w.jakeScore ? '<span class="critic">Jake Score ' + esc(w.jakeScore) + "</span>" : "") +
        "</div><p>" + esc(w.jakeNote) + "</p></div>";
    }
    if (w.web && w.web.note) {
      var sameVintage = !w.web.noteVintage || String(w.web.noteVintage) === String(w.vintage);
      var who = w.web.critic && w.web.critic.critic ? '<span class="critic">' + esc(w.web.critic.critic) + " " + esc(w.web.critic.score) + "</span>" : "";
      notes += '<div class="note"><div class="label"><strong>Tasting notes</strong>' + who + "</div>" +
        "<p>" + esc(w.web.note) + "</p>" +
        '<div class="src">Summarized from ' +
        (w.web.sourceUrl ? '<a href="' + esc(w.web.sourceUrl) + '" target="_blank" rel="noopener">' + esc(w.web.sourceName || "source") + "</a>" : esc(w.web.sourceName || "published notes")) +
        (sameVintage ? "" : ", describing the " + esc(w.web.noteVintage) + " vintage") + ".</div></div>";
    }

    var scoreBlock = "";
    if (w.jakeScore && !w.jakeNote) {
      scoreBlock = '<span class="seal"><small>Jake</small><span>' + esc(w.jakeScore) + "</span></span>";
    } else if (!w.jakeScore && w.otherScores && w.otherScores.length) {
      scoreBlock = '<span class="ref">' + refLine(w) + "</span>";
    }

    var tags = (w.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("");
    return '<button class="close" type="button" aria-label="Close">&times;</button>' +
      '<div class="d-head">' + bottle(w, false) +
        '<div class="info">' +
          '<span class="producer">' + esc(w.producer) + "</span>" +
          '<h2 class="title" id="d-title">' + esc(w.name) + "</h2>" +
          '<span class="vintage">' + esc(w.vintage) + "</span>" +
          '<span class="region">' + esc(w.region) + "</span>" +
          '<div class="meta"><span class="pill ' + r.cls + '">' + esc(r.label) + "</span>" + tags + "</div>" +
          (w.flag ? '<div><span class="flag">' + esc(w.flag) + "</span></div>" : "") +
          (scoreBlock ? '<div class="score-row">' + scoreBlock + "</div>" : "") +
        "</div></div>" +
      '<div class="d-body">' +
        (w.about ? '<p class="about">' + esc(w.about) + "</p>" : "") +
        '<dl class="facts">' + facts + "</dl>" +
        timeline(w) +
        (notes ? '<section class="notes">' + notes + "</section>" : "") +
      "</div>";
  }

  function open(id, push) {
    var w = byId[id];
    if (!w) return;
    $("sheet").innerHTML = detail(w);
    var dlg = $("detail");
    if (!dlg.open) dlg.showModal();
    $("sheet").scrollTop = 0;
    if (push) history.replaceState(null, "", "#" + id);
  }

  function close() {
    var dlg = $("detail");
    if (dlg.open) dlg.close();
  }

  function bind() {
    $("q").addEventListener("input", function (e) { state.q = e.target.value.trim(); render(); });
    $("sort").addEventListener("change", function (e) { state.sort = e.target.value; render(); });
    document.querySelector(".seg").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-ready]");
      if (!b) return;
      state.ready = b.getAttribute("data-ready");
      this.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      render();
    });
    $("chips").addEventListener("click", function (e) {
      var b = e.target.closest(".chip");
      if (!b) return;
      state.occasion = b.getAttribute("data-occ") || null;
      this.querySelectorAll(".chip").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      render();
    });
    $("grid").addEventListener("click", function (e) {
      var c = e.target.closest(".card");
      if (c) open(c.getAttribute("data-id"), true);
    });
    var dlg = $("detail");
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg || e.target.closest(".close")) close();
    });
    dlg.addEventListener("close", function () {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    });
  }

  fetch("wines.json", { cache: "no-cache" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      wines = data.wines;
      wines.forEach(function (w) { byId[w.id] = w; });
      var d = new Date(data.updated + "T12:00:00");
      $("updated").textContent = "Cellar last synced " + d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) + ".";
      renderStats();
      renderChips();
      bind();
      render();
      var hash = location.hash.slice(1);
      if (hash && byId[hash]) open(hash, false);
    })
    .catch(function () {
      $("grid").innerHTML = '<p class="empty">Could not load the cellar list. Try refreshing.</p>';
    });
})();
