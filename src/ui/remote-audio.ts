import type { RemoteView } from "../call/call";
import type { Seat } from "../protocol";
import { el } from "./dom";

/**
 * One audio element per remote seat. An element plays a track only while the call view gives it
 * one, so turning Hear others off or leaving the call silences it at once. The elements outlive the table's
 * re-rendering, so playback never restarts because the game changed.
 */

export interface RemoteAudio {
	readonly element: HTMLElement;
	render(remotes: readonly RemoteView[]): void;
	/** A user gesture: start the elements that the browser's autoplay rule blocked. */
	resume(): void;
	/** The table screen is gone: stop all playback. */
	detach(): void;
}

interface Player {
	readonly node: HTMLAudioElement;
	track: MediaStreamTrack | undefined;
}

/** `data-play` says what playback does: off, playing, blocked (autoplay rule) or failed. */
export function play(node: HTMLMediaElement): void {
	node.play().then(
		() => {
			node.dataset.play = "playing";
		},
		(error: unknown) => {
			if (!(error instanceof DOMException)) throw error;
			// A newer source or a pause replaced this attempt.
			if (error.name === "AbortError") return;
			node.dataset.play =
				error.name === "NotAllowedError" ? "blocked" : "failed";
		},
	);
}

export function remoteAudio(): RemoteAudio {
	const element = el("div", {
		className: "remote-audio",
		attrs: { "aria-hidden": "true" },
	});
	const players = new Map<Seat, Player>();

	function playerFor(seat: Seat): Player {
		const known = players.get(seat);
		if (known !== undefined) return known;
		const node = el("audio", {
			attrs: { "data-seat": seat, "data-testid": `audio-${seat}` },
		});
		node.autoplay = true;
		node.dataset.play = "off";
		element.append(node);
		const player: Player = { node, track: undefined };
		players.set(seat, player);
		return player;
	}

	function render(remotes: readonly RemoteView[]): void {
		for (const remote of remotes) {
			const player = playerFor(remote.seat);
			if (player.track === remote.audio) continue;
			player.track = remote.audio;
			if (remote.audio === undefined) {
				player.node.srcObject = null;
				player.node.dataset.play = "off";
			} else {
				player.node.srcObject = new MediaStream([remote.audio]);
				play(player.node);
			}
		}
	}

	function resume(): void {
		for (const { node } of players.values()) {
			if (node.dataset.play === "blocked") play(node);
		}
	}

	function detach(): void {
		for (const { node } of players.values()) node.srcObject = null;
		players.clear();
		element.replaceChildren();
	}

	return { element, render, resume, detach };
}
