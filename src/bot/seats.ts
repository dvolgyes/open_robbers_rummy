import { deriveHolder } from "../p2p/keys";
import { isBotName, type RoomConfig, SEATS, type Seat } from "../protocol";

export interface BotSeatClaim {
	readonly seat: Seat;
	readonly holder: string;
	readonly id: string;
}

export function botSeats(config: RoomConfig): Seat[] {
	return SEATS.filter(
		(seat) =>
			config.botSetup?.seats.includes(seat) === true ||
			isBotName(config.names[seat]),
	);
}

export function botSeatHolder(tableId: string, seat: Seat): Promise<string> {
	return deriveHolder(tableId, `open-canasta|host-bot|${seat}`);
}

export async function botSeatClaims(
	tableId: string,
	config: RoomConfig,
	newId: () => string,
	exclude?: Seat,
): Promise<BotSeatClaim[]> {
	return Promise.all(
		botSeats(config)
			.filter((seat) => seat !== exclude)
			.map(async (seat) => ({
				seat,
				holder: await botSeatHolder(tableId, seat),
				id: newId(),
			})),
	);
}
