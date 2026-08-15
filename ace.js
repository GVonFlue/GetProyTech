/* =========================================================
   Ace — ProyTech AI front desk (shared widget)
   Load on any page:  <script defer src="/ace.js"></script>
   - If the page has NO existing #aceLauncher, this injects the
     floating launcher + panel and wires any "Talk to Ace" button.
   - Always exposes:  window.Ace.mountInline("elementId")
     to render an inline chat (used under the hero).
   Backend contract (unchanged): POST /api/chat
     body: { messages:[{role,content}], leadCaptured:bool }
     resp: { reply, chips:[..], captured:bool, error? }
   ========================================================= */
(function () {
  "use strict";

  var GREETING =
    "Hey — I'm Ace. Tell me what you do and where deals slip through the cracks, and I'll show you how we'd fix it. What's your business?";
  var GREET_CHIPS = ["I'm a realtor", "I'm a lender", "How does it all work?"];

  /* ---------- one-time styles ---------- */
  function injectStyles() {
    if (document.getElementById("ace-styles")) return;
    var css = `
    .ace-orb{border-radius:50%;background:radial-gradient(circle at 35% 30%,#6d8bff,#3A4AE0);position:relative;flex-shrink:0}
    #aceLauncher{position:fixed;right:20px;bottom:20px;z-index:9998;display:flex;align-items:center;gap:10px;border:none;cursor:pointer;
      background:#181530;color:#fff;font:600 15px/1 Inter,system-ui,sans-serif;padding:13px 18px 13px 14px;border-radius:40px;
      box-shadow:0 20px 44px -18px rgba(24,21,48,.7);transition:transform .25s}
    #aceLauncher:hover{transform:translateY(-3px)}
    #aceLauncher .ace-orb{width:26px;height:26px}
    #aceLauncher .ace-orb::after{content:"";position:absolute;inset:0;border-radius:50%;background:inherit;animation:acePulse 2.4s ease-out infinite}
    @keyframes acePulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.9);opacity:0}}
    #aceLauncher.hide{display:none}
    #acePanel{position:fixed;right:20px;bottom:20px;z-index:9999;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 40px);
      background:#fff;border:1px solid #ECE9E3;border-radius:22px;box-shadow:0 40px 90px -30px rgba(20,22,55,.5);display:none;flex-direction:column;overflow:hidden}
    #acePanel.open{display:flex;animation:aceIn .28s cubic-bezier(.2,.7,.2,1)}
    @keyframes aceIn{from{opacity:0;transform:translateY(24px) scale(.98)}to{opacity:1;transform:none}}
    .ace-card{display:flex;flex-direction:column;overflow:hidden;background:#fff}
    .ace-head{background:#181530;color:#fff;padding:15px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
    .ace-head .ace-orb{width:34px;height:34px}
    .ace-head h4{font:700 16px/1.1 Inter,system-ui,sans-serif;margin:0}
    .ace-sub{font-size:11.5px;color:#B9BAD8;margin-top:2px}
    .ace-status{width:8px;height:8px;border-radius:50%;background:#37e39a;box-shadow:0 0 8px #37e39a;margin-left:auto}
    .ace-x{background:none;border:none;color:#B9BAD8;font-size:15px;cursor:pointer;padding:4px 6px;border-radius:8px;transition:.2s}
    .ace-x:hover{color:#fff;background:rgba(255,255,255,.1)}
    .ace-feed{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px;background:#FBFAF8}
    .ace-msg{max-width:82%;padding:11px 14px;border-radius:16px;font:400 14.5px/1.5 Inter,system-ui,sans-serif;white-space:pre-wrap}
    .ace-msg.bot{align-self:flex-start;background:#fff;border:1px solid #ECE9E3;color:#12142B;border-bottom-left-radius:5px}
    .ace-msg.user{align-self:flex-end;background:#3A4AE0;color:#fff;border-bottom-right-radius:5px}
    .ace-typing{align-self:flex-start;background:#fff;border:1px solid #ECE9E3;border-radius:16px;border-bottom-left-radius:5px;padding:13px 15px;display:flex;gap:4px}
    .ace-typing span{width:7px;height:7px;border-radius:50%;background:#B9BAD8;animation:aceBounce 1.2s infinite}
    .ace-typing span:nth-child(2){animation-delay:.18s}.ace-typing span:nth-child(3){animation-delay:.36s}
    @keyframes aceBounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}
    .ace-captured{align-self:stretch;display:flex;gap:10px;background:rgba(55,227,154,.1);border:1px solid rgba(55,227,154,.4);border-radius:14px;padding:12px 14px;font:400 13.5px/1.5 Inter,system-ui,sans-serif;color:#12142B}
    .ace-chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 10px;background:#FBFAF8}
    .ace-chip{border:1px solid #d7d9ee;background:#fff;color:#3A4AE0;font:600 13px/1 Inter,system-ui,sans-serif;padding:9px 13px;border-radius:30px;cursor:pointer;transition:.2s}
    .ace-chip:hover{background:#3A4AE0;color:#fff;border-color:#3A4AE0}
    .ace-input{display:flex;gap:8px;padding:12px 14px;border-top:1px solid #ECE9E3;background:#fff;flex-shrink:0}
    .ace-input input{flex:1;border:1px solid #ECE9E3;border-radius:30px;padding:12px 16px;font:400 14.5px Inter,system-ui,sans-serif;outline:none;transition:.2s}
    .ace-input input:focus{border-color:#3A4AE0;box-shadow:0 0 0 3px rgba(58,74,224,.12)}
    .ace-send{border:none;background:#FF4D14;color:#fff;width:44px;height:44px;border-radius:50%;font-size:17px;cursor:pointer;flex-shrink:0;transition:.2s}
    .ace-send:hover{transform:translateY(-2px)}
    .ace-send:disabled{opacity:.5;cursor:wait}
    /* inline mode */
    .ace-inline{border:1px solid #ECE9E3;border-radius:22px;overflow:hidden;box-shadow:0 34px 80px -36px rgba(20,22,55,.34);height:520px;display:flex;flex-direction:column;background:#fff}
    .ace-inline .ace-feed{min-height:0}
    @media(max-width:520px){
      #acePanel{right:8px;bottom:8px;left:8px;width:auto;height:calc(100vh - 16px);max-height:none}
      #aceLauncher{right:14px;bottom:14px}
      #aceLauncher .ace-orb::after{animation:none}
      #acePanel.open{animation:none}
      .ace-inline{height:460px}
    }`;
    var st = document.createElement("style");
    st.id = "ace-styles";
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- a self-contained chat engine bound to a feed/input set ---------- */
  function makeEngine(nodes) {
    var feed = nodes.feed,
      chipsWrap = nodes.chips,
      input = nodes.input,
      sendBtn = nodes.send;
    var history = [],
      leadCaptured = false,
      busy = false,
      greeted = false;

    function scrollDown() { feed.scrollTop = feed.scrollHeight; }
    function addMsg(text, who) {
      var d = document.createElement("div");
      d.className = "ace-msg " + (who === "user" ? "user" : "bot");
      d.textContent = text;
      feed.appendChild(d); scrollDown(); return d;
    }
    function showTyping() {
      var t = document.createElement("div");
      t.className = "ace-typing"; t.id = "aceTyping";
      t.innerHTML = "<span></span><span></span><span></span>";
      feed.appendChild(t); scrollDown();
    }
    function hideTyping() { var t = feed.querySelector("#aceTyping"); if (t) t.remove(); }
    function renderChips(chips) {
      chipsWrap.innerHTML = "";
      (chips || []).forEach(function (c) {
        var b = document.createElement("button");
        b.className = "ace-chip"; b.type = "button"; b.textContent = c;
        b.addEventListener("click", function () { send(c); });
        chipsWrap.appendChild(b);
      });
    }
    function showCaptured() {
      var d = document.createElement("div");
      d.className = "ace-captured";
      d.innerHTML = '<span aria-hidden="true">&#9989;</span><div><b>You&rsquo;re on the list.</b> Garrett or Logan will reach out shortly to set up your free Pipeline Teardown.</div>';
      feed.appendChild(d); scrollDown();
    }
    function setBusy(b) { busy = b; sendBtn.disabled = b; input.disabled = b; }

    function send(text) {
      text = (text || input.value || "").trim();
      if (!text || busy) return;
      input.value = "";
      addMsg(text, "user");
      history.push({ role: "user", content: text });
      renderChips([]); setBusy(true); showTyping();

      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, leadCaptured: leadCaptured }),
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (data) {
          hideTyping(); setBusy(false);
          if (data.error) { addMsg("I'm having a hiccup — try again in a sec, or tap Book a Teardown.", "bot"); return; }
          var reply = data.reply || "Sorry, I didn't catch that — mind rephrasing?";
          addMsg(reply, "bot");
          history.push({ role: "assistant", content: reply });
          if (data.captured && !leadCaptured) { leadCaptured = true; showCaptured(); renderChips([]); }
          else { renderChips(data.chips); }
          input.focus();
        })
        .catch(function () {
          hideTyping(); setBusy(false);
          addMsg("Connection glitch — mind trying that again?", "bot");
        });
    }

    function greet() {
      if (greeted) return;
      greeted = true;
      addMsg(GREETING, "bot");
      history.push({ role: "assistant", content: GREETING });
      renderChips(GREET_CHIPS);
    }

    sendBtn.addEventListener("click", function () { send(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); send(); }
    });

    return { send: send, greet: greet };
  }

  function panelInnerHTML() {
    return (
      '<div class="ace-head">' +
      '<span class="ace-orb" aria-hidden="true"></span>' +
      "<div><h4>Ace</h4><div class=\"ace-sub\">ProyTech front desk</div></div>" +
      '<span class="ace-status" title="Online"></span>' +
      '<button class="ace-x" aria-label="Close chat">&#10005;</button>' +
      "</div>" +
      '<div class="ace-feed"></div>' +
      '<div class="ace-chips"></div>' +
      '<div class="ace-input">' +
      '<input type="text" placeholder="Ask about growing your business…" autocomplete="off" aria-label="Your message" />' +
      '<button class="ace-send" aria-label="Send">&#8593;</button>' +
      "</div>"
    );
  }

  /* ---------- floating widget (only if the page lacks one) ---------- */
  function initFloating() {
    injectStyles();

    var launcher = document.createElement("button");
    launcher.id = "aceLauncher";
    launcher.setAttribute("aria-label", "Chat with Ace");
    launcher.innerHTML = '<span class="ace-orb" aria-hidden="true"></span><span>Talk to Ace</span>';

    var panel = document.createElement("div");
    panel.id = "acePanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with Ace");
    panel.innerHTML = panelInnerHTML();

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    var engine = makeEngine({
      feed: panel.querySelector(".ace-feed"),
      chips: panel.querySelector(".ace-chips"),
      input: panel.querySelector(".ace-input input"),
      send: panel.querySelector(".ace-send"),
    });

    function open() {
      panel.classList.add("open");
      launcher.classList.add("hide");
      engine.greet();
      setTimeout(function () { panel.querySelector(".ace-input input").focus(); }, 200);
    }
    function close() { panel.classList.remove("open"); launcher.classList.remove("hide"); }

    launcher.addEventListener("click", open);
    panel.querySelector(".ace-x").addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("open")) close();
    });

    wireTalkButtons(open);
    window.openAce = open;
  }

  /* ---------- wire "Talk to Ace" buttons/links ---------- */
  function wireTalkButtons(openFn) {
    document.querySelectorAll("button, a").forEach(function (el) {
      if (el.id === "aceLauncher" || el.closest("#acePanel")) return;
      if ((el.textContent || "").trim().toLowerCase() === "talk to ace") {
        el.addEventListener("click", function (e) { e.preventDefault(); openFn(); });
      }
    });
  }

  /* ---------- public: mount an inline chat into a container ---------- */
  function mountInline(elId) {
    injectStyles();
    var host = typeof elId === "string" ? document.getElementById(elId) : elId;
    if (!host) return;
    host.classList.add("ace-inline", "ace-card");
    host.innerHTML = panelInnerHTML();
    // inline has no close button use — hide it
    var x = host.querySelector(".ace-x"); if (x) x.style.display = "none";
    var engine = makeEngine({
      feed: host.querySelector(".ace-feed"),
      chips: host.querySelector(".ace-chips"),
      input: host.querySelector(".ace-input input"),
      send: host.querySelector(".ace-send"),
    });
    engine.greet();
  }

  window.Ace = { mountInline: mountInline };

  /* ---------- boot ---------- */
  function boot() {
    if (document.getElementById("aceLauncher")) {
      // host page already has its own floating widget; just ensure inline is available
      injectStyles();
      return;
    }
    initFloating();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
