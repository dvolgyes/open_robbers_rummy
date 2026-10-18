import { getRelaySockets, joinRoom, selfId } from "@trystero-p2p/torrent";
import type { MeshConfig } from "./config";
import { Mesh, type MeshHandlers, type TrackerSocket } from "./mesh";
import type { Clock } from "./ports";

/** The production mesh: the real Trystero bundle over the configured public trackers. */
export function trysteroMesh(
	tableId: string,
	key: string,
	config: MeshConfig,
	clock: Clock,
	rtcPolyfill?: typeof RTCPeerConnection,
): (handlers: MeshHandlers) => Mesh {
	return (handlers) =>
		new Mesh(
			{
				tableId,
				key,
				config,
				rtcPolyfill,
				joinRoom,
				self: selfId,
				trackerSockets: () =>
					getRelaySockets() as Readonly<Record<string, TrackerSocket>>,
				clock,
			},
			handlers,
		);
}
