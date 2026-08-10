"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Sign in with Google.
 *
 * Uses Google Identity Services, which hands back an ID token that the API
 * verifies against Google directly (POST /v1/auth/google/login, which calls
 * oauth2.googleapis.com/tokeninfo before trusting anything). So nothing here is
 * trusted on the client's word — this component's whole job is to obtain that
 * token and pass it on.
 *
 * WHY IT DISAPPEARS WHEN UNCONFIGURED
 *
 * It needs NEXT_PUBLIC_GOOGLE_CLIENT_ID. Rendering a Google button that cannot
 * work is worse than not offering it: someone who signed up with Google will
 * try it, fail, and conclude their account is broken rather than that the
 * button is. Absent config, absent button.
 *
 * The client ID is public by design — it identifies the app to Google, it does
 * not authorise anything. It is not a secret and does not belong in .env on the
 * droplet with the ones that are.
 */

declare global {
    interface Window {
        google?: {
            accounts: {
                id: {
                    initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void;
                    renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
                };
            };
        };
    }
}

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

export function GoogleSignIn({
    role,
    onSignedIn,
    onError,
}: {
    role: string;
    onSignedIn: (token: string) => void;
    onError: (message: string) => void;
}) {
    const holder = useRef<HTMLDivElement | null>(null);
    const cleanup = useRef<(() => void) | null>(null);
    const [ready, setReady] = useState(false);

    // The role can change (the dropdown above this) after Google has been
    // initialised, and the callback closes over it — so it is read from a ref
    // at call time rather than baked in when the button was drawn.
    const currentRole = useRef(role);
    currentRole.current = role;

    useEffect(() => {
        if (!CLIENT_ID) return;

        function draw() {
            if (!window.google || !holder.current) return;

            window.google.accounts.id.initialize({
                client_id: CLIENT_ID!,
                callback: async (response) => {
                    const res = await api("/v1/auth/google/login", {
                        method: "POST",
                        body: { idToken: response.credential, role: currentRole.current },
                    });

                    const body = res.data as { s_id?: string; token?: string; message?: string };
                    const issued = body.s_id || body.token;

                    if (!res.ok || !issued) {
                        onError(body.message || "Could not sign in with Google.");
                        return;
                    }
                    onSignedIn(issued);
                },
            });

            /**
             * Width measured, not guessed.
             *
             * It was hardcoded to 320 inside a column about 364 wide, so the
             * button stopped short of the fields below it and read as
             * misaligned. Google renders into a fixed-width iframe and will not
             * accept a percentage, so the only way to match the form is to
             * measure the container — and 400 is the maximum it allows.
             */
            const width = Math.min(400, Math.floor(holder.current.getBoundingClientRect().width) || 320);

            window.google.accounts.id.renderButton(holder.current, {
                theme: "outline",
                size: "large",
                width,
                text: "signin_with",
            });
            setReady(true);
        }

        if (window.google) {
            draw();
        }

        // Redraw on resize: the iframe keeps whatever width it was given, so a
        // rotate or a window drag would otherwise leave it mismatched again.
        const observer = new ResizeObserver(() => { if (window.google) draw(); });
        if (holder.current) observer.observe(holder.current);
        cleanup.current = () => observer.disconnect();

        // Both paths return the same cleanup — an early `return` here would skip
        // it and leave the observer attached for the life of the page.
        if (window.google) return () => { cleanup.current?.(); };

        // Loaded here rather than in the document head so the script is only
        // fetched on a page that offers the button, and never on the session
        // page of someone already signed in.
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = draw;
        script.onerror = () => onError("Could not load Google sign-in.");
        document.head.appendChild(script);

        return () => { cleanup.current?.(); };
    }, [onSignedIn, onError]);

    if (!CLIENT_ID) return null;

    return (
        <div className="google">
            <div ref={holder} className="w-full" />
            {!ready && <p className="muted small">Loading Google sign-in…</p>}
            <p className="or">or</p>
        </div>
    );
}
