"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Make a test session link.
 *
 * For the owner, not for engineers: type a name, get a link, copy it, send it.
 * No booking has to exist and nobody has to run curl.
 *
 * WHAT IT IS NOT
 *
 * Not a way to run real sessions. Every room made here admits any signed-in
 * XPRTO account rather than the two people on a booking, which is the property
 * the whole design exists to remove — so the server refuses unless
 * LIVE_TEST_ROOMS=true, and that must be off before launch. The page says so
 * rather than leaving it in a commit message nobody will read.
 */

type Made = { slug: string; url: string; label: string; hours: number };

export function CreateLink() {
    // Same reasoning as the session page: in memory, never localStorage. An
    // admin token left in a browser store on a shared office machine is worth
    // considerably more than a client's.
    const token = useRef<string | null>(null);

    const [signedIn, setSignedIn] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [made, setMade] = useState<Made[]>([]);
    const [copied, setCopied] = useState<string | null>(null);

    async function signIn(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        setBusy(true);
        setError(null);

        const res = await api("/v1/auth/login", {
            method: "POST",
            body: {
                email: String(form.get("email") || "").trim(),
                password: String(form.get("password") || ""),
                role: "admin",
            },
        });

        setBusy(false);
        const body = res.data as { s_id?: string; token?: string; message?: string };
        const issued = body.s_id || body.token;

        if (!res.ok || !issued) {
            setError(body.message || "Could not sign in.");
            return;
        }

        token.current = issued;
        setSignedIn(true);
    }

    async function create(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const label = String(form.get("label") || "").trim() || "Test session";
        const hours = Number(form.get("hours") || 4);

        setBusy(true);
        setError(null);

        const res = await api<{ slug: string; url: string }>("/v1/account/live/test-room", {
            method: "POST",
            token: token.current,
            body: { label, hours },
        });

        setBusy(false);

        if (!res.ok || !res.data.result) {
            setError(
                res.status === 404
                    // The endpoint 404s both when the flag is off and when the
                    // caller is not an admin — deliberately, so it does not
                    // confirm it exists. Which means this page has to explain
                    // both possibilities rather than guess.
                    ? "Test sessions are switched off on the server, or this account is not an admin."
                    : res.data.message || "Could not create the link.",
            );
            return;
        }

        setMade(prev => [{ ...res.data.result!, label, hours }, ...prev]);
    }

    async function copy(url: string) {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(url);
            setTimeout(() => setCopied(null), 2000);
        } catch {
            // Clipboard access is refused on some mobile browsers outside a
            // user gesture, and the link is on screen and selectable anyway.
            setError("Could not copy automatically — select the link and copy it.");
        }
    }

    return (
        <main id="app">
            <header className="bar">
                <span className="brand">XPRTO</span>
                <span className="status">Test links</span>
            </header>

            <section className="view">
                <div className="card">
                    {!signedIn ? (
                        <>
                            <h1>Sign in</h1>
                            <p className="muted">Admin account.</p>
                            <form onSubmit={signIn} noValidate>
                                <label htmlFor="email">Email</label>
                                <input id="email" name="email" type="email" autoComplete="username" required />
                                <label htmlFor="password">Password</label>
                                <input id="password" name="password" type="password" autoComplete="current-password" required />
                                {error && <p className="error">{error}</p>}
                                <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
                            </form>
                        </>
                    ) : (
                        <>
                            <h1>Make a session link</h1>
                            <p className="muted">
                                Anyone with an XPRTO account can open these. For trying things
                                out — not for real sessions.
                            </p>

                            <form onSubmit={create}>
                                <label htmlFor="label">What is it for?</label>
                                <input id="label" name="label" type="text" placeholder="Demo for Rahul" maxLength={120} />

                                <label htmlFor="hours">Works for</label>
                                <select id="hours" name="hours" defaultValue="4">
                                    <option value="1">1 hour</option>
                                    <option value="4">4 hours</option>
                                    <option value="12">12 hours</option>
                                    <option value="24">24 hours</option>
                                </select>

                                {error && <p className="error">{error}</p>}
                                <button type="submit" disabled={busy}>{busy ? "Making…" : "Make link"}</button>
                            </form>

                            {made.length > 0 && (
                                <div className="links">
                                    {made.map(link => (
                                        <div key={link.slug} className="link">
                                            <p className="link-label">{link.label}</p>
                                            {/* Selectable, and shown in full — a truncated URL
                                                is useless when the copy button is the thing
                                                that just failed. */}
                                            <p className="link-url">{link.url}</p>
                                            <button type="button" onClick={() => copy(link.url)}>
                                                {copied === link.url ? "Copied" : "Copy link"}
                                            </button>
                                            <p className="link-note">
                                                Send this to one person. Open it yourself on
                                                another device to be the second. Stops working
                                                after {link.hours} {link.hours === 1 ? "hour" : "hours"}.
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </section>
        </main>
    );
}
