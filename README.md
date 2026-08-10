# xprto-meet

The live session page — `session.xprto.app`.

A static page. No framework, no build step, no server. Vercel serves
`public/`, and everything the page needs comes from `api.xprto.com`.

## What it is for

XPRTO's online expert sessions used to run on Google Meet links that the expert
typed in themselves. That meant the expert owned the room, XPRTO was not in it,
and a twelve-session package had one link valid for all twelve — forward it once
and it worked for months.

Now XPRTO creates a room per session, and this is the page people land on.

## The rule

**Holding the link grants nothing.** The slug in the URL identifies a room and
proves nothing about who you are. Every step asks `api.xprto.com`, which answers
from the booking:

- are you one of the two people on this booking?
- is the booking still active?
- is it inside this session's window?

Re-asked on every token renewal, which is why the credential lives fifteen
minutes rather than hours. A booking cancelled mid-session stops being joinable
at the next renewal.

## Why a different domain

`xprto.app`, not a subdomain of `xprto.com`, on purpose. The `s_id` cookie is
scoped to `xprto.com`, so every subdomain receives it — and this page runs a
large third-party media SDK. Keeping it on a separate registrable domain means
that cookie is never sent here. The page holds a bearer token in memory instead,
never in `localStorage`, so closing the tab ends the session.

## Layout

```
public/
  index.html   five states: loading, sign in, consent, in-session, message
  app.js       the whole client
  style.css    one screen, light and dark
  vendor/      Agora Web SDK, copied from npm — see below
vercel.json    /s/:slug rewrite, security headers
```

### The vendored SDK

`public/vendor/agora-rtc-sdk.js` is a copy of `agora-rtc-sdk-ng`, served from
our own origin rather than Agora's CDN: a session must not fail to start
because someone else's CDN is having a bad day, and a third party does not need
a request on every join.

To update it:

```bash
npm install agora-rtc-sdk-ng@latest && npm run vendor
```

## Local

```bash
npm run dev
```

Then open `http://localhost:3100/index.html`. Note that camera and microphone
need a secure context — `localhost` counts, plain HTTP on another host does not.

Point it at a different API with `window.XPRTO_API` before `app.js` loads.

## Known temporary things

**The sign-in form.** Asking for an XPRTO password on `xprto.app` is a
phishing-shaped pattern, and it is here only so sessions can be tested before
the app integration exists. The permanent version is a one-time signed join
link issued by the app or the dashboard, so nobody is ever asked for a password
on this domain. It is marked in `app.js` above `signIn()`.

**Test rooms.** The API has a room type that admits any signed-in account, for
trying this out without a real booking. It only exists when `LIVE_TEST_ROOMS=true`
on the server, and must be off before launch.

## Not built yet

- Screen share
- Recording (the consent gate is already in place, so it can be switched on
  without going back to people who have already been meeting)
- In-session chat
