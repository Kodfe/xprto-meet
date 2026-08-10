"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
    IAgoraRTCClient, IAgoraRTCRemoteUser, ICameraVideoTrack, ILocalVideoTrack,
    IMicrophoneAudioTrack,
} from "agora-rtc-sdk-ng";
import {
    ClipboardList, Loader2, MessageSquare, Mic, MicOff, MonitorUp, MonitorX,
    PhoneOff, Settings, UserX, Video, VideoOff,
} from "lucide-react";
import { api, roomPath, type Credentials, type Preview } from "@/lib/api";

/** Join class names, skipping false and undefined. */
function cn(...parts: (string | false | null | undefined)[]) {
    return parts.filter(Boolean).join(" ");
}
import { Chat } from "@/components/Chat";
import { GoogleSignIn } from "@/components/GoogleSignIn";
import { HealthPanel } from "@/components/HealthPanel";
import { PreJoin, type ReadyTracks } from "@/components/PreJoin";
import { DeviceSettings } from "@/components/DeviceSettings";

/**
 * The session.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER
 *
 *   slug from the URL → who are you? → may you be here, now? → the warning
 *   → a credential that expires in minutes → video
 *
 * Holding the link grants nothing. The slug names a room and proves nothing
 * about who holds it; the API answers from the booking, not from the URL. A
 * forwarded link gets someone as far as a sign-in box and no further.
 *
 * WHY THE SDK IS IMPORTED INSIDE AN EFFECT
 *
 * agora-rtc-sdk-ng touches `window` while it is being imported, so a top-level
 * import crashes the server render. `next/dynamic` would also work; a plain
 * dynamic import at the point of use keeps it out of the bundle entirely for
 * anyone who never joins, which is every visitor who arrives early or holds a
 * dead link.
 */

/**
 * "ready" sits between agreeing to the warning and being in the call: see
 * PreJoin. It is the difference between finding out your microphone is dead
 * now and finding out while an expert waits and the clock runs.
 */
type View = "loading" | "signin" | "warning" | "ready" | "room" | "message";

export function SessionRoom({ slug }: { slug: string }) {
    const [view, setView] = useState<View>("loading");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [message, setMessage] = useState<{ title: string; body: string; retry: boolean } | null>(null);
    const [status, setStatus] = useState("");

    /**
     * The token, in a ref rather than state, and never in localStorage.
     *
     * localStorage outlives the tab, survives someone walking away from a
     * shared laptop, and is readable by any script that reaches this origin —
     * which runs a large third-party media SDK. A ref dies with the page, which
     * is the correct lifetime for a credential to a live video room.
     */
    const token = useRef<string | null>(null);
    const isTest = useRef(false);

    const [signinError, setSigninError] = useState<string | null>(null);
    const [signinRole, setSigninRole] = useState("client");
    const [signingIn, setSigningIn] = useState(false);
    const [agreed, setAgreed] = useState(false);
    const [joinError, setJoinError] = useState<string | null>(null);
    const [joining, setJoining] = useState(false);

    const fail = useCallback((title: string, body: string, retry = false) => {
        setMessage({ title, body, retry });
        setView("message");
    }, []);

    // ─── Who is this, and may they be here ────────────────────────────────

    const loadPreview = useCallback(async () => {
        setView("loading");

        let res = await api<Preview>(roomPath(slug, isTest.current), { token: token.current });

        if (res.status === 401) {
            setView("signin");
            return;
        }

        // A slug that is not a real room falls back to the test space, so one
        // URL shape covers both and the page never has to be told which it has.
        if (!res.ok && !isTest.current) {
            isTest.current = true;
            res = await api<Preview>(roomPath(slug, true), { token: token.current });
            if (res.status === 401) {
                setView("signin");
                return;
            }
            if (!res.ok) isTest.current = false;
        }

        if (!res.ok || !res.data.result) {
            fail(
                "This session is not available",
                res.data.message || "The link may be wrong, or the session may have been cancelled.",
            );
            return;
        }

        setPreview(res.data.result);
        setAgreed(false);
        setJoinError(res.data.result.can_join ? null : res.data.result.reason);
        setView("warning");
    }, [slug, fail]);

    useEffect(() => { loadPreview(); }, [loadPreview]);

    /**
     * A sign-in form on a domain that is not xprto.com is a phishing-shaped
     * pattern, and it is here only so sessions can be tested before the app
     * issues join links. The permanent version is a one-time signed link, so
     * nobody is ever asked for an XPRTO password on xprto.app. Marked here
     * because this is the code that has to go.
     */
    async function signIn(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        setSigningIn(true);
        setSigninError(null);

        const res = await api<unknown>("/v1/auth/login", {
            method: "POST",
            body: {
                email: String(form.get("email") || "").trim(),
                password: String(form.get("password") || ""),
                role: String(form.get("role") || "client"),
            },
        });

        setSigningIn(false);

        const body = res.data as { s_id?: string; token?: string; message?: string };
        const issued = body.s_id || body.token;

        if (!res.ok || !issued) {
            setSigninError(body.message || "Could not sign in.");
            return;
        }

        token.current = issued;
        loadPreview();
    }

    // ─── The call ─────────────────────────────────────────────────────────

    const client = useRef<IAgoraRTCClient | null>(null);
    const mic = useRef<IMicrophoneAudioTrack | null>(null);
    const cam = useRef<ICameraVideoTrack | null>(null);
    const renewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const joined = useRef(false);

    const screen = useRef<ILocalVideoTrack | null>(null);

    const [micOn, setMicOn] = useState(true);
    const [camOn, setCamOn] = useState(true);
    const [sharing, setSharing] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const [healthOpen, setHealthOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [shareError, setShareError] = useState<string | null>(null);
    const [peerVideo, setPeerVideo] = useState(false);
    const [peerAudio, setPeerAudio] = useState(false);
    const [peerHere, setPeerHere] = useState(false);
    const [peerLeft, setPeerLeft] = useState(false);

    /**
     * Who is talking, as a level rather than a boolean.
     *
     * Agora reports volume 0-100 several times a second. Rendering that raw
     * makes the ring strobe on every consonant, so it is damped: a level has to
     * clear a threshold to light up, and it stays lit briefly after speech
     * stops. That is what makes the indicator read as "this person is
     * speaking" rather than as a flicker.
     */
    const [speaking, setSpeaking] = useState<{ local: boolean; peer: boolean }>({ local: false, peer: false });
    const speakingUntil = useRef<{ local: number; peer: number }>({ local: 0, peer: 0 });

    /**
     * What to call the other person.
     *
     * Not a name. The preview deliberately carries none, and in a call with
     * exactly two people the role is the useful label anyway — which also
     * means one less field to leak into a payload kept deliberately thin.
     */
    const peerLabel = preview?.you_are === "trainer" ? "Your client" : "Your trainer";

    const localBox = useRef<HTMLDivElement | null>(null);
    const shareBox = useRef<HTMLDivElement | null>(null);
    const remoteBox = useRef<HTMLDivElement | null>(null);

    const leave = useCallback(async (reason?: string) => {
        if (renewTimer.current) clearTimeout(renewTimer.current);

        for (const ref of [mic, cam, screen]) {
            ref.current?.stop();
            ref.current?.close();
            ref.current = null;
        }

        if (client.current && joined.current) {
            await client.current.leave().catch(() => {});
        }
        joined.current = false;

        // Best effort, and the server treats it as such: a tab closed
        // mid-call never sends this, so duration is derived from what did
        // arrive rather than trusted from here.
        api(roomPath(slug, isTest.current, "/left"), { method: "POST", token: token.current });

        setStatus("");
        fail(reason || "You have left this session", reason ? "" : "You can close this tab.");
    }, [slug, fail]);

    /**
     * Renew before expiry.
     *
     * Not a formality: the renewal is the server re-checking that the booking
     * is still active and the caller is still a party to it. Asked for at 80%
     * of the lifetime so a slow network has room to answer before Agora drops
     * the connection.
     */
    const scheduleRenewal = useCallback((seconds: number) => {
        if (renewTimer.current) clearTimeout(renewTimer.current);
        const wait = Math.max(30, Math.floor((seconds || 900) * 0.8)) * 1000;

        renewTimer.current = setTimeout(async () => {
            const res = await api<Credentials>(roomPath(slug, isTest.current, "/token"), {
                method: "POST",
                token: token.current,
            });

            if (!res.ok || !res.data.result) {
                // Cancelled, or the window closed mid-call. Say so, rather than
                // letting the video die silently a minute later.
                leave(res.data.message || "This session has ended.");
                return;
            }

            await client.current?.renewToken(res.data.result.token);
            scheduleRenewal(res.data.result.expires_in);
        }, wait);
    }, [slug, leave]);

    /**
     * Agreeing to the warning opens the pre-join screen. No token is requested
     * here — asking for one now would start its fifteen-minute life while
     * somebody is still choosing a camera.
     */
    function join() {
        setJoinError(null);
        setView("ready");
    }

    /** From the pre-join screen: publish the devices already previewing. */
    async function enterCall(ready: ReadyTracks) {
        setJoining(true);
        setJoinError(null);

        const res = await api<Credentials>(roomPath(slug, isTest.current, "/token"), {
            method: "POST",
            token: token.current,
        });

        if (!res.ok || !res.data.result) {
            setJoining(false);
            setJoinError(res.data.message || "Could not join this session.");
            return;
        }

        const credentials = res.data.result;
        setView("room");
        setStatus("Connecting…");

        try {
            const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
            const rtc = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
            client.current = rtc;

            rtc.on("user-published", async (user: IAgoraRTCRemoteUser, kind) => {
                await rtc.subscribe(user, kind);
                setPeerHere(true);
                setPeerLeft(false);
                if (kind === "video" && remoteBox.current) {
                    setPeerVideo(true);
                    user.videoTrack?.play(remoteBox.current);
                }
                if (kind === "audio") {
                    setPeerAudio(true);
                    user.audioTrack?.play();
                }
                setStatus("Connected");
            });

            // Unpublishing is how the other side's mute and camera-off reach us.
            // Tracked separately, because "camera off" and "muted" are different
            // things to show and the old code only noticed video.
            rtc.on("user-unpublished", (_user, kind) => {
                if (kind === "video") setPeerVideo(false);
                if (kind === "audio") setPeerAudio(false);
            });

            rtc.on("user-left", () => {
                setPeerVideo(false);
                setPeerAudio(false);
                setPeerHere(false);
                setPeerLeft(true);
                setStatus("They left");
            });

            // 400ms is Agora's minimum useful interval; faster reports more
            // noise than speech.
            rtc.enableAudioVolumeIndicator();
            rtc.on("volume-indicator", volumes => {
                const now = Date.now();
                const next = { ...speakingUntil.current };

                for (const { uid, level } of volumes) {
                    // 12 clears breathing and keyboard noise but catches a quiet
                    // voice. 900ms of hold is roughly the gap between words, so
                    // the ring does not blink through a sentence.
                    if (level > 12) {
                        const who = Number(uid) === Number(credentials.uid) ? "local" : "peer";
                        next[who] = now + 900;
                    }
                }
                speakingUntil.current = next;

                // Only when it CHANGES. This fired on every volume report with
                // a fresh object, so React re-rendered the entire call view
                // several times a second whether or not anybody was talking —
                // and each render walks the tiles, the panels and the bar.
                const local = next.local > now;
                const peer = next.peer > now;
                setSpeaking(prev =>
                    prev.local === local && prev.peer === peer ? prev : { local, peer },
                );
            });

            await rtc.join(credentials.app_id, credentials.channel, credentials.token, credentials.uid);
            joined.current = true;
            scheduleRenewal(credentials.expires_in);

            // The tracks from the preview, not fresh ones. Creating new tracks
            // here would discard the device the user just picked and ask for
            // permission a second time on some browsers.
            mic.current = ready.mic;
            cam.current = ready.cam;
            setMicOn(ready.micOn);
            setCamOn(ready.camOn);

            if (ready.cam && localBox.current) ready.cam.play(localBox.current);

            const publishing = [ready.mic, ready.cam].filter(Boolean) as NonNullable<
                typeof ready.mic | typeof ready.cam
            >[];
            if (publishing.length) await rtc.publish(publishing);
            setStatus("Connected");
        } catch (err) {
            const denied =
                (err as { name?: string; code?: string })?.name === "NotAllowedError" ||
                (err as { code?: string })?.code === "PERMISSION_DENIED";

            // By far the most common failure, and nothing to do with XPRTO — so
            // it gets its own words rather than a generic apology.
            fail(
                denied ? "XPRTO needs your camera and microphone" : "Could not start the session",
                denied
                    ? "Allow access in your browser, then try again. On iPhone, Safari asks every time."
                    : "Something went wrong starting the video. Please try again.",
                true,
            );
        } finally {
            setJoining(false);
        }
    }


    /**
     * Screen share.
     *
     * The camera is UNPUBLISHED while sharing rather than published alongside.
     * Agora allows one video track per user, so publishing a second silently
     * replaces the first on the other side — and on a 1 Mbit Indian mobile
     * uplink, sending two video streams would degrade both. The self-view
     * switches to the shared screen so you can see what they can see, which is
     * the mistake people actually make: sharing the wrong window.
     */
    async function startShare() {
        if (!client.current) return;
        setShareError(null);

        try {
            const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
            const track = await AgoraRTC.createScreenVideoTrack({}, "disable");
            screen.current = track;

            if (cam.current) await client.current.unpublish(cam.current);
            await client.current.publish(track);
            setSharing(true);

            // Into the STAGE, not the corner thumbnail. You cannot check that
            // you are sharing the right window from a 200px box, and picking
            // the wrong one is the mistake people actually make.
            //
            // After the state flip, so the element exists to play into.
            requestAnimationFrame(() => {
                if (shareBox.current) track.play(shareBox.current, { fit: "contain" });
            });

            // The browser has its own "Stop sharing" bar, and it does not go
            // through our button. Without this the call keeps publishing a dead
            // track and the other person sees a frozen frame.
            track.on("track-ended", () => { stopShare(); });
        } catch (err) {
            const denied = (err as { name?: string })?.name === "NotAllowedError";
            // Cancelling the picker is not an error worth shouting about.
            if (!denied) setShareError("Could not share your screen.");
            screen.current?.close();
            screen.current = null;
        }
    }

    async function stopShare() {
        if (!client.current) return;

        if (screen.current) {
            await client.current.unpublish(screen.current).catch(() => {});
            screen.current.stop();
            screen.current.close();
            screen.current = null;
        }

        // State first, THEN play. The self-view is display:none while sharing,
        // and starting playback into a hidden element leaves a black tile.
        setSharing(false);

        if (cam.current) {
            await client.current.publish(cam.current).catch(() => {});
            const track = cam.current;
            requestAnimationFrame(() => {
                if (localBox.current) track.play(localBox.current);
            });
        }
    }

    function toggleMic() {
        if (!mic.current) return;
        const next = !micOn;
        mic.current.setEnabled(next);
        setMicOn(next);
    }

    function toggleCam() {
        // While sharing, the camera is not published — enabling it here would
        // put a device the other side cannot see into a state the button
        // claims is on. The control is disabled in the UI for the same reason.
        if (!cam.current || sharing) return;
        const next = !camOn;
        cam.current.setEnabled(next);
        setCamOn(next);
    }

    /**
     * A headset paired DURING the call.
     *
     * PreJoin handles devices connected before joining; this is the same
     * listener for after, which is the case people actually hit. Without it a
     * track stays bound to whatever was default when it was created, so
     * earbuds put in mid-session do nothing and the person sounds wrong to
     * everyone but themselves.
     *
     * Only while joined — outside a call there is no track to move.
     */
    useEffect(() => {
        if (view !== "room") return;
        let cancelled = false;

        (async () => {
            const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
            if (cancelled) return;

            AgoraRTC.onMicrophoneChanged = async changed => {
                // Appearing: switch to it, because putting earbuds in means
                // using them. Disappearing: fall back, or a headset running out
                // of battery takes the call with it.
                const list = await AgoraRTC.getMicrophones();
                const target = changed.state === "ACTIVE" ? changed.device : list[0];
                if (!target || !mic.current) return;
                try { await mic.current.setDevice(target.deviceId); } catch { /* the panel can correct it */ }
            };
        })();

        return () => { cancelled = true; };
    }, [view]);

    // Release the camera if the tab goes away. Without this the indicator light
    // stays on, which people reasonably read as being recorded.
    useEffect(() => {
        const onHide = () => { if (joined.current) leave(); };
        window.addEventListener("pagehide", onHide);
        return () => {
            window.removeEventListener("pagehide", onHide);
            if (renewTimer.current) clearTimeout(renewTimer.current);
        };
    }, [leave]);

    // ─── Render ───────────────────────────────────────────────────────────

    return (
        <main id="app">
            <header className="bar">
                <span className="brand">XPRTO</span>
                <span className="status">{status}</span>
            </header>

            {view === "loading" && (
                <section className="view">
                    {/* This is the first thing anyone sees, and it used to be one
                        grey line in an empty card — which reads as a page that
                        has failed rather than one that is working. A spinner and
                        a sentence about what is happening is the difference
                        between waiting and wondering. */}
                    <div className="card text-center">
                        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent/10 text-accent">
                            <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
                        </div>
                        <h1 className="mt-4">Checking this session</h1>
                        <p className="muted !mb-0">
                            One moment — we are confirming the session is open and
                            that you are on the booking.
                        </p>
                    </div>
                </section>
            )}

            {view === "signin" && (
                <section className="view">
                    <div className="card">
                        <h1>Sign in to join</h1>
                        <p className="muted">Use the same XPRTO account you booked with.</p>

                        {/* Above the form, and it reads the role selected below —
                            signing in as the wrong side lands you in a room you
                            are not a party to and gets refused. */}
                        <GoogleSignIn
                            role={signinRole}
                            onSignedIn={issued => { token.current = issued; loadPreview(); }}
                            onError={setSigninError}
                        />

                        <form onSubmit={signIn} noValidate>
                            <label htmlFor="email">Email</label>
                            <input id="email" name="email" type="email" autoComplete="username" required />

                            <label htmlFor="password">Password</label>
                            <input id="password" name="password" type="password" autoComplete="current-password" required />

                            <label htmlFor="role">I am the</label>
                            <select
                                id="role" name="role" value={signinRole}
                                onChange={e => setSigninRole(e.target.value)}
                            >
                                <option value="client">Client</option>
                                <option value="trainer">Expert / Trainer</option>
                                <option value="admin">Admin</option>
                            </select>

                            {signinError && <p className="error">{signinError}</p>}
                            <button type="submit" disabled={signingIn}>
                                {signingIn ? "Signing in…" : "Sign in"}
                            </button>
                        </form>
                    </div>
                </section>
            )}

            {view === "warning" && preview && (() => {
                /**
                 * A missing field must not white-screen this page.
                 *
                 * It did: the server was still sending the old single `notice`
                 * while this read `warning.title`, so signing in threw
                 * "cannot read properties of undefined" and React unmounted the
                 * whole app. The person sees "Application error" at the moment
                 * they are trying to join something they paid for, and there is
                 * no way back from it.
                 *
                 * The server is fixed, and this makes the class of bug survivable
                 * rather than fatal. A generic warning still says the important
                 * thing; a blank page says nothing at all.
                 */
                const warning = preview.warning ?? {
                    title: "Before you join",
                    lead: "This session takes place on XPRTO.",
                    points: [
                        "Do not exchange personal contact details or arrange sessions outside XPRTO.",
                        "Payment protection and dispute support apply only to sessions held here.",
                    ],
                    footer: "Your joining and leaving times are recorded.",
                    consent: "I understand this session takes place on XPRTO and that a record is kept.",
                };
                return (
                <section className="view">
                    <div className="card">
                        <h1>{warning.title}</h1>
                        <p className="muted">{preview.service || "XPRTO session"}</p>

                        {/* The hard warning. Written per role on the server — the
                            expert and the client lose entirely different things
                            when a session moves off the platform, so they are not
                            shown the same words. */}
                        <div className="notice">
                            <p className="lead">{warning.lead}</p>
                            <ul>
                                {(warning.points ?? []).map((point, i) => <li key={i}>{point}</li>)}
                            </ul>
                        </div>

                        <ul className="facts">
                            {preview.opens_at && preview.closes_at && (
                                <li>
                                    Open from {timeOf(preview.opens_at)} until {timeOf(preview.closes_at)}.
                                </li>
                            )}
                            <li>{warning.footer}</li>
                        </ul>

                        <label className="check">
                            <input
                                type="checkbox"
                                checked={agreed}
                                disabled={!preview.can_join}
                                onChange={e => setAgreed(e.target.checked)}
                            />
                            <span>{warning.consent}</span>
                        </label>

                        {joinError && <p className="error">{joinError}</p>}

                        <button type="button" disabled={!agreed || !preview.can_join || joining} onClick={join}>
                            {!preview.can_join ? "Not open yet" : joining ? "Joining…" : "Join session"}
                        </button>
                    </div>
                </section>
                );
            })()}

            {view === "ready" && (
                <section className="flex flex-1 items-center">
                    <PreJoin
                        peerLabel={peerLabel}
                        joining={joining}
                        error={joinError}
                        onJoin={enterCall}
                    />
                </section>
            )}

            {view === "room" && (
                <section className="relative flex-1 overflow-hidden bg-stage">
                    {/* The other person, edge to edge. The speaking ring is inset
                        rather than a border so it cannot shift the layout when it
                        appears — a stage that nudges every time somebody talks is
                        worse than no indicator at all. */}
                    {/* While you are sharing, your screen IS the stage and the
                        other person moves to a corner tile — the arrangement
                        Meet and Zoom both use, because the shared thing is what
                        everyone is looking at. */}
                    <div
                        ref={shareBox}
                        className={cn(
                            "z-10 overflow-hidden bg-stage [&>div]:!h-full [&>div]:!w-full [&_video]:!h-full [&_video]:!w-full [&_video]:object-contain",
                            sharing ? "absolute inset-0" : "hidden",
                        )}
                    />

                    {sharing && (
                        <div className="pointer-events-none absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full bg-accent px-3 py-1.5">
                            <MonitorUp className="h-3.5 w-3.5 text-accent-ink" aria-hidden="true" />
                            <span className="text-[13px] font-medium text-accent-ink">You are sharing your screen</span>
                        </div>
                    )}

                    <div className={cn(sharing ? "absolute bottom-24 right-4 z-20 h-[113px] w-[200px] overflow-hidden rounded-xl2 border border-white/20 max-[700px]:bottom-[88px] max-[700px]:h-32 max-[700px]:w-24" : "absolute inset-0")}>
                        {/* object-CONTAIN, not cover.

                            A desktop screen shared to a portrait phone was being
                            cropped to its middle strip — the reported bug. Cover
                            fills the box by cutting content off, which is fine
                            for a face and destroys a shared document. Letterboxed
                            is the only version that always shows what was sent. */}
                        <div ref={remoteBox} className="absolute inset-0 [&>div]:!h-full [&>div]:!w-full [&_video]:!h-full [&_video]:!w-full [&_video]:object-contain" />

                        {!peerVideo && (
                            <div className="absolute inset-0 grid place-items-center">
                                <div className="flex flex-col items-center gap-3 px-6 text-center">
                                    <div className="grid h-20 w-20 place-items-center rounded-full bg-white/10 text-white/70">
                                        {peerLeft ? <UserX className="h-8 w-8" /> : peerHere ? <VideoOff className="h-8 w-8" /> : <Loader2 className="h-8 w-8 animate-spin" />}
                                    </div>
                                    <p className="text-[14px] text-white/60">
                                        {peerLeft
                                            ? peerLabel + " has left the session."
                                            : peerHere
                                                ? peerLabel + "’s camera is off."
                                                : "Waiting for " + peerLabel.toLowerCase() + " to join…"}
                                    </p>
                                </div>
                            </div>
                        )}

                        {speaking.peer && (
                            <div className="pointer-events-none absolute inset-0 ring-4 ring-inset ring-accent/70" aria-hidden="true" />
                        )}

                        {peerHere && (
                            <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5">
                                <span className="text-[13px] font-medium text-white">{peerLabel}</span>
                                {!peerAudio && <MicOff className="h-3.5 w-3.5 text-danger" aria-label="Muted" />}
                            </div>
                        )}
                    </div>

                    {/* Self-view.
                        A solid WHITE border, not a faint one. At a glance on a
                        phone the two feeds are just two faces, and a 15%-white
                        hairline disappears against a bright camera image — which
                        is exactly when it is needed. White reads against any
                        video content, so the tile that is you is never in doubt.
                        The label says "You" as well; the border is what works
                        before anyone reads. */}
                    <div className={cn(
                        "absolute bottom-24 right-4 z-20 h-[113px] w-[200px] overflow-hidden rounded-xl2 border-2 border-white bg-stage shadow-tile max-[700px]:bottom-[88px] max-[700px]:h-32 max-[700px]:w-24",
                        // Hidden while sharing: the camera is unpublished then,
                        // so it would sit next to the peer's tile as an empty
                        // white-bordered box.
                        sharing && "hidden",
                    )}>
                        <div ref={localBox} className="absolute inset-0 [&>div]:!h-full [&>div]:!w-full [&_video]:!h-full [&_video]:!w-full [&_video]:object-cover" />

                        {!camOn && !sharing && (
                            <div className="absolute inset-0 grid place-items-center bg-stage">
                                <VideoOff className="h-6 w-6 text-white/50" />
                            </div>
                        )}

                        {speaking.local && (
                            <div className="pointer-events-none absolute inset-0 rounded-xl2 ring-2 ring-inset ring-accent" aria-hidden="true" />
                        )}

                        <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5">
                            <span className="text-[11px] font-medium text-white">You</span>
                            {!micOn && <MicOff className="h-3 w-3 text-danger" aria-label="Muted" />}
                        </div>
                    </div>

                    {settingsOpen ? (
                        <DeviceSettings
                            mic={mic.current}
                            cam={cam.current}
                            onClose={() => setSettingsOpen(false)}
                        />
                    ) : null}

                    {healthOpen && preview?.booking_id ? (
                        <HealthPanel slug={slug} token={token.current} onClose={() => setHealthOpen(false)} />
                    ) : null}

                    {chatOpen && preview?.booking_id ? (
                        <Chat
                            bookingId={preview.booking_id}
                            token={token.current}
                            myRole={preview.you_are}
                            onClose={() => setChatOpen(false)}
                        />
                    ) : null}

                    {shareError && (
                        <p className="absolute left-1/2 top-4 z-30 max-w-[min(90vw,420px)] -translate-x-1/2 rounded-full bg-danger px-4 py-2 text-[13px] text-danger-ink">
                            {shareError}
                        </p>
                    )}

                    {/* Icons, not labels. Six text buttons do not fit a 375px
                        phone, which is why the previous bar scrolled sideways —
                        and it is the same reason every call app uses icons. */}
                    <div className="absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/80 p-2 shadow-bar">
                        <button
                            type="button" className="ctrl-btn" aria-pressed={!micOn}
                            onClick={toggleMic} title={micOn ? "Mute" : "Unmute"}
                            aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
                        >
                            {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                        </button>

                        <button
                            type="button" className="ctrl-btn" aria-pressed={!camOn}
                            onClick={toggleCam} disabled={sharing}
                            title={sharing ? "Stop sharing to use your camera" : camOn ? "Turn camera off" : "Turn camera on"}
                            aria-label={camOn ? "Turn camera off" : "Turn camera on"}
                        >
                            {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
                        </button>

                        <button
                            type="button" className="ctrl-btn" aria-pressed={sharing}
                            onClick={() => (sharing ? stopShare() : startShare())}
                            title={sharing ? "Stop sharing" : "Share your screen"}
                            aria-label={sharing ? "Stop sharing screen" : "Share screen"}
                        >
                            {sharing ? <MonitorX className="h-5 w-5" /> : <MonitorUp className="h-5 w-5" />}
                        </button>

                        {/* Shown even where it cannot work, disabled and with the
                            reason on the tooltip.

                            It used to be hidden entirely on a test room, which is
                            the only kind of room anyone has been able to make so
                            far — so chat looked simply absent from the product,
                            and the first report was "chat screen missing". A
                            control that explains why it is unavailable is worth
                            more than one that vanishes. */}
                        <button
                            type="button" className="ctrl-btn" aria-pressed={chatOpen}
                            onClick={() => { setChatOpen(o => !o); setHealthOpen(false); setSettingsOpen(false); }}
                            disabled={!preview?.booking_id}
                            title={preview?.booking_id ? "Chat" : "Chat needs a real booking — a test session has no message thread"}
                            aria-label="Chat"
                        >
                            <MessageSquare className="h-5 w-5" />
                        </button>

                        {preview?.you_are === "trainer" ? (
                            <button
                                type="button" className="ctrl-btn" aria-pressed={healthOpen}
                                onClick={() => { setHealthOpen(o => !o); setChatOpen(false); setSettingsOpen(false); }}
                                disabled={!preview?.booking_id}
                                title={preview?.booking_id ? "Client health record" : "Needs a real booking — a test session has no client"}
                                aria-label="Client health record"
                            >
                                <ClipboardList className="h-5 w-5" />
                            </button>
                        ) : null}

                        <button
                            type="button" className="ctrl-btn" aria-pressed={settingsOpen}
                            onClick={() => { setSettingsOpen(o => !o); setChatOpen(false); setHealthOpen(false); }}
                            title="Camera and microphone" aria-label="Camera and microphone"
                        >
                            <Settings className="h-5 w-5" />
                        </button>

                        <button
                            type="button" className="ctrl-btn ctrl-btn-danger"
                            onClick={() => leave()} title="End call" aria-label="End call"
                        >
                            <PhoneOff className="h-5 w-5" />
                            <span className="hidden text-[13.5px] font-medium sm:inline">End</span>
                        </button>
                    </div>
                </section>
            )}

            {view === "message" && message && (
                <section className="view">
                    <div className="card">
                        <h1>{message.title}</h1>
                        {message.body && <p className="muted">{message.body}</p>}
                        {message.retry && (
                            <button type="button" onClick={loadPreview}>Try again</button>
                        )}
                    </div>
                </section>
            )}
        </main>
    );
}

function timeOf(value: string) {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
