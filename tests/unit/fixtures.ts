import { DEFAULT_TABLE_SETUP, type RoomConfig } from "../../src/protocol";

export const ROOM_ID = "Room_ID-0123456789abcd";
export const OTHER_ROOM_ID = "Other-ID-0123456789abc";

export const CONFIG: RoomConfig = {
	names: { "1": "player1", "2": "player3", "3": "player2", "4": "host" },
	table: DEFAULT_TABLE_SETUP,
};
