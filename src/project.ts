/**
 * The project's identity: the source repository's address. It namespaces the network (Trystero app ID,
 * derived room names and holders) and this origin's storage, so another project cannot collide by accident.
 */
export const PROJECT_ID = "github.com/dvolgyes/open_robbers_rummy";

/** A web storage, lock or IndexedDB name of this project. */
export function storageName(name: string): string {
	return `${PROJECT_ID}/${name}`;
}
