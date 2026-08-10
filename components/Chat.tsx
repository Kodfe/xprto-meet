"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * In-call chat, written to XPRTO's own thread.
 *
 * WHY NOT THE VIDEO SDK'S MESSAGING
 *
 * The plan was to send chat over the RTC data stream. That turned out not to
 * exist: agora-rtc-sdk-ng 4.24 can RECEIVE stream-message but exposes no send
 * API. Agora RTM would have worked — a second SDK and a second token type.
 *
 * This is better than both, and not only because it is cheaper. XPRTO already
 * has 1:1 chat between a client and their trainer, and POST
 * /chat-rooms/:booking_id/chats resolves a booking to that room, creating it on
 * first use. So messages sent during a call:
 *
 *   - are still there when the call ends, in the thread both people already
 *     use in the app, rather than vanishing with the room;
 *   - land somewhere XPRTO can audit. A phone number pasted into an ephemeral
 *     video-SDK chat is gone. Pasted here, it is evidence — which is the whole
 *     point of the off-platform warning both sides just agreed to.
 *
 * POLLING, NOT A SOCKET
 *
 * There is a WebSocket server, but its auth is built around the cookie this
 * origin deliberately does not receive. Five seconds is unnoticeable next to
 * two people who can see and hear each other, and it removes a reconnection
 * path that would need its own handling on a flaky mobile connection. Worth
 * revisiting when the app issues signed join links and this page gets a proper
 * identity.
 */

type Message = {
    chat_id?: number;
    message_id?: number;
    text?: string;
    message?: string;
    user_id?: number;
    user_role?: string;
    sender_role?: string;
    created_at?: string;
};

const POLL_MS = 5000;

export function Chat({
    bookingId,
    token,
    myRole,
    onClose,
}: {
    bookingId: number;
    token: string | null;
    myRole: string;
    onClose: () => void;
}) {
    const [messages, setMessages] = useState<Message[] | null>(null);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        const res = await api<Message[]>(`/v1/account/chat-rooms/${bookingId}/chats?limit=50`, { token });

        if (!res.ok) {
            // Only surfaced on the first load. A failed poll mid-conversation
            // should not replace messages already on screen with an error.
            setMessages(prev => (prev === null ? [] : prev));
            setError(prev => prev ?? (res.data.message || "Could not load messages."));
            return;
        }

        const body = res.data as { result?: Message[]; data?: Message[] };
        const list = body.result ?? body.data ?? [];
        // Oldest first: the endpoint paginates newest-first, which reads
        // backwards in a chat window.
        setMessages([...list].reverse());
        setError(null);
    }, [bookingId, token]);

    useEffect(() => {
        load();
        const timer = setInterval(load, POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    // Follow the conversation as it grows.
    useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }, [messages]);

    async function send(event: React.FormEvent) {
        event.preventDefault();
        const text = draft.trim();
        if (!text || sending) return;

        setSending(true);
        const res = await api(`/v1/account/chat-rooms/${bookingId}/chats`, {
            method: "POST",
            token,
            body: { text, message_type: "text" },
        });
        setSending(false);

        if (!res.ok) {
            setError(res.data.message || "Could not send that message.");
            return;
        }

        setDraft("");
        setError(null);
        load();
    }

    return (
        <aside className="chat" aria-label="Chat">
            <header className="chat-head">
                <span>Chat</span>
                <button type="button" onClick={onClose} aria-label="Close chat" className="chat-close">×</button>
            </header>

            <div ref={listRef} className="chat-list">
                {messages === null ? (
                    <p className="chat-empty">Loading…</p>
                ) : messages.length === 0 ? (
                    <p className="chat-empty">
                        No messages yet. Anything sent here stays in your XPRTO chat after the session.
                    </p>
                ) : (
                    messages.map((m, i) => {
                        const role = m.user_role || m.sender_role || "";
                        const mine = role === myRole;
                        return (
                            <p key={m.chat_id ?? m.message_id ?? i} className={mine ? "msg mine" : "msg"}>
                                {m.text || m.message}
                            </p>
                        );
                    })
                )}
            </div>

            {error && <p className="chat-error">{error}</p>}

            <form className="chat-form" onSubmit={send}>
                <input
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder="Message"
                    aria-label="Message"
                    maxLength={2000}
                />
                <button type="submit" disabled={sending || !draft.trim()}>Send</button>
            </form>
        </aside>
    );
}
