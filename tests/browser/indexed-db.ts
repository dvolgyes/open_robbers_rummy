import {
	type CorruptRecord,
	openIndexedDbStorage,
	type TableStorage,
} from "../../src/p2p/storage";

/** The database of src/p2p/storage.ts. All browser test files use the same real database, one file at a time. */
export const DB_NAME = "oc-p2p";

export function request<T>(target: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		target.onsuccess = () => resolve(target.result);
		target.onerror = () => reject(target.error);
	});
}

/** Deletes the database. Storage connections close on the version change, so nothing blocks the deletion. */
export function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const deleting = indexedDB.deleteDatabase(DB_NAME);
		deleting.onsuccess = () => resolve();
		deleting.onerror = () => reject(deleting.error);
	});
}

/**
 * Opens the database at a newer version and closes it, as a newer version of the page in another tab does.
 * Every storage connection closes, so its later transactions fail.
 */
export async function openNewerVersion(): Promise<void> {
	const upgraded = await request(indexedDB.open(DB_NAME, 2));
	upgraded.close();
}

/** The production storage on the IndexedDB of this page. */
export async function openStorage(
	onCorrupt: (record: CorruptRecord) => void = () => {},
): Promise<TableStorage> {
	const opened = await openIndexedDbStorage(
		{ factory: indexedDB, keyRange: IDBKeyRange },
		onCorrupt,
	);
	if (!opened.ok) throw new Error(opened.detail);
	return opened.value;
}
