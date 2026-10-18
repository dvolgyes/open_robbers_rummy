import { describe, expect, it } from "vitest";
import { hasPublicAddress, selectedPath } from "../../src/p2p/checks";

/** A `getStats()` report reduced to the fields the functions read, plus an address they must ignore. */
function report(options: {
	readonly transport?: boolean;
	readonly local?: string;
	readonly remote?: string;
	readonly nominated?: boolean;
}) {
	return [
		...(options.transport === false
			? []
			: [{ id: "T1", type: "transport", selectedCandidatePairId: "CP1" }]),
		{
			id: "CP1",
			type: "candidate-pair",
			localCandidateId: "L1",
			remoteCandidateId: "R1",
			nominated: options.nominated ?? false,
			state: "succeeded",
		},
		{
			id: "L1",
			type: "local-candidate",
			candidateType: options.local ?? "host",
			address: "192.0.2.10",
		},
		{
			id: "R1",
			type: "remote-candidate",
			candidateType: options.remote ?? "srflx",
			address: "198.51.100.7",
		},
	];
}

describe("selectedPath", () => {
	it("reads the candidate types of the pair that the transport selected", () => {
		expect(selectedPath(report({ local: "srflx", remote: "srflx" }))).toEqual({
			local: "srflx",
			remote: "srflx",
		});
	});

	it("falls back to the nominated succeeded pair without a transport entry", () => {
		expect(selectedPath(report({ transport: false, nominated: true }))).toEqual(
			{ local: "host", remote: "srflx" },
		);
	});

	it("gives null while no pair is selected", () => {
		expect(selectedPath(report({ transport: false }))).toBeNull();
		expect(selectedPath([])).toBeNull();
	});

	it("gives unknown for a missing or unexpected candidate type", () => {
		expect(selectedPath(report({ local: "carrier-pigeon" }))).toEqual({
			local: "unknown",
			remote: "srflx",
		});
	});

	it("never returns an address", () => {
		expect(JSON.stringify(selectedPath(report({})))).not.toMatch(/\d+\.\d+/);
	});
});

describe("hasPublicAddress", () => {
	it("is true when a local candidate is server-reflexive", () => {
		expect(hasPublicAddress(report({ local: "srflx" }))).toBe(true);
	});

	it("ignores a server-reflexive remote candidate", () => {
		expect(hasPublicAddress(report({ local: "host", remote: "srflx" }))).toBe(
			false,
		);
	});
});
