import { expect, it } from "vitest";
import { LocalMedia } from "../../src/call/media";

// This file runs in a Chrome whose test devices have no camera (--use-fake-device-for-media-stream=device-count=0).

it("reports a missing camera as failed and keeps the microphone", async () => {
	const devices = await navigator.mediaDevices.enumerateDevices();
	expect(devices.filter((device) => device.kind === "videoinput")).toEqual([]);

	const media = new LocalMedia(
		(constraints) => navigator.mediaDevices.getUserMedia(constraints),
		() => undefined,
	);
	try {
		media.set("audio", true);
		media.set("video", true);
		await expect.poll(() => media.state("video")).toBe("failed");
		await expect.poll(() => media.state("audio")).toBe("on");
		expect(media.track("video")).toBeUndefined();
		expect(media.track("audio")?.readyState).toBe("live");
	} finally {
		media.stop();
	}
});
