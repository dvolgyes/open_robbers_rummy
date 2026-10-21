export type Rng = () => number;

/** Small seeded PRNG (mulberry32): the same seed always gives the same deal. */
export function mulberry32(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Returns a new array; the input is not changed. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const a = out[i];
		const b = out[j];
		if (a === undefined || b === undefined)
			throw new Error("shuffle index out of range");
		out[i] = b;
		out[j] = a;
	}
	return out;
}
