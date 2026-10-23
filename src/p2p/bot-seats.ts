import { PROJECT_ID } from "../project";
import {
	isBotName,
	type RoomConfig,
	type Seat,
	seatName,
	seatsOf,
} from "../protocol";
import { deriveHolder } from "./keys";

export interface BotSeatClaim {
	readonly seat: Seat;
	readonly holder: string;
	readonly id: string;
}

export function botSeats(config: RoomConfig): Seat[] {
	return seatsOf(config).filter(
		(seat) =>
			config.botSetup?.seats.includes(seat) === true ||
			isBotName(seatName(config, seat)),
	);
}

export function botSeatHolder(tableId: string, seat: Seat): Promise<string> {
	return deriveHolder(tableId, `${PROJECT_ID}|host-bot|${seat}`);
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
