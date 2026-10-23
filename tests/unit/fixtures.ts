import { DEFAULT_TABLE_SETUP, type TableConfig } from "../../src/protocol";

export const TABLE_ID = "Table_ID-0123456789abc";
export const OTHER_TABLE_ID = "Other-ID-0123456789abc";

export const CONFIG: TableConfig = {
	names: { "1": "player1", "2": "player3", "3": "player2", "4": "host" },
	table: DEFAULT_TABLE_SETUP,
};
