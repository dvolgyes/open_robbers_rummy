import { PROJECT_ID } from "../project";
import { type Seat, seatsOf, type TableConfig } from "../protocol";
import { deriveHolder } from "./keys";

export interface BotSeatClaim {
	readonly seat: Seat;
	readonly holder: string;
	readonly id: string;
}

/** The seats with a Bot choice; the host's bots play only these, so a seat named bot stays free for the bot CLI. */
export function botSeats(config: TableConfig): Seat[] {
	return seatsOf(config).filter(
		(seat) => config.botSetup?.seats.includes(seat) === true,
	);
}

export function botSeatHolder(tableId: string, seat: Seat): Promise<string> {
	return deriveHolder(tableId, `${PROJECT_ID}|host-bot|${seat}`);
}

export async function botSeatClaims(
	tableId: string,
	config: TableConfig,
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
