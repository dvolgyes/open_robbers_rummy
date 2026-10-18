/**
 * The single device-class rule of the call (handover §1, §2): "desktop" may use video, "compact" is audio only.
 * The same class drives the layout. It is a user-experience rule, not a security boundary.
 */
export type Form = "desktop" | "compact";

/** A layout viewport narrower than this many CSS pixels is compact. */
export const COMPACT_BELOW_WIDTH = 900;

export interface DeviceSignals {
	/** Layout viewport width in CSS pixels. */
	readonly viewportWidth: number;
	/** `navigator.userAgentData.mobile`, or undefined when the browser does not expose it. */
	readonly uaMobile: boolean | undefined;
	readonly userAgent: string;
	readonly maxTouchPoints: number;
	/** `(any-pointer: fine)`: at least one precise pointer, such as a mouse or trackpad. */
	readonly anyFinePointer: boolean;
}

/** iPadOS Safari reports a Macintosh desktop user agent; the touch points give it away. */
function isIPadDesktopMode(signals: DeviceSignals): boolean {
	return /\bMacintosh\b/.test(signals.userAgent) && signals.maxTouchPoints > 1;
}

/** Without evidence of a desktop (a fine pointer, a wide viewport, no mobile signal) the result is compact. */
export function classify(signals: DeviceSignals): Form {
	if (signals.viewportWidth < COMPACT_BELOW_WIDTH) return "compact";
	if (signals.uaMobile === true) return "compact";
	if (isIPadDesktopMode(signals)) return "compact";
	if (!signals.anyFinePointer) return "compact";
	return "desktop";
}

// ---------------------------------------------------------------------------------------------------------------
// Browser adapter

interface MediaQueryLike {
	readonly matches: boolean;
	addEventListener(type: "change", listener: () => void): void;
	removeEventListener(type: "change", listener: () => void): void;
}

/** The part of `window` the adapter reads. */
export interface DeviceWindow {
	readonly innerWidth: number;
	readonly navigator: {
		readonly userAgent: string;
		readonly maxTouchPoints: number;
		readonly userAgentData?: unknown;
	};
	matchMedia(query: string): MediaQueryLike;
	addEventListener(type: "resize", listener: () => void): void;
	removeEventListener(type: "resize", listener: () => void): void;
}

const FINE_POINTER_QUERY = "(any-pointer: fine)";

/** `userAgentData.mobile` when it is a boolean; Firefox and Safari have no `userAgentData`. */
export function uaMobile(userAgentData: unknown): boolean | undefined {
	if (typeof userAgentData !== "object" || userAgentData === null)
		return undefined;
	const mobile = (userAgentData as { mobile?: unknown }).mobile;
	return typeof mobile === "boolean" ? mobile : undefined;
}

export function readSignals(win: DeviceWindow): DeviceSignals {
	return {
		viewportWidth: win.innerWidth,
		uaMobile: uaMobile(win.navigator.userAgentData),
		userAgent: win.navigator.userAgent,
		maxTouchPoints: win.navigator.maxTouchPoints,
		anyFinePointer: win.matchMedia(FINE_POINTER_QUERY).matches,
	};
}

/**
 * Calls `onChange` with the new class whenever a resize, rotation or pointer change moves the device across
 * the boundary. Returns a function that removes the listeners.
 */
export function watchDeviceClass(
	win: DeviceWindow,
	onChange: (form: Form) => void,
): () => void {
	const pointer = win.matchMedia(FINE_POINTER_QUERY);
	let current = classify(readSignals(win));
	const check = () => {
		const next = classify(readSignals(win));
		if (next === current) return;
		current = next;
		onChange(next);
	};
	win.addEventListener("resize", check);
	pointer.addEventListener("change", check);
	return () => {
		win.removeEventListener("resize", check);
		pointer.removeEventListener("change", check);
	};
}
