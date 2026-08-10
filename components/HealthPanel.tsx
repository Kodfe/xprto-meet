"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * The client's health record, during the session. Trainer only.
 *
 * HEALTH DATA, AND NOTHING ELSE
 *
 * No name, no email, no phone, no address. The endpoint does not send them, so
 * this cannot show them even by accident — which is the point of masking on the
 * server rather than here.
 *
 * READ, THEN WRITE
 *
 * The last five measurements, most recent first, and a form to add one. It adds
 * a new record rather than editing the last: weight on the 12th and weight on
 * the 19th are two facts, not one fact corrected, and the progress is what the
 * client is paying to see. Saved rows appear in the app immediately — same
 * table the app's own health screen reads.
 */

type Condition = Record<string, string | number | null>;

type Health = {
    health_goal: string | null;
    gender: string | null;
    conditions: Condition[];
    muscles: Condition[];
};

/** Only the fields worth typing mid-call. The app has the full form. */
const FIELDS: { name: string; label: string; unit?: string }[] = [
    { name: "weight_kg", label: "Weight", unit: "kg" },
    { name: "fat_kg", label: "Body fat", unit: "kg" },
    { name: "skeletal_muscle_percent", label: "Muscle", unit: "%" },
    { name: "heart_rate", label: "Heart rate", unit: "bpm" },
    { name: "blood_pressure_systolic", label: "BP systolic" },
    { name: "blood_pressure_diastolic", label: "BP diastolic" },
];

export function HealthPanel({
    slug,
    token,
    onClose,
}: {
    slug: string;
    token: string | null;
    onClose: () => void;
}) {
    const [health, setHealth] = useState<Health | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        const res = await api<Health>(`/v1/account/live/${encodeURIComponent(slug)}/health`, { token });
        if (!res.ok || !res.data.result) {
            setError(res.data.message || "Could not load the health record.");
            return;
        }
        setHealth(res.data.result);
        setError(null);
    }, [slug, token]);

    useEffect(() => { load(); }, [load]);

    async function save(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body: Record<string, string> = {};
        for (const field of FIELDS) {
            const value = String(form.get(field.name) || "").trim();
            if (value) body[field.name] = value;
        }
        const remarks = String(form.get("remarks") || "").trim();
        if (remarks) body.remarks = remarks;

        setSaving(true);
        const res = await api(`/v1/account/live/${encodeURIComponent(slug)}/health`, {
            method: "POST",
            token,
            body,
        });
        setSaving(false);

        if (!res.ok) {
            setError(res.data.message || "Could not save.");
            return;
        }

        setError(null);
        setSaved(true);
        setAdding(false);
        setTimeout(() => setSaved(false), 3000);
        load();
    }

    const latest = health?.conditions?.[0];

    return (
        <aside className="chat" aria-label="Client health record">
            <header className="chat-head">
                <span>Health record</span>
                <button type="button" onClick={onClose} aria-label="Close" className="chat-close">×</button>
            </header>

            <div className="chat-list">
                {error && <p className="chat-error">{error}</p>}

                {!health ? (
                    <p className="chat-empty">Loading…</p>
                ) : (
                    <>
                        <dl className="health-facts">
                            {health.health_goal && <Fact label="Goal" value={health.health_goal} />}
                            {health.gender && <Fact label="Gender" value={health.gender} />}
                            {latest?.height_cm != null && <Fact label="Height" value={`${latest.height_cm} cm`} />}
                        </dl>

                        {health.conditions.length === 0 ? (
                            <p className="chat-empty">
                                No measurements recorded yet. Anything you add here appears in
                                their app straight away.
                            </p>
                        ) : (
                            <>
                                <h3 className="health-head">Recent measurements</h3>
                                {health.conditions.map((c, i) => (
                                    <div key={String(c.health_id ?? i)} className="health-row">
                                        <p className="health-when">{dateOf(c.created_at)}</p>
                                        <p className="health-values">
                                            {FIELDS
                                                .filter(f => c[f.name] != null && c[f.name] !== "")
                                                .map(f => `${f.label} ${c[f.name]}${f.unit ? ` ${f.unit}` : ""}`)
                                                .join(" · ") || "No values"}
                                        </p>
                                        {c.remarks ? <p className="health-remarks">{String(c.remarks)}</p> : null}
                                    </div>
                                ))}
                            </>
                        )}

                        {/* Chronic conditions, medications and allergies are on the
                            most recent record and are the things a trainer must not
                            miss mid-session, so they sit above the form rather than
                            among the numbers. */}
                        {latest && (latest.chronic_diseases || latest.medications || latest.allergies) ? (
                            <div className="health-alert">
                                {latest.allergies ? <p><strong>Allergies:</strong> {String(latest.allergies)}</p> : null}
                                {latest.medications ? <p><strong>Medication:</strong> {String(latest.medications)}</p> : null}
                                {latest.chronic_diseases ? <p><strong>Conditions:</strong> {String(latest.chronic_diseases)}</p> : null}
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            {saved && <p className="health-saved">Saved to their record.</p>}

            {!adding ? (
                <div className="chat-form">
                    <button type="button" onClick={() => setAdding(true)}>Add measurement</button>
                </div>
            ) : (
                <form className="health-form" onSubmit={save}>
                    <div className="health-grid">
                        {FIELDS.map(field => (
                            <label key={field.name}>
                                {field.label}{field.unit ? ` (${field.unit})` : ""}
                                <input name={field.name} type="number" step="any" inputMode="decimal" />
                            </label>
                        ))}
                    </div>
                    <label>
                        Notes
                        <input name="remarks" type="text" maxLength={1000} />
                    </label>
                    <div className="health-actions">
                        <button type="button" onClick={() => setAdding(false)}>Cancel</button>
                        <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                    </div>
                </form>
            )}
        </aside>
    );
}

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function dateOf(value: unknown) {
    if (!value) return "";
    const date = new Date(String(value));
    return Number.isNaN(date.getTime())
        ? String(value)
        : date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
