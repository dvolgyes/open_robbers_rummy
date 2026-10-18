import { describe, expect, it } from "vitest";
import {
	classify,
	type DeviceSignals,
	type Form,
	uaMobile,
} from "../../src/call/device-class";

const CHROME_DESKTOP_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const IPAD_DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const FIREFOX_DESKTOP_UA =
	"Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

function desktop(overrides: Partial<DeviceSignals> = {}): DeviceSignals {
	return {
		viewportWidth: 1280,
		uaMobile: false,
		userAgent: CHROME_DESKTOP_UA,
		maxTouchPoints: 0,
		anyFinePointer: true,
		...overrides,
	};
}

describe("classify", () => {
	it.each<[string, Partial<DeviceSignals>, Form]>([
		["a wide desktop with a mouse", {}, "desktop"],
		["width 899", { viewportWidth: 899 }, "compact"],
		["width 900 with a fine pointer", { viewportWidth: 900 }, "desktop"],
		[
			"userAgentData.mobile at 1400 px",
			{ viewportWidth: 1400, uaMobile: true },
			"compact",
		],
		["coarse pointer only", { anyFinePointer: false }, "compact"],
		[
			"iPadOS in desktop mode with touch",
			{ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5, uaMobile: undefined },
			"compact",
		],
		[
			"a Mac with a trackpad",
			{ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0, uaMobile: undefined },
			"desktop",
		],
		[
			"Firefox desktop without userAgentData",
			{ userAgent: FIREFOX_DESKTOP_UA, uaMobile: undefined },
			"desktop",
		],
		[
			"a touch laptop that also has a fine pointer",
			{ maxTouchPoints: 10 },
			"desktop",
		],
	])("%s → %s", (_name, overrides, expected) => {
		expect(classify(desktop(overrides))).toBe(expected);
	});
});

describe("uaMobile", () => {
	it("reads userAgentData.mobile only when it is a boolean", () => {
		expect(uaMobile({ mobile: true })).toBe(true);
		expect(uaMobile({ mobile: false })).toBe(false);
		expect(uaMobile({ mobile: "yes" })).toBe(undefined);
		expect(uaMobile(null)).toBe(undefined);
		expect(uaMobile(undefined)).toBe(undefined);
	});
});

// readSignals and watchDeviceClass are tested on Chrome's window in tests/browser/call-device-class.test.ts.
