"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ICameraVideoTrack, IMicrophoneAudioTrack } from "agora-rtc-sdk-ng";
import { Mic, X } from "lucide-react";

/**
 * Devices, during the call.
 *
 * The pre-join screen already picks a camera and microphone, and that covered
 * everything except the case people actually hit: putting earbuds in *after*
 * the call has started. Tracks bind to whichever device was default when they
 * were created, so pairing a headset mid-call changes the system default and
 * changes nothing about the call — the person hears themselves fine and sounds
 * wrong to everyone else, which is why it gets reported as "works for me".
 *
 * Two halves to the fix. This panel, so it can always be corrected by hand; and
 * the listener in the call itself, so it usually does not have to be.
 *
 * The meter is here for the same reason it is on the pre-join screen: a dead
 * microphone is invisible. Switching device without being able to confirm the
 * new one works just moves the guesswork.
 */

type Device = { label: string; deviceId: string };

export function DeviceSettings({
    mic,
    cam,
    onClose,
}: {
    mic: IMicrophoneAudioTrack | null;
    cam: ICameraVideoTrack | null;
    onClose: () => void;
}) {
    const [cameras, setCameras] = useState<Device[]>([]);
    const [mics, setMics] = useState<Device[]>([]);
    const [cameraId, setCameraId] = useState("");
    const [micId, setMicId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [level, setLevel] = useState(0);
    const meter = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
        const [cams, micList] = await Promise.all([AgoraRTC.getCameras(), AgoraRTC.getMicrophones()]);

        setCameras(cams.map(d => ({ label: d.label || "Camera", deviceId: d.deviceId })));
        setMics(micList.map(d => ({ label: d.label || "Microphone", deviceId: d.deviceId })));

        // Which device is live, asked of the track rather than remembered.
        // A device swapped by the auto-switch listener would leave a remembered
        // value pointing at the wrong row.
        const camLabel = cam?.getTrackLabel?.();
        const micLabel = mic?.getTrackLabel?.();
        setCameraId(cams.find(d => d.label === camLabel)?.deviceId ?? cams[0]?.deviceId ?? "");
        setMicId(micList.find(d => d.label === micLabel)?.deviceId ?? micList[0]?.deviceId ?? "");
    }, [cam, mic]);

    useEffect(() => {
        refresh();
        meter.current = setInterval(() => setLevel(prev => {
            const next = Math.round((mic?.getVolumeLevel?.() ?? 0) * 20) / 20;
            return next === prev ? prev : next;
        }), 100);
        return () => { if (meter.current) clearInterval(meter.current); };
    }, [refresh, mic]);

    async function switchCamera(deviceId: string) {
        setCameraId(deviceId);
        setError(null);
        try { await cam?.setDevice(deviceId); } catch { setError("Could not switch camera."); }
    }

    async function switchMic(deviceId: string) {
        setMicId(deviceId);
        setError(null);
        try { await mic?.setDevice(deviceId); } catch { setError("Could not switch microphone."); }
    }

    return (
        <aside className="chat" aria-label="Devices">
            <header className="chat-head">
                <span>Devices</span>
                <button type="button" onClick={onClose} aria-label="Close" className="chat-close">
                    <X className="h-4 w-4" />
                </button>
            </header>

            <div className="chat-list">
                <label className="block text-[12.5px] font-semibold uppercase tracking-[0.05em] text-ink-muted">
                    Microphone
                    <select className="field mt-1.5 normal-case tracking-normal" value={micId}
                        onChange={e => switchMic(e.target.value)}>
                        {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                    </select>
                </label>

                <div className="mt-3 flex items-center gap-2">
                    <Mic className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-line" role="meter"
                        aria-label="Microphone level" aria-valuenow={Math.round(level * 100)}
                        aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full rounded-full bg-success transition-[width] duration-75"
                            style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
                    </div>
                </div>
                <p className="mt-1.5 text-[12.5px] text-ink-subtle">Say something — the bar should move.</p>

                <label className="mt-5 block text-[12.5px] font-semibold uppercase tracking-[0.05em] text-ink-muted">
                    Camera
                    <select className="field mt-1.5 normal-case tracking-normal" value={cameraId}
                        onChange={e => switchCamera(e.target.value)}>
                        {cameras.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                    </select>
                </label>

                {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

                <p className="mt-5 text-[12.5px] leading-relaxed text-ink-subtle">
                    Headphones connected during a call are switched to automatically.
                    If that did not happen, pick them here.
                </p>
            </div>
        </aside>
    );
}
