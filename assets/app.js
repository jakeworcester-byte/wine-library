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

  var state = { q: "", ready: "all", occasion: null, sort: "producer", view: "list", slot: null, pick: null };
  var wines = [];
  var byId = {};
  var rack = null;
  var SLOT = /^[A-Z][1-9]$/;
  var SPOT_NAMES = { UP: "Upstairs rack", FR: "Wine fridge" };
  // What each basement row is for, bottom up. Rows added later have no tier.
  var ROW_TIERS = { A: "hold", B: "hold", C: "early", D: "early", E: "now", F: "now" };

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

  // Where a wine sits, in reading order: [{name: "Basement rack", slots: [...]}, {name: "Wine fridge"}].
  function where(w) {
    var parts = [], basement = null;
    (w.locations || []).forEach(function (t) {
      if (SLOT.test(t)) {
        if (!basement) { basement = { name: "Basement rack", slots: [] }; parts.push(basement); }
        basement.slots.push(t);
      } else if (SPOT_NAMES[t] && !parts.some(function (p) { return p.name === SPOT_NAMES[t]; })) {
        parts.push({ name: SPOT_NAMES[t] });
      }
    });
    return parts;
  }

  function whereText(w) {
    return where(w).map(function (p) { return p.slots ? p.name + ": " + p.slots.join(", ") : p.name; }).join(" · ");
  }

  // Readiness as a rack tier, from the drink window rather than the shelf it sits on.
  function tone(w) {
    var win = range(w.window), pk = range(w.peak);
    if (win && win[0] > YEAR) return "hold";
    if (win && YEAR > win[1]) return "late";
    if (pk && YEAR < pk[0]) return "early";
    return "now";
  }

  function shortVintage(v) {
    var m = String(v).match(/^\d{2}(\d{2})$/);
    return m ? "’" + m[1] : (/^NV/i.test(v) ? "NV" : String(v));
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

  var PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>';

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
        (whereText(w) ? '<span class="loc">' + PIN + esc(whereText(w)) + "</span>" : "") +
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
      var hay = [w.producer, w.name, w.vintage, w.region, w.category, w.blend, whereText(w)].join(" ").toLowerCase();
      var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i].toUpperCase();
        // A slot code like "C4" matches only the wine in that slot.
        if (SLOT.test(t) ? (w.locations || []).indexOf(t) === -1 : hay.indexOf(terms[i]) === -1) return false;
      }
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
    if (state.view === "rack") return renderRack();
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
      ["Blend", w.blend]
    ].filter(function (f) { return f[1] != null && f[1] !== ""; })
     .map(function (f) {
       var wide = String(f[1]).length > 36 ? " wide" : "";
       return '<div class="fact' + wide + '"><dt>' + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd></div>";
     }).join("");

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

    var loc = where(w).map(function (p) {
      if (!p.slots) return '<span class="loc-part">' + esc(p.name) + "</span>";
      return '<span class="loc-part">' + esc(p.name) + ": " + p.slots.map(function (s) {
        return '<button type="button" class="slot-link" data-slot="' + s + '" aria-label="Show ' + s + ' on the rack map">' + s + "</button>";
      }).join(" ") + "</span>";
    }).join("");
    if (loc) facts = '<div class="fact wide loc-fact"><dt>Location</dt><dd>' + loc + "</dd></div>" + facts;

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

  /* Rack map: the basement grid as it looks standing in front of it (row A at
     the bottom, column 1 on the left), plus the upstairs rack and fridge as lists. */

  var TONES = [
    ["hold", "Cellaring"],
    ["early", "Ready, still climbing"],
    ["now", "Ready now"],
    ["late", "Drink soon"]
  ];
  var TIER_NAMES = { hold: "Long holds", early: "Open early, keep backups", now: "Ready now" };

  function slotCell(code, w, span) {
    if (!w) return '<span class="slot empty" data-slot="' + code + '" aria-label="' + code + ', empty"></span>';
    var cls = "slot tone-" + tone(w) + (span > 1 ? " group" : "") +
      (w.id === state.pick ? " sel" : "") + (covers(code, span, state.slot) ? " hit" : "") +
      (matches(w) ? "" : " dim");
    var label = "<b>" + esc(shortVintage(w.vintage)) + (span > 1 ? "<i>&times;" + span + "</i>" : "") + "</b>" +
      "<span>" + esc(w.short) + "</span>";
    var aria = code + (span > 1 ? " to " + code[0] + (+code[1] + span - 1) : "") + ": " + w.producer + " " + w.name + " " + w.vintage;
    return '<button type="button" class="' + cls + '" data-slot="' + code + '" data-id="' + esc(w.id) + '"' +
      (span > 1 ? ' style="grid-column: span ' + span + '"' : "") + ' aria-label="' + esc(aria) + '">' + label + "</button>";
  }

  function covers(start, span, code) {
    return code && code[0] === start[0] && +code[1] >= +start[1] && +code[1] < +start[1] + span;
  }

  function rackGrid() {
    if (!rack.rows) return "";
    var rows = "";
    for (var r = rack.rows - 1; r >= 0; r--) {
      var letter = String.fromCharCode(65 + r);
      var tier = ROW_TIERS[letter];
      var cells = "";
      for (var c = 1; c <= rack.cols; c++) {
        var id = rack.slots[letter + c];
        var span = 1;
        // Neighbors holding the same wine read as one group.
        while (id && c + span <= rack.cols && rack.slots[letter + (c + span)] === id) span++;
        cells += slotCell(letter + c, byId[id], span);
        c += span - 1;
      }
      rows += '<div class="rack-row"><span class="rl' + (tier ? " tier-" + tier : "") + '"' +
        (tier ? ' title="' + TIER_NAMES[tier] + '"' : "") + ">" + letter + "</span>" +
        '<div class="cells">' + cells + "</div></div>";
    }
    var cols = "";
    for (var n = 1; n <= rack.cols; n++) cols += "<span>" + n + "</span>";
    var filled = Object.keys(rack.slots).length, total = rack.rows * rack.cols;
    return '<div class="rack-scroll"><div class="rack" style="--cols:' + rack.cols + '">' + rows +
      '<div class="rack-row rack-cols"><span class="rl"></span><div class="cells">' + cols + "</div></div></div></div>" +
      '<p class="rack-count">' + filled + " of " + total + " slots filled" + (total - filled ? ", " + (total - filled) + " open" : "") + ".</p>";
  }

  function rackLegend() {
    var used = {};
    Object.keys(rack.slots).forEach(function (s) { var w = byId[rack.slots[s]]; if (w) used[tone(w)] = true; });
    var tones = TONES.filter(function (t) { return used[t[0]]; }).map(function (t) {
      return '<span><i class="sw tone-' + t[0] + '"></i>' + t[1] + "</span>";
    }).join("");
    return '<div class="rack-legend">' + tones + "</div>" +
      '<p class="rack-key">Colors show each bottle\'s readiness. The stripe by each row letter shows what that shelf holds: ' +
      '<span class="key-tier tier-hold"></span>long holds, <span class="key-tier tier-early"></span>open early, keep backups, ' +
      '<span class="key-tier tier-now"></span>ready now.</p>';
  }

  function spotList(title, list) {
    if (!list || !list.length) return "";
    var items = list.map(function (x) { return byId[x.id] ? x : null; }).filter(Boolean)
      .sort(function (a, b) { return sorter(byId[a.id], byId[b.id]); })
      .map(function (x) {
        var w = byId[x.id];
        return '<li><button type="button" class="spot-wine' + (matches(w) ? "" : " dim") + '" data-id="' + esc(w.id) + '">' +
          '<span class="sw tone-' + tone(w) + '"></span>' +
          '<span class="sw-name">' + esc(w.producer) + " " + esc(w.name) + "</span>" +
          '<span class="sw-vin">' + esc(w.vintage) + (x.n > 1 ? " &times;" + x.n : "") + "</span></button></li>";
      }).join("");
    return '<section class="spot"><h3>' + title + "</h3><ul>" + items + "</ul></section>";
  }

  function rackInfo() {
    var w = state.pick && byId[state.pick];
    if (!w) return '<p class="rack-hint">' + (rack.rows ? "Tap a bottle to see what it is." : "") + "</p>";
    var r = readiness(w);
    var win = w.window ? w.window.replace(/^now/i, "Now") + (w.peak ? ", peak " + w.peak.replace(/^now/i, "Now") : "") : null;
    return '<div class="ri-head"><div><span class="producer">' + esc(w.producer) + "</span>" +
      '<h3 class="title">' + esc(w.name) + ' <span class="vintage">' + esc(w.vintage) + "</span></h3></div>" +
      '<button type="button" class="ri-open" data-id="' + esc(w.id) + '">Full entry</button></div>' +
      '<div class="meta"><span class="pill ' + r.cls + '">' + esc(r.label) + "</span>" +
      (w.category ? '<span class="tag">' + esc(OCCASION_LABELS[w.category] || w.category) + "</span>" : "") + "</div>" +
      '<dl class="ri-facts">' +
      (win ? "<div><dt>Drink window</dt><dd>" + esc(win) + "</dd></div>" : "") +
      "<div><dt>Location</dt><dd>" + esc(whereText(w)) + "</dd></div></dl>";
  }

  function renderRack() {
    if (!rack) return;
    $("rackView").innerHTML = '<div class="rack-layout"><div class="rack-main">' +
      (rack.rows ? '<div class="rack-head"><h2>Basement rack</h2><p>Row A is the bottom shelf; column 1 is on the left.</p></div>' +
        rackGrid() + rackLegend() : "") +
      '<div class="rack-info" id="rackInfo" aria-live="polite">' + rackInfo() + "</div></div>" +
      '<div class="rack-side">' + spotList("Upstairs rack", rack.upstairs) + spotList("Wine fridge", rack.fridge) + "</div></div>";
    fitLabels();
  }

  // Narrow cells: shrink a name until its longest word fits, and only break words as a last resort.
  function fitLabels() {
    $("rackView").querySelectorAll(".slot span").forEach(function (s) {
      s.style.fontSize = "";
      s.classList.remove("squeeze");
      for (var px = 9; s.scrollWidth > s.clientWidth + 0.5 && px >= 7.5; px -= 0.5) s.style.fontSize = px + "px";
      if (s.scrollWidth > s.clientWidth + 0.5) s.classList.add("squeeze");
    });
  }

  function setView(view, slot) {
    if (!rack) view = "list";
    state.view = view;
    if (slot !== undefined) {
      state.slot = slot;
      state.pick = slot ? rack.slots[slot] || null : null;
    }
    document.body.classList.toggle("rack-mode", view === "rack");
    $("views").querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
    });
    $("grid").hidden = view === "rack";
    $("rackView").hidden = view !== "rack";
    $("sortWrap").hidden = view === "rack";
    if (view === "rack") { $("empty").hidden = true; renderRack(); } else render();
  }

  function showSlot(code) {
    close();
    setView("rack", code);
    history.replaceState(null, "", "#rack-" + code);
    var cell = $("rackView").querySelector(".slot.hit");
    if (cell) cell.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }

  function pickInRack(id, slot) {
    state.pick = id;
    state.slot = slot;
    renderRack();
    history.replaceState(null, "", "#rack-" + slot);
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
      var s = e.target.closest(".slot-link");
      if (s) return showSlot(s.getAttribute("data-slot"));
      if (e.target === dlg || e.target.closest(".close")) close();
    });
    dlg.addEventListener("close", function () {
      var back = state.view === "rack" ? "#rack" + (state.slot ? "-" + state.slot : "") : "";
      if (location.hash !== back) history.replaceState(null, "", back || location.pathname + location.search);
    });
    $("views").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-view]");
      if (!b) return;
      setView(b.getAttribute("data-view"), null);
      history.replaceState(null, "", state.view === "rack" ? "#rack" : location.pathname + location.search);
    });
    var refit;
    window.addEventListener("resize", function () {
      clearTimeout(refit);
      refit = setTimeout(function () { if (state.view === "rack") fitLabels(); }, 150);
    });
    // Label widths change once the web font arrives.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (state.view === "rack") fitLabels(); });
    $("rackView").addEventListener("click", function (e) {
      var s = e.target.closest(".slot[data-id]");
      if (s) return pickInRack(s.getAttribute("data-id"), s.getAttribute("data-slot"));
      var o = e.target.closest(".ri-open, .spot-wine");
      if (o) open(o.getAttribute("data-id"), true);
    });
  }

  fetch("wines.json", { cache: "no-cache" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      wines = data.wines;
      wines.forEach(function (w) { byId[w.id] = w; });
      rack = data.rack || null;
      if (rack) {
        $("views").hidden = false;
        $("q").placeholder = "Search wine, producer, region, slot";
      }
      window.WineLibrary = { byId: byId, open: function (id) { open(id, true); } };
      var d = new Date(data.updated + "T12:00:00");
      $("updated").textContent = "Cellar last synced " + d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) + ".";
      renderStats();
      renderChips();
      bind();
      render();
      var hash = location.hash.slice(1);
      var toRack = hash.match(/^rack(?:-([A-Z][1-9]))?$/);
      if (toRack && rack) {
        setView("rack", toRack[1] || null);
        if (toRack[1]) showSlot(toRack[1]);
      } else if (hash && byId[hash]) open(hash, false);
    })
    .catch(function () {
      $("grid").innerHTML = '<p class="empty">Could not load the cellar list. Try refreshing.</p>';
    });
})();
