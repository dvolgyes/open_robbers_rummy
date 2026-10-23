import { selfId } from "@trystero-p2p/core";
import type { MeshConfig } from "./config";
import { Mesh, type MeshHandlers, type TrackerSocket } from "./mesh";
import type { Clock } from "./ports";
import type { TrackerRooms } from "./tracker";

/** The production mesh: Trystero over the configured public trackers, with the page's tracker rooms. */
export function trysteroMesh(
	rooms: TrackerRooms,
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
				joinRoom: rooms.joinRoom,
				self: selfId,
				trackerSockets: () =>
					rooms.sockets() as Readonly<Record<string, TrackerSocket>>,
				clock,
			},
			handlers,
		);
}
