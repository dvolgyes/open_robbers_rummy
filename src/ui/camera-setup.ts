import type { GetUserMedia } from "../call/media";
import type { Translate } from "../i18n";
import { button, el } from "./dom";

export interface CameraSource {
	readonly deviceId: string;
	readonly label: string;
}

export interface CameraDevices {
	enumerate(): Promise<readonly CameraSource[] | undefined>;
	subscribe(listener: () => void): () => void;
}

export interface CameraSelection {
	readonly deviceId: string | undefined;
	readonly track: MediaStreamTrack;
}

export interface CameraSetup {
	readonly element: HTMLDialogElement;
	readonly available: boolean | undefined;
	open(): Promise<CameraSelection | undefined>;
	onChange(listener: () => void): () => void;
	dispose(): void;
}

interface CameraSetupDeps {
	readonly devices: CameraDevices;
	readonly getUserMedia: GetUserMedia;
	readonly t: Translate;
}

export function cameraSetup(deps: CameraSetupDeps): CameraSetup {
	const listeners = new Set<() => void>();
	const title = el(
		"h2",
		{ attrs: { id: "camera-setup-title" } },
		deps.t("Camera preview"),
	);
	const select = el("select", {
		attrs: {
			"aria-label": deps.t("Choose camera"),
			"data-testid": "camera-source",
		},
	});
	select.hidden = true;
	const video = el("video", {
		attrs: {
			"aria-label": deps.t("Camera preview"),
			"data-testid": "camera-preview",
		},
	});
	video.autoplay = true;
	video.muted = true;
	video.playsInline = true;
	const status = el("p", {
		attrs: { role: "status", "data-testid": "camera-preview-status" },
	});
	const cancel = button(deps.t("Cancel"), () => finish(undefined), {
		attrs: { "data-testid": "camera-preview-cancel" },
	});
	const confirm = button(
		deps.t("Send camera"),
		() => {
			const stream = preview;
			const track = stream?.getVideoTracks()[0];
			if (stream === undefined || track?.readyState !== "live") {
				status.textContent = deps.t(
					"The camera preview is no longer available.",
				);
				confirm.disabled = true;
				return;
			}
			finish({ deviceId: selectedDeviceId(), track });
		},
		{ attrs: { "data-testid": "camera-preview-confirm" } },
	);
	confirm.disabled = true;
	const element = el(
		"dialog",
		{
			className: "camera-setup",
			attrs: { "aria-labelledby": title.id, "data-testid": "camera-setup" },
		},
		title,
		select,
		video,
		status,
		el("div", { className: "camera-setup-actions" }, cancel, confirm),
	);

	let available: boolean | undefined;
	let sources: readonly CameraSource[] = [];
	let preview: MediaStream | undefined;
	let sequence = 0;
	let pending: ((selection: CameraSelection | undefined) => void) | undefined;
	let disposed = false;

	const changed = (): void => {
		for (const listener of listeners) listener();
	};

	function selectedDeviceId(): string | undefined {
		return select.value || undefined;
	}

	function stopPreview(): void {
		const stream = preview;
		preview = undefined;
		video.srcObject = null;
		for (const track of stream?.getTracks() ?? []) track.stop();
	}

	function finish(selection: CameraSelection | undefined): void {
		sequence++;
		if (selection === undefined) stopPreview();
		else {
			for (const track of preview?.getTracks() ?? []) {
				if (track !== selection.track) track.stop();
			}
			preview = undefined;
			video.srcObject = null;
		}
		confirm.disabled = true;
		if (element.open) element.close();
		const resolve = pending;
		pending = undefined;
		resolve?.(selection);
	}

	function renderSources(preferredId?: string): void {
		const selected = sources.some((source) => source.deviceId === select.value)
			? select.value
			: preferredId;
		select.replaceChildren();
		for (const [index, source] of sources.entries()) {
			const option = el(
				"option",
				{ attrs: { value: source.deviceId } },
				source.label || deps.t("Camera {number}", { number: index + 1 }),
			);
			select.append(option);
		}
		select.hidden = sources.length < 2;
		if (
			selected !== undefined &&
			sources.some((source) => source.deviceId === selected)
		)
			select.value = selected;
	}

	async function refreshDevices(): Promise<void> {
		try {
			const listed = await deps.devices.enumerate();
			if (listed === undefined) return;
			sources = listed;
			available = listed.length > 0;
			renderSources(preview?.getVideoTracks()[0]?.getSettings().deviceId);
			if (!available && element.open) {
				status.textContent = deps.t("No camera is available.");
				confirm.disabled = true;
			}
			changed();
		} catch {
			available = undefined;
			changed();
		}
	}

	async function startPreview(deviceId?: string): Promise<void> {
		const token = ++sequence;
		stopPreview();
		confirm.disabled = true;
		status.textContent = deps.t("Starting camera preview…");
		const videoConstraints: MediaTrackConstraints = {
			width: 640,
			height: 360,
			frameRate: 15,
			...(deviceId ? { deviceId: { exact: deviceId } } : {}),
		};
		try {
			const stream = await deps.getUserMedia({
				audio: false,
				video: videoConstraints,
			});
			if (disposed || token !== sequence) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			const track = stream.getVideoTracks()[0];
			if (track === undefined || track.readyState !== "live") {
				for (const item of stream.getTracks()) item.stop();
				available = false;
				status.textContent = deps.t("No camera is available.");
				changed();
				return;
			}
			preview = stream;
			video.srcObject = stream;
			track.addEventListener("ended", () => {
				if (preview !== stream) return;
				confirm.disabled = true;
				status.textContent = deps.t(
					"The camera preview is no longer available.",
				);
				void refreshDevices();
			});
			status.textContent = "";
			confirm.disabled = false;
			await refreshDevices();
		} catch (error) {
			if (token !== sequence) return;
			const name = error instanceof DOMException ? error.name : "";
			if (name === "NotFoundError") available = false;
			status.textContent = deps.t(
				name === "NotAllowedError" || name === "SecurityError"
					? "Camera access was denied."
					: name === "NotFoundError"
						? "No camera is available."
						: name === "NotReadableError"
							? "The camera is in use or unavailable."
							: "The camera could not be started.",
			);
			changed();
		}
	}

	const unsubscribe = deps.devices.subscribe(() => void refreshDevices());
	select.addEventListener(
		"change",
		() => void startPreview(selectedDeviceId()),
	);
	element.addEventListener("cancel", (event) => {
		event.preventDefault();
		finish(undefined);
	});
	element.addEventListener("close", () => {
		if (pending !== undefined) finish(undefined);
	});
	void refreshDevices();

	return {
		element,
		get available() {
			return available;
		},
		open() {
			if (disposed || pending !== undefined) return Promise.resolve(undefined);
			status.textContent = deps.t("Starting camera preview…");
			confirm.disabled = true;
			element.showModal();
			const result = new Promise<CameraSelection | undefined>((resolve) => {
				pending = resolve;
			});
			void startPreview(selectedDeviceId());
			return result;
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			disposed = true;
			unsubscribe();
			finish(undefined);
			listeners.clear();
		},
	};
}
