import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { type GetUserMedia, LocalMedia } from "../../src/call/media";
import type { Medium } from "../../src/call/policy";

declare module "vitest/browser" {
	interface BrowserCommands {
		clearPermissions(): Promise<void>;
		grantPermissions(names: string[]): Promise<void>;
	}
}

// LocalMedia captures from Chrome's test microphone and camera (--use-fake-device-for-media-stream).
// Playwright withdraws and grants the page's real capture permissions.

const opened: LocalMedia[] = [];

afterEach(async () => {
	for (const media of opened.splice(0)) media.stop();
	await commands.grantPermissions(["microphone", "camera"]);
});

/**
 * A LocalMedia on Chrome's getUserMedia, unchanged. The test keeps each request's promise, so that it can read the
 * state of a track that LocalMedia never attached.
 */
function localMedia() {
	const requests: Promise<MediaStream>[] = [];
	const getUserMedia: GetUserMedia = (constraints) => {
		const request = navigator.mediaDevices.getUserMedia(constraints);
		requests.push(request);
		return request;
	};
	const changes: Medium[] = [];
	const media = new LocalMedia(getUserMedia, (medium) => changes.push(medium));
	opened.push(media);
	return { media, changes, requests };
}

/** The only track of a stream that Chrome returned. LocalMedia's own handler ran before this await returns. */
async function trackOf(request: Promise<MediaStream> | undefined) {
	const tracks = (await request)?.getTracks() ?? [];
	expect(tracks).toHaveLength(1);
	return tracks[0];
}

describe("LocalMedia on Chrome's test devices (call/layout plan §4.5)", () => {
	it("asks for the microphone only, so a refused camera does not block it, and holds its track while on", async () => {
		await commands.clearPermissions();
		await commands.grantPermissions(["microphone"]);
		const { media, changes, requests } = localMedia();
		expect(media.state("audio")).toBe("off");
		media.set("audio", true);
		media.set("audio", true);
		expect(media.state("audio")).toBe("pending");
		expect(requests).toHaveLength(1);

		await expect.poll(() => media.state("audio")).toBe("on");
		const mic = media.track("audio");
		expect(mic).toBe(await trackOf(requests[0]));
		expect([mic?.kind, mic?.readyState]).toEqual(["audio", "live"]);
		expect(changes).toEqual(["audio", "audio"]);

		media.set("audio", false);
		expect(mic?.readyState).toBe("ended");
		expect(media.track("audio")).toBeUndefined();
		expect(media.state("audio")).toBe("off");
		expect(changes).toEqual(["audio", "audio", "audio"]);
	});

	it("asks for the camera only, at 640×360 and 15 fps, and names the medium of each change", async () => {
		await commands.clearPermissions();
		await commands.grantPermissions(["camera"]);
		const { media, changes } = localMedia();
		media.set("video", true);
		await expect.poll(() => media.state("video")).toBe("on");
		const camera = media.track("video");
		expect(camera?.kind).toBe("video");
		expect(camera?.getSettings()).toMatchObject({
			width: 640,
			height: 360,
			frameRate: 15,
		});
		expect(media.state("audio")).toBe("off");
		expect(changes).toEqual(["video", "video"]);
	});

	it("keeps the microphone and the camera independent", async () => {
		await commands.clearPermissions();
		await commands.grantPermissions(["microphone"]);
		const { media } = localMedia();
		media.set("audio", true);
		media.set("video", true);
		// A refused camera does not touch the microphone.
		await expect.poll(() => media.state("video")).toBe("denied");
		await expect.poll(() => media.state("audio")).toBe("on");
		const mic = media.track("audio");

		await commands.grantPermissions(["camera"]);
		media.set("video", true);
		await expect.poll(() => media.state("video")).toBe("on");
		const camera = media.track("video");
		media.set("video", false);
		expect(camera?.readyState).toBe("ended");
		expect(mic?.readyState).toBe("live");
		expect(media.track("audio")).toBe(mic);

		media.set("audio", false);
		expect(mic?.readyState).toBe("ended");
	});

	it("stop() ends both devices and stops the camera track of a pending request", async () => {
		const { media, requests } = localMedia();
		media.set("audio", true);
		await expect.poll(() => media.state("audio")).toBe("on");
		const mic = media.track("audio");
		media.set("video", true);
		media.stop();
		const late = await trackOf(requests[1]);
		expect(late?.kind).toBe("video");
		expect(late?.readyState).toBe("ended");
		expect(mic?.readyState).toBe("ended");
		expect([media.state("audio"), media.state("video")]).toEqual([
			"off",
			"off",
		]);
		expect(media.track("video")).toBeUndefined();
	});

	it("stops a track that arrives after the switch went off, and never attaches it", async () => {
		const { media, changes, requests } = localMedia();
		media.set("audio", true);
		media.set("audio", false);
		const late = await trackOf(requests[0]);
		expect(late?.readyState).toBe("ended");
		expect(media.track("audio")).toBeUndefined();
		expect(media.state("audio")).toBe("off");
		expect(changes).toEqual(["audio", "audio"]);
	});

	it("keeps only the newest request when the switch goes off and on again", async () => {
		const { media, requests } = localMedia();
		media.set("audio", true);
		media.set("audio", false);
		media.set("audio", true);
		expect(requests).toHaveLength(2);
		const [stale, fresh] = [
			await trackOf(requests[0]),
			await trackOf(requests[1]),
		];
		expect(media.state("audio")).toBe("on");
		expect(media.track("audio")).toBe(fresh);
		expect(stale?.readyState).toBe("ended");
		expect(fresh?.readyState).toBe("live");
	});

	it("reports a refused permission as denied, and captures again once it is granted", async () => {
		await commands.clearPermissions();
		const { media } = localMedia();
		media.set("audio", true);
		await expect.poll(() => media.state("audio")).toBe("denied");
		expect(media.track("audio")).toBeUndefined();

		await commands.grantPermissions(["microphone"]);
		media.set("audio", true);
		await expect.poll(() => media.state("audio")).toBe("on");
	});

	it.each<Medium>(["audio", "video"])(
		"fails when the %s permission is withdrawn during the capture",
		async (medium) => {
			const { media, changes } = localMedia();
			media.set(medium, true);
			await expect.poll(() => media.state(medium)).toBe("on");
			const track = media.track(medium);

			await commands.clearPermissions();
			await expect.poll(() => media.state(medium)).toBe("failed");
			expect(track?.readyState).toBe("ended");
			expect(media.track(medium)).toBeUndefined();
			expect(changes).toEqual([medium, medium, medium]);
		},
	);
});
