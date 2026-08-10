/**
 * Talking to the XPRTO API.
 *
 * This page is on a different registrable domain from xprto.com on purpose, so
 * the `s_id` cookie is never sent here. Everything goes through a bearer token
 * held in memory — see SessionRoom for why not localStorage.
 */

export const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE?.replace(/\/+$/, "") || "https://api.xprto.com";

export type Warning = {
    title: string;
    lead: string;
    points: string[];
    footer: string;
    consent: string;
};

export type Preview = {
    /** Absent on test rooms, which have no booking and therefore no chat thread. */
    booking_id?: number | null;
    booking_code: string | null;
    service: string | null;
    you_are: "client" | "trainer" | "admin" | "guest";
    opens_at: string | null;
    closes_at: string | null;
    can_join: boolean;
    reason: string | null;
    is_test?: boolean;
    warning: Warning;
};

export type Credentials = {
    app_id: string;
    channel: string;
    token: string;
    uid: number;
    expires_in: number;
    peer_uid: number | null;
};

export type ApiResult<T> = {
    ok: boolean;
    status: number;
    data: { success?: boolean; message?: string; result?: T };
};

/** Where this page is actually being served from — see the failure message. */
function origin() {
    return typeof window === "undefined" ? "this page" : window.location.origin;
}

export async function api<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    try {
        const res = await fetch(`${API_BASE}${path}`, {
            method: options.method || "GET",
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });

        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    } catch {
        /**
         * fetch throws for two very different reasons, and they look identical
         * from here: the device is offline, or the browser refused the request
         * before sending it — which is what a CORS rejection is.
         *
         * The first version of this said "check your connection" for both, and
         * that cost real time: the page was deployed to a Vercel URL that was
         * not in the API's allowlist, so every request was blocked at the
         * browser and the message sent everyone looking at the wi-fi.
         *
         * navigator.onLine is not a reliable "you have internet" — it only
         * knows whether an interface is up — but it IS reliable in the negative
         * direction, which is the one that matters. If the browser says it is
         * online, the connection is not the story.
         */
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;

        return {
            ok: false,
            status: 0,
            data: {
                message: offline
                    ? "You appear to be offline. Check your connection and try again."
                    // The page's OWN origin, named. Two rounds were spent
                    // guessing which hostname the browser was sending — a
                    // deployed page can answer on a project URL, a branch URL,
                    // a commit URL or the real domain, and only one of those is
                    // usually in an allowlist. The message that says "this page
                    // is X and X was refused" ends that in one screenshot.
                    : `Could not reach ${API_BASE} from ${origin()}. If this keeps happening, ${origin()} is probably not in the API's allowed origins.`,
            },
        };
    }
}

/**
 * Room endpoints. Test rooms live under a different prefix but answer the same
 * shapes, so the caller only has to know which kind it is holding.
 */
export function roomPath(slug: string, isTest: boolean, suffix = "") {
    const base = isTest ? "/v1/account/live/test/" : "/v1/account/live/";
    return `${base}${encodeURIComponent(slug)}${suffix}`;
}
