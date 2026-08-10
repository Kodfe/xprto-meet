/**
 * XPRTO live session.
 *
 * The flow, and why it is in this order:
 *
 *   slug from the URL  →  who are you?  →  may you be here, now?  →  consent
 *   →  a credential that expires in minutes  →  video
 *
 * Nothing about holding the link grants anything. The page asks the API the
 * same question on every step, and the API answers from the booking, not from
 * the URL. A forwarded link gets someone as far as a sign-in box and no
 * further.
 */

(function () {
  "use strict";

  var API = window.XPRTO_API || "https://api.xprto.com";

  /**
   * Session state, in memory only.
   *
   * NOT localStorage, and this is deliberate. A token in localStorage outlives
   * the tab, survives the person walking away from a shared laptop, and is
   * readable by any script that gets injected into this origin. This page runs
   * a large third-party SDK; the token it holds should die when the tab does.
   */
  var state = {
    slug: null,
    isTest: false,
    token: null,
    role: null,
    preview: null,
    client: null,
    localTracks: { mic: null, cam: null },
    renewTimer: null,
    joined: false,
  };

  // ─── Plumbing ─────────────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function show(view) {
    ["loading", "signin", "consent", "room", "message"].forEach(function (name) {
      $("view-" + name).hidden = name !== view;
    });
  }

  function setStatus(text) { $("bar-status").textContent = text || ""; }

  function fail(title, body, retry) {
    $("message-title").textContent = title;
    $("message-body").textContent = body || "";
    $("message-retry").hidden = !retry;
    show("message");
  }

  /**
   * Every call to the API.
   *
   * The bearer token goes in the Authorization header rather than a cookie,
   * because this origin deliberately does not share cookies with xprto.com.
   */
  function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;

    return fetch(API + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; })
          .then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .catch(function () {
        // A network failure and a rejection are different things and must read
        // differently — "check your connection" is useless advice when the real
        // answer is "your booking was cancelled".
        return { ok: false, status: 0, data: { message: "Could not reach XPRTO. Check your connection." } };
      });
  }

  /** The room endpoints differ for test rooms; everything else is identical. */
  function roomPath(suffix) {
    var base = state.isTest ? "/v1/account/live/test/" : "/v1/account/live/";
    return base + encodeURIComponent(state.slug) + (suffix || "");
  }

  // ─── 1. What session is this? ─────────────────────────────────────────────

  function readSlug() {
    // /s/<slug>. Anything else is not a session link.
    var match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
    return match ? match[1] : null;
  }

  function loadPreview() {
    show("loading");
    setStatus("");

    return api(roomPath()).then(function (res) {
      if (res.status === 401) {
        show("signin");
        return;
      }

      // A real slug that is not found falls back to the test space, so one URL
      // shape covers both and the page does not need to know which it holds.
      if (!res.ok && !state.isTest) {
        state.isTest = true;
        return api(roomPath()).then(function (retry) {
          if (retry.status === 401) { show("signin"); return; }
          if (!retry.ok) {
            state.isTest = false;
            return fail("This session is not available", res.data.message || "The link may be wrong, or the session may have been cancelled.");
          }
          state.preview = retry.data.result;
          renderConsent();
        });
      }

      if (!res.ok) {
        return fail("This session is not available", res.data.message || "");
      }

      state.preview = res.data.result;
      renderConsent();
    });
  }

  // ─── 2. Sign in ───────────────────────────────────────────────────────────

  /**
   * A sign-in form on a different domain is a phishing-shaped pattern, and it
   * is here because this is the testing build. The permanent version should be
   * a one-time signed join link issued by the app or the dashboard, so nobody
   * is ever asked for an XPRTO password on xprto.app. Noted here rather than in
   * a ticket because this is the file that has to change.
   */
  function signIn(event) {
    event.preventDefault();
    var button = $("signin-submit");
    var error = $("signin-error");

    error.hidden = true;
    button.disabled = true;
    button.textContent = "Signing in…";

    api("/v1/auth/login", {
      method: "POST",
      body: {
        email: $("email").value.trim(),
        password: $("password").value,
        role: $("role").value,
      },
    }).then(function (res) {
      button.disabled = false;
      button.textContent = "Sign in";

      var token = res.data && (res.data.s_id || res.data.token);
      if (!res.ok || !token) {
        error.textContent = (res.data && res.data.message) || "Could not sign in.";
        error.hidden = false;
        return;
      }

      state.token = token;
      state.role = $("role").value;
      $("password").value = "";
      loadPreview();
    });
  }

  // ─── 3. Consent ───────────────────────────────────────────────────────────

  function renderConsent() {
    var p = state.preview || {};
    var notice = p.notice || {};

    $("consent-title").textContent = notice.title || "Before you join";
    $("consent-service").textContent = p.service || "XPRTO session";
    $("consent-body").textContent = notice.body || "";
    $("consent-footer").textContent = notice.footer || "";

    if (p.opens_at && p.closes_at) {
      var opens = new Date(p.opens_at);
      var closes = new Date(p.closes_at);
      $("consent-when").textContent =
        "Open from " + timeOf(opens) + " until " + timeOf(closes) + ".";
    } else {
      $("consent-when").textContent = "";
    }

    var join = $("consent-join");
    var agree = $("consent-agree");
    var error = $("consent-error");

    agree.checked = false;
    join.disabled = true;
    error.hidden = true;

    if (!p.can_join) {
      // Still show the notice and the window — someone who arrived early needs
      // to know when to come back, not just that they cannot come in.
      error.textContent = p.reason || "This session is not open.";
      error.hidden = false;
      join.textContent = "Not open yet";
      agree.disabled = true;
    } else {
      join.textContent = "Join session";
      agree.disabled = false;
    }

    show("consent");
  }

  function timeOf(date) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // ─── 4. The session ───────────────────────────────────────────────────────

  function requestToken() {
    return api(roomPath("/token"), { method: "POST" });
  }

  function join() {
    var error = $("consent-error");
    var button = $("consent-join");

    error.hidden = true;
    button.disabled = true;
    button.textContent = "Joining…";

    requestToken().then(function (res) {
      button.disabled = false;
      button.textContent = "Join session";

      if (!res.ok) {
        error.textContent = res.data.message || "Could not join this session.";
        error.hidden = false;
        return;
      }

      startCall(res.data.result).catch(function (err) {
        console.error(err);
        // Permission refusal is by far the most common failure and has nothing
        // to do with XPRTO, so it gets its own words.
        var denied = err && (err.name === "NotAllowedError" || err.code === "PERMISSION_DENIED");
        fail(
          denied ? "XPRTO needs your camera and microphone" : "Could not start the session",
          denied
            ? "Allow access in your browser, then try again. On iPhone, Safari asks each time."
            : "Something went wrong starting the video. Please try again.",
          true,
        );
      });
    });
  }

  function startCall(credentials) {
    show("room");
    setStatus("Connecting…");

    state.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

    state.client.on("user-published", function (user, mediaType) {
      state.client.subscribe(user, mediaType).then(function () {
        if (mediaType === "video") {
          $("remote-waiting").hidden = true;
          user.videoTrack.play("remote");
        }
        if (mediaType === "audio") user.audioTrack.play();
        setStatus("Connected");
      });
    });

    state.client.on("user-unpublished", function () {
      $("remote-waiting").hidden = false;
      $("remote-waiting").textContent = "The other person's video is off.";
    });

    state.client.on("user-left", function () {
      $("remote-waiting").hidden = false;
      $("remote-waiting").textContent = "The other person has left.";
      setStatus("They left");
    });

    return state.client
      .join(credentials.app_id, credentials.channel, credentials.token, credentials.uid)
      .then(function () {
        state.joined = true;
        scheduleRenewal(credentials.expires_in);
        return AgoraRTC.createMicrophoneAndCameraTracks();
      })
      .then(function (tracks) {
        state.localTracks.mic = tracks[0];
        state.localTracks.cam = tracks[1];
        state.localTracks.cam.play("local");
        setStatus("Connected");
        return state.client.publish(tracks);
      });
  }

  /**
   * Renew before expiry.
   *
   * The token deliberately lives minutes, and the renewal is not a formality —
   * it is the server re-checking that the booking is still active and the
   * caller is still on it. Asked for at 80% of the lifetime so a slow network
   * has room to answer before Agora drops the connection.
   */
  function scheduleRenewal(seconds) {
    clearTimeout(state.renewTimer);
    var wait = Math.max(30, Math.floor((seconds || 900) * 0.8)) * 1000;

    state.renewTimer = setTimeout(function () {
      requestToken().then(function (res) {
        if (!res.ok) {
          // The booking was cancelled, or the window closed mid-call. Say so
          // rather than letting the video die silently a minute later.
          leave(res.data.message || "This session has ended.");
          return;
        }
        state.client.renewToken(res.data.result.token);
        scheduleRenewal(res.data.result.expires_in);
      });
    }, wait);
  }

  function leave(reason) {
    clearTimeout(state.renewTimer);

    ["mic", "cam"].forEach(function (key) {
      var track = state.localTracks[key];
      if (track) { track.stop(); track.close(); state.localTracks[key] = null; }
    });

    var done = state.client && state.joined ? state.client.leave() : Promise.resolve();

    return done.then(function () {
      state.joined = false;
      // Best effort, and the server treats it that way: a tab closed mid-call
      // never sends this, so duration is derived from what did arrive.
      api(roomPath("/left"), { method: "POST" });
      fail(reason || "You have left this session", reason ? "" : "You can close this tab.", false);
      setStatus("");
    });
  }

  function toggle(kind) {
    var track = kind === "mic" ? state.localTracks.mic : state.localTracks.cam;
    if (!track) return;

    var button = kind === "mic" ? $("btn-mic") : $("btn-cam");
    var muted = button.getAttribute("aria-pressed") === "true";

    track.setEnabled(muted);
    button.setAttribute("aria-pressed", String(!muted));
    button.textContent = kind === "mic"
      ? (muted ? "Mute" : "Unmute")
      : (muted ? "Camera off" : "Camera on");
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  $("signin-form").addEventListener("submit", signIn);
  $("consent-agree").addEventListener("change", function (e) {
    $("consent-join").disabled = !e.target.checked;
  });
  $("consent-join").addEventListener("click", join);
  $("btn-mic").addEventListener("click", function () { toggle("mic"); });
  $("btn-cam").addEventListener("click", function () { toggle("cam"); });
  $("btn-leave").addEventListener("click", function () { leave(); });
  $("message-retry").addEventListener("click", function () { loadPreview(); });

  // Release the camera if the tab goes away. Without this the light stays on,
  // which people reasonably read as being recorded.
  window.addEventListener("pagehide", function () {
    if (state.joined) leave();
  });

  state.slug = readSlug();
  if (!state.slug) {
    fail("This is not a session link", "Open the link from your XPRTO booking.");
  } else {
    loadPreview();
  }
})();
