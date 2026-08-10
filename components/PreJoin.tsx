"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ICameraVideoTrack, IMicrophoneAudioTrack } from "agora-rtc-sdk-ng";
import { Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";

/**
 * The screen before the call.
 *
 * WHY IT EARNS ITS PLACE
 *
 * "My camera isn't working" is the most common thing that goes wrong in a video
 * call, and without this screen it goes wrong *during* a session someone has
 * paid for, with an expert watching and the clock running. Here it costs
 * nothing: you see yourself, you pick a different device, you fix it before
 * anyone is waiting.
 *
 * The mic meter is there for the failure people cannot otherwise detect. A dead
 * camera is obvious — a black rectangle. A dead microphone looks exactly like a
 * working one, and you only learn about it when the other person says they
 * cannot hear you. A bar that moves when you speak is the whole diagnosis.
 *
 * THE TRACKS ARE HANDED UPWARD, NOT RECREATED
 *
 * Whatever is previewing here is what gets published. Creating fresh tracks on
 * join would discard the device the user just chose, and would ask for camera
 * permission a second time on some browsers.
 */

export type ReadyTracks = {
    mic: IMicrophoneAudioTrack | null;
    cam: ICameraVideoTrack | null;
    micOn: boolean;
    camOn: boolean;
};

type Device = { label: string; deviceId: string };

export function PreJoin({
    peerLabel,
    joining,
    error,
    onJoin,
}: {
    peerLabel: string;
    joining: boolean;
    error: string | null;
    onJoin: (tracks: ReadyTracks) => void;
}) {
    const preview = useRef<HTMLDivElement | null>(null);
    const mic = useRef<IMicrophoneAudioTrack | null>(null);
    const cam = useRef<ICameraVideoTrack | null>(null);
    const meterTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const [ready, setReady] = useState(false);
    const [denied, setDenied] = useState(false);
    const [deviceError, setDeviceError] = useState<string | null>(null);

    const [cameras, setCameras] = useState<Device[]>([]);
    const [mics, setMics] = useState<Device[]>([]);
    const [cameraId, setCameraId] = useState("");
    const [micId, setMicId] = useState("");

    /** Set when the tracks are handed to the call, so cleanup leaves them alone. */
    const handedOver = useRef(false);

    const [micOn, setMicOn] = useState(true);
    const [camOn, setCamOn] = useState(true);
    const [level, setLevel] = useState(0);

    /** Create the tracks once, then list devices — listing first returns empty
     *  labels until permission has been granted, which makes the pickers useless. */
    const start = useCallback(async () => {
        setDeviceError(null);
        try {
            const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;

            const [micTrack, camTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
            mic.current = micTrack;
            cam.current = camTrack;
            if (preview.current) camTrack.play(preview.current);

            const [cams, micList] = await Promise.all([
                AgoraRTC.getCameras(),
                AgoraRTC.getMicrophones(),
            ]);
            setCameras(cams.map(d => ({ label: d.label || "Camera", deviceId: d.deviceId })));
            setMics(micList.map(d => ({ label: d.label || "Microphone", deviceId: d.deviceId })));
            setCameraId(camTrack.getTrackLabel() ? cams[0]?.deviceId ?? "" : "");
            setMicId(micList[0]?.deviceId ?? "");

            // 100ms is smooth enough to look live without being a busy loop.
            meterTimer.current = setInterval(() => {
                setLevel(mic.current?.getVolumeLevel?.() ?? 0);
            }, 100);

            setReady(true);
        } catch (err) {
            const name = (err as { name?: string })?.name;
            if (name === "NotAllowedError" || name === "PermissionDeniedError") setDenied(true);
            else setDeviceError("Could not start your camera or microphone.");
        }
    }, []);

    useEffect(() => {
        start();
        return () => {
            if (meterTimer.current) clearInterval(meterTimer.current);

            // Closed unless the call took them.
            //
            // They used to be left open unconditionally, on the reasoning that
            // the call owns them — true only if the person actually joins.
            // Walking away from this screen left the camera light on until the
            // tab was closed, which reasonably reads as being recorded.
            if (handedOver.current) return;
            mic.current?.close();
            cam.current?.close();
            mic.current = null;
            cam.current = null;
        };
    }, [start]);

    /**
     * A Bluetooth headset connected after the page opened.
     *
     * Reported from a real call: it worked for one person and not the other.
     * The difference is timing, not the headset. Tracks bind to whichever
     * microphone was default when they were created, so pairing earbuds
     * afterwards changes the system default and changes nothing about the call
     * — the browser keeps using the built-in mic, and the person hears
     * themselves fine while sounding wrong to everybody else.
     *
     * Agora reports the plug event. On ACTIVE — a device appearing — switch to
     * it, because someone who just put earbuds in means to use them. On
     * INACTIVE — the device going away — fall back to whatever is left, or the
     * call goes silent when a headset's battery dies mid-session.
     */
    useEffect(() => {
        let cancelled = false;

        (async () => {
            const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
            if (cancelled) return;

            AgoraRTC.onMicrophoneChanged = async changed => {
                const list = await AgoraRTC.getMicrophones();
                setMics(list.map(d => ({ label: d.label || "Microphone", deviceId: d.deviceId })));

                const target = changed.state === "ACTIVE"
                    ? changed.device
                    : list[0];
                if (!target) return;

                try {
                    await mic.current?.setDevice(target.deviceId);
                    setMicId(target.deviceId);
                } catch {
                    setDeviceError("A microphone was connected but could not be selected.");
                }
            };

            AgoraRTC.onCameraChanged = async changed => {
                const list = await AgoraRTC.getCameras();
                setCameras(list.map(d => ({ label: d.label || "Camera", deviceId: d.deviceId })));

                // Only on removal. A camera appearing should not yank the view
                // away from the one someone deliberately chose — a microphone
                // is different, because you cannot see which one is live.
                if (changed.state === "INACTIVE" && list[0]) {
                    try {
                        await cam.current?.setDevice(list[0].deviceId);
                        setCameraId(list[0].deviceId);
                    } catch { /* the preview shows the failure */ }
                }
            };
        })();

        return () => { cancelled = true; };
    }, []);

    async function switchCamera(deviceId: string) {
        setCameraId(deviceId);
        try { await cam.current?.setDevice(deviceId); } catch { setDeviceError("Could not switch camera."); }
    }

    async function switchMic(deviceId: string) {
        setMicId(deviceId);
        try { await mic.current?.setDevice(deviceId); } catch { setDeviceError("Could not switch microphone."); }
    }

    function toggleMic() {
        const next = !micOn;
        mic.current?.setEnabled(next);
        setMicOn(next);
    }

    function toggleCam() {
        const next = !camOn;
        cam.current?.setEnabled(next);
        setCamOn(next);
    }

    if (denied) {
        return (
            <div className="mx-auto w-full max-w-md p-6">
                <h1 className="text-[20px] font-semibold tracking-tight">XPRTO needs your camera and microphone</h1>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
                    Allow access in your browser, then try again. On iPhone, Safari
                    asks every time you open a session.
                </p>
                <button type="button" onClick={() => { setDenied(false); start(); }} className="btn-primary mt-5">
                    Try again
                </button>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-md p-6">
            <h1 className="text-[20px] font-semibold tracking-tight">Ready to join?</h1>
            <p className="mt-1 text-[14px] text-ink-muted">
                Check yourself before {peerLabel.toLowerCase()} sees you.
            </p>

            {/* The preview is the point of the screen, so it gets the space. */}
            <div className="relative mt-4 aspect-video w-full overflow-hidden rounded-xl2 border-2 border-white bg-stage">
                <div ref={preview} className="absolute inset-0 [&>div]:!h-full [&>div]:!w-full [&_video]:!h-full [&_video]:!w-full [&_video]:object-cover" />

                {!ready && (
                    <div className="absolute inset-0 grid place-items-center">
                        <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                    </div>
                )}

                {ready && !camOn && (
                    <div className="absolute inset-0 grid place-items-center bg-stage">
                        <VideoOff className="h-8 w-8 text-white/50" />
                    </div>
                )}

                <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
                    <button type="button" className="ctrl-btn" aria-pressed={!micOn} onClick={toggleMic}
                        aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
                        {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                    </button>
                    <button type="button" className="ctrl-btn" aria-pressed={!camOn} onClick={toggleCam}
                        aria-label={camOn ? "Turn camera off" : "Turn camera on"}>
                        {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
                    </button>
                </div>
            </div>

            {/* A dead microphone looks exactly like a working one. This is the
                only way to know before somebody tells you they cannot hear you. */}
            <div className="mt-4">
                <div className="flex items-center gap-2">
                    <Mic className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-line" role="meter"
                        aria-label="Microphone level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
                        <div
                            className="h-full rounded-full bg-success transition-[width] duration-75"
                            style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
                        />
                    </div>
                </div>
                <p className="mt-1.5 text-[12.5px] text-ink-subtle">
                    {micOn ? "Say something — the bar should move." : "Your microphone is off."}
                </p>
            </div>

            {cameras.length > 1 && (
                <label className="mt-4 block text-[13px] font-medium">
                    Camera
                    <select className="field mt-1.5" value={cameraId} onChange={e => switchCamera(e.target.value)}>
                        {cameras.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                    </select>
                </label>
            )}

            {mics.length > 1 && (
                <label className="mt-3 block text-[13px] font-medium">
                    Microphone
                    <select className="field mt-1.5" value={micId} onChange={e => switchMic(e.target.value)}>
                        {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                    </select>
                </label>
            )}

            {(deviceError || error) && <p className="mt-3 text-[14px] text-danger">{deviceError || error}</p>}

            <button
                type="button"
                className="btn-primary mt-5"
                disabled={!ready || joining}
                onClick={() => {
                    handedOver.current = true;
                    onJoin({ mic: mic.current, cam: cam.current, micOn, camOn });
                }}
            >
                {joining ? "Joining…" : "Join now"}
            </button>
        </div>
    );
}
