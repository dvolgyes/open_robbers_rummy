import { expect, type Page, test } from "@playwright/test";
import {
	caption,
	expectAudioArrives,
	installCallProbe,
	joinButton,
	joinWith,
	requestsFor,
	toggle,
} from "./call-probe";
import { type ContextOptions, Player, reportNetwork } from "./player";
import { CONNECT_MS, expectSeat, type SeatKey } from "./table";

/**
 * A desktop without a camera in the call, on a table of two through the public trackers. Player 2 has a camera;
 * Player 1 runs a Chrome whose fake devices have a microphone but no camera. Both may use the microphone and the
 * camera, so Player 1 has no camera because the device is missing, not because access was refused (that case is
 * test 3 of call-video.spec.ts).
 */
test.describe.configure({ mode: "serial" });

const SEATS = ["2", "1"] as const satisfies readonly SeatKey[];
const OPTIONS: ContextOptions = { permissions: ["microphone", "camera"] };

const players = {} as Record<(typeof SEATS)[number], Player>;
const tab = {} as Record<(typeof SEATS)[number], Page>;

/** The media inputs of the tab's browser, by kind. */
function inputs(page: Page): Promise<{ audio: number; video: number }> {
	return page.evaluate(async () => {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return {
			audio: devices.filter((device) => device.kind === "audioinput").length,
			video: devices.filter((device) => device.kind === "videoinput").length,
		};
	});
}

test.beforeAll(async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	for (const seat of SEATS) {
		players[seat] = await Player.open(
			browser,
			baseURL,
			`no-camera-${seat}`,
			OPTIONS,
			{ noCamera: seat === "1" },
		);
		await players[seat].addInitScript(installCallProbe);
	}
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first parameter.
test.afterEach(async ({}, testInfo) => {
	if (testInfo.status !== testInfo.expectedStatus)
		await reportNetwork(Object.values(players));
});

test.afterAll(async () => {
	for (const player of Object.values(players)) await player.close();
});

test("1: without a camera, Send camera is off and says why, and Join stays available", async () => {
	tab["2"] = await players["2"].page("./");
	await tab["2"].locator('select[name="players"]').selectOption("2");
	await tab["2"].locator('input[name="me"][value="2"]').check();
	await tab["2"].getByTestId("create").click();
	await expectSeat(tab["2"], "2");
	const link = new URL(tab["2"].url());
	link.searchParams.delete("selected_player");
	// The last free seat is taken without a click.
	tab["1"] = await players["1"].page(link.toString());
	await expectSeat(tab["1"], "1", { timeout: CONNECT_MS });
	await expect(tab["2"].getByTestId("table")).toHaveAttribute(
		"data-phase",
		"play",
	);

	expect(await inputs(tab["1"])).toMatchObject({ video: 0 });
	expect((await inputs(tab["1"])).audio).toBeGreaterThan(0);
	expect((await inputs(tab["2"])).video).toBeGreaterThan(0);

	const camera = toggle(tab["1"], "Send camera video");
	await expect(camera).toBeDisabled();
	await expect(camera).toHaveAttribute("aria-pressed", "false");
	await expect(camera).toHaveAttribute("title", "No camera is available.");
	await expect(toggle(tab["1"], "Send mic audio")).toBeEnabled();
	await expect(toggle(tab["1"], "See cameras: receive video")).toBeEnabled();
	await expect(joinButton(tab["1"])).toBeEnabled();
	await expect(toggle(tab["2"], "Send camera video")).toBeEnabled();
});

test("2: the player without a camera joins with the microphone; both hear each other, and it sees the other camera", async () => {
	await joinWith(tab["2"], "Audio + video both ways");
	await joinWith(tab["1"], "See cameras; send voice");
	await expect(toggle(tab["1"], "Send mic audio")).toHaveAttribute(
		"data-actual",
		"on",
	);
	await expectAudioArrives(tab["2"]);
	await expectAudioArrives(tab["1"]);
	await expect(caption(tab["2"], "1")).toHaveText("player1 · Audio only");
	await expect(tab["1"].getByTestId("tile-2")).toHaveAttribute(
		"data-video",
		"on",
	);
	await expect(tab["2"].getByTestId("tile-1")).toHaveAttribute(
		"data-video",
		"off",
	);
	// The page never asked this browser for a camera.
	expect(await requestsFor(tab["1"], "video")).toBe(0);
});

test("no uncaught errors", () => {
	expect(Object.values(players).flatMap((player) => player.errors)).toEqual([]);
});
