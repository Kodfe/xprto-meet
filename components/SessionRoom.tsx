"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
    IAgoraRTCClient, IAgoraRTCRemoteUser, ICameraVideoTrack, IMicrophoneAudioTrack,
} from "agora-rtc-sdk-ng";
import { api, roomPath, type Credentials, type Preview } from "@/lib/api";

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

type View = "loading" | "signin" | "warning" | "room" | "message";

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

    const [micOn, setMicOn] = useState(true);
    const [camOn, setCamOn] = useState(true);
    const [peerVideo, setPeerVideo] = useState(false);
    const [peerNote, setPeerNote] = useState("Waiting for the other person to join…");

    const localBox = useRef<HTMLDivElement | null>(null);
    const remoteBox = useRef<HTMLDivElement | null>(null);

    const leave = useCallback(async (reason?: string) => {
        if (renewTimer.current) clearTimeout(renewTimer.current);

        for (const ref of [mic, cam]) {
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

    async function join() {
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
                if (kind === "video" && remoteBox.current) {
                    setPeerVideo(true);
                    user.videoTrack?.play(remoteBox.current);
                }
                if (kind === "audio") user.audioTrack?.play();
                setStatus("Connected");
            });

            rtc.on("user-unpublished", (_user, kind) => {
                if (kind === "video") {
                    setPeerVideo(false);
                    setPeerNote("Their camera is off.");
                }
            });

            rtc.on("user-left", () => {
                setPeerVideo(false);
                setPeerNote("They have left the session.");
                setStatus("They left");
            });

            await rtc.join(credentials.app_id, credentials.channel, credentials.token, credentials.uid);
            joined.current = true;
            scheduleRenewal(credentials.expires_in);

            const [micTrack, camTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
            mic.current = micTrack;
            cam.current = camTrack;
            if (localBox.current) camTrack.play(localBox.current);
            await rtc.publish([micTrack, camTrack]);
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

    function toggleMic() {
        if (!mic.current) return;
        const next = !micOn;
        mic.current.setEnabled(next);
        setMicOn(next);
    }

    function toggleCam() {
        if (!cam.current) return;
        const next = !camOn;
        cam.current.setEnabled(next);
        setCamOn(next);
    }

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
                    <div className="card"><p className="muted">Checking this session…</p></div>
                </section>
            )}

            {view === "signin" && (
                <section className="view">
                    <div className="card">
                        <h1>Sign in to join</h1>
                        <p className="muted">Use the same XPRTO account you booked with.</p>
                        <form onSubmit={signIn} noValidate>
                            <label htmlFor="email">Email</label>
                            <input id="email" name="email" type="email" autoComplete="username" required />

                            <label htmlFor="password">Password</label>
                            <input id="password" name="password" type="password" autoComplete="current-password" required />

                            <label htmlFor="role">I am the</label>
                            <select id="role" name="role" defaultValue="client">
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

            {view === "warning" && preview && (
                <section className="view">
                    <div className="card">
                        <h1>{preview.warning.title}</h1>
                        <p className="muted">{preview.service || "XPRTO session"}</p>

                        {/* The hard warning. Written per role on the server — the
                            expert and the client lose entirely different things
                            when a session moves off the platform, so they are not
                            shown the same words. */}
                        <div className="notice">
                            <p className="lead">{preview.warning.lead}</p>
                            <ul>
                                {preview.warning.points.map((point, i) => <li key={i}>{point}</li>)}
                            </ul>
                        </div>

                        <ul className="facts">
                            {preview.opens_at && preview.closes_at && (
                                <li>
                                    Open from {timeOf(preview.opens_at)} until {timeOf(preview.closes_at)}.
                                </li>
                            )}
                            <li>{preview.warning.footer}</li>
                        </ul>

                        <label className="check">
                            <input
                                type="checkbox"
                                checked={agreed}
                                disabled={!preview.can_join}
                                onChange={e => setAgreed(e.target.checked)}
                            />
                            <span>{preview.warning.consent}</span>
                        </label>

                        {joinError && <p className="error">{joinError}</p>}

                        <button type="button" disabled={!agreed || !preview.can_join || joining} onClick={join}>
                            {!preview.can_join ? "Not open yet" : joining ? "Joining…" : "Join session"}
                        </button>
                    </div>
                </section>
            )}

            {view === "room" && (
                <section className="view room">
                    <div className="stage">
                        <div ref={remoteBox} className="tile remote">
                            {!peerVideo && <p className="waiting">{peerNote}</p>}
                        </div>
                        <div ref={localBox} className="tile local" />
                    </div>

                    <div className="controls">
                        <button type="button" className="ctrl" aria-pressed={!micOn} onClick={toggleMic}>
                            {micOn ? "Mute" : "Unmute"}
                        </button>
                        <button type="button" className="ctrl" aria-pressed={!camOn} onClick={toggleCam}>
                            {camOn ? "Camera off" : "Camera on"}
                        </button>
                        <button type="button" className="ctrl danger" onClick={() => leave()}>
                            End call
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
