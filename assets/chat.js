(function () {
  "use strict";

  var STORE_KEY = "wine-chat-v1";
  var STARTERS = [
    "We're grilling ribeyes for six. What should I open?",
    "Something to pour before dinner?",
    "I like Jake's taste. What should I buy?",
    "I'm at the store with $30. What should I grab?",
    "I love Caymus. What else would I like?"
  ];
  var SEARCH_MARK = /\u001e/g;   // sent by the relay when Claude starts a web search

  var history = [];      // [{role, content}] sent to the relay
  var busy = false;
  var returnToChat = false;

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Random id for this chat so the anonymous question log can group follow-ups.
  // Not tied to the person; "New chat" makes a fresh one.
  var chatId = newChatId();

  function newChatId() {
    var bytes = new Uint8Array(10);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return (b % 36).toString(36); }).join("") +
      Date.now().toString(36).slice(-6);
  }

  function save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(history));
      sessionStorage.setItem(STORE_KEY + "-id", chatId);
    } catch (e) { /* private mode */ }
  }

  function load() {
    try {
      var h = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]");
      if (Array.isArray(h)) history = h;
      var id = sessionStorage.getItem(STORE_KEY + "-id");
      if (id && history.length) chatId = id;
    } catch (e) { history = []; }
  }

  function wineName(id) {
    var lib = window.WineLibrary;
    var w = lib && lib.byId[id];
    return w ? w.producer + " " + w.name + " " + w.vintage : null;
  }

  // Raw relay text -> what the guest reads. Anything written before the last
  // web search is working chatter ("let me check"), so only the text after the
  // last search marker is shown. Spaced em/en dashes become commas as a backstop.
  function visible(raw) {
    var i = raw.lastIndexOf("\u001e");
    var text = i >= 0 ? raw.slice(i + 1) : raw;
    return text.replace(SEARCH_MARK, "").replace(/\s[\u2013\u2014]\s/g, ", ").replace(/^\s+/, "");
  }

  // Assistant text -> safe HTML. [[wine-id]] becomes a link to that bottle and
  // {{Wine name}} marks a wine outside the cellar; half-streamed markers at
  // the end are hidden until they complete.
  function render(text, streaming) {
    if (streaming) text = text.replace(/\[\[[^\]]*\]?$/, "").replace(/\{\{[^}]*\}?$/, "");
    var html = esc(text)
      .replace(/\[\[([a-z0-9-]+)\]\]/g, function (m, id) {
        var name = wineName(id);
        return name ? '<a href="#' + id + '" class="wine-link" data-id="' + id + '">' + esc(name) + "</a>" : "";
      })
      .replace(/\{\{([^{}]+)\}\}/g, '<span class="ext-wine">$1</span>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return html.split(/\n{2,}/).map(function (p) {
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  function bubble(role, html, extra) {
    var div = document.createElement("div");
    div.className = "msg " + role + (extra ? " " + extra : "");
    div.innerHTML = html;
    $("askLog").appendChild(div);
    scroll();
    return div;
  }

  function scroll() {
    var log = $("askLog");
    log.scrollTop = log.scrollHeight;
  }

  function drawAll() {
    $("askLog").innerHTML = "";
    if (!history.length) {
      var intro = bubble("assistant", render("Hey! Tell me what you're eating and I'll point you to a bottle from the cellar. Shopping instead? Tell me what you like and I'll find you something to try."));
      intro.classList.add("intro");
      var chips = document.createElement("div");
      chips.className = "starters";
      chips.innerHTML = STARTERS.map(function (s) {
        return '<button type="button" class="starter">' + esc(s) + "</button>";
      }).join("");
      $("askLog").appendChild(chips);
      return;
    }
    history.forEach(function (m) {
      bubble(m.role, m.role === "user" ? "<p>" + esc(m.content) + "</p>" : render(m.content));
    });
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    var url = window.WINE_CHAT_URL;
    if (!url) return;
    if (!history.length) $("askLog").innerHTML = "";
    busy = true;
    $("askSend").disabled = true;
    $("askInput").value = "";
    history.push({ role: "user", content: text });
    bubble("user", "<p>" + esc(text) + "</p>");
    var out = bubble("assistant", '<p class="typing"><span></span><span></span><span></span></p>', "pending");

    var answer = "";
    try {
      var res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-12), convo: chatId })
      });
      if (!res.ok || !res.body) {
        var msg = res.ok ? "Something went sideways. Try again." : await res.text();
        throw new Error(msg || "Something went sideways. Try again.");
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      out.classList.remove("pending");
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        answer += dec.decode(chunk.value, { stream: true });
        var lastMark = answer.lastIndexOf("\u001e");
        var searching = lastMark >= 0 && !answer.slice(lastMark + 1).trim();
        out.innerHTML = render(visible(answer), true) +
          (searching ? '<p class="status"><span class="typing"><span></span><span></span><span></span></span> Checking the shelves</p>' : "");
        scroll();
      }
      answer = visible(answer).trim();
      if (!answer) throw new Error("Something went sideways. Try again.");
      out.innerHTML = render(answer, false);
      history.push({ role: "assistant", content: answer });
    } catch (err) {
      // Drop the unanswered question so the conversation stays well-formed.
      history.pop();
      out.classList.remove("pending");
      out.classList.add("error");
      // Network failures (TypeError) get a friendly line; the relay's own
      // messages (rate limit, bad request) are already written for guests.
      var friendly = !(err instanceof TypeError) && err && err.message && err.message.length < 200;
      out.innerHTML = "<p>" + esc(friendly ? err.message : "I couldn't reach the cellar just now. Try again in a minute.") + "</p>";
    } finally {
      if (history.length >= 12) history = history.slice(-10);
      save();
      busy = false;
      $("askSend").disabled = false;
      scroll();
    }
  }

  function openChat() {
    var dlg = $("ask");
    if (!dlg.open) dlg.showModal();
    scroll();
    if (window.matchMedia("(min-width: 720px)").matches) $("askInput").focus();
  }

  function init() {
    if (!window.WINE_CHAT_URL) return;
    load();
    $("askOpen").hidden = false;
    $("askOpen").addEventListener("click", function () { drawAll(); openChat(); });
    $("askClose").addEventListener("click", function () { $("ask").close(); });
    $("ask").addEventListener("click", function (e) {
      if (e.target === this) this.close();
      var starter = e.target.closest(".starter");
      if (starter) send(starter.textContent);
      var link = e.target.closest(".wine-link");
      if (link && window.WineLibrary) {
        e.preventDefault();
        returnToChat = true;
        this.close();
        window.WineLibrary.open(link.getAttribute("data-id"));
      }
    });
    $("askForm").addEventListener("submit", function (e) {
      e.preventDefault();
      send($("askInput").value);
    });
    $("askInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(this.value);
      }
    });
    $("askReset").addEventListener("click", function () {
      if (busy) return;
      history = [];
      chatId = newChatId();
      save();
      drawAll();
    });
    $("detail").addEventListener("close", function () {
      if (returnToChat) {
        returnToChat = false;
        openChat();
      }
    });
  }

  init();
})();
