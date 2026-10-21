/** Returns an integer from 0 to bound - 1. */
export type RandomBelow = (bound: number) => number;

const UINT32_RANGE = 2 ** 32;

/**
 * Builds a uniform `RandomBelow` from a source of uniform 32-bit values. A value in the incomplete top block
 * would make small results more likely, so it is rejected and another value is drawn.
 */
export function randomBelowFrom(nextUint32: () => number): RandomBelow {
	return (bound) => {
		if (!Number.isInteger(bound) || bound < 1 || bound > UINT32_RANGE)
			throw new Error(
				`random bound must be an integer from 1 to 2^32: ${bound}`,
			);
		const limit = UINT32_RANGE - (UINT32_RANGE % bound);
		for (;;) {
			const value = nextUint32();
			if (value < limit) return value % bound;
		}
	};
}

function cryptoUint32(): number {
	const value = crypto.getRandomValues(new Uint32Array(1))[0];
	if (value === undefined)
		throw new Error("crypto.getRandomValues gave no value");
	return value;
}

export const cryptoRandomBelow: RandomBelow = randomBelowFrom(cryptoUint32);
