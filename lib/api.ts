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
        // A network failure and a refusal are different things and have to read
        // differently. "Check your connection" is useless advice when the real
        // answer is "your booking was cancelled".
        return {
            ok: false,
            status: 0,
            data: { message: "Could not reach XPRTO. Check your connection." },
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
