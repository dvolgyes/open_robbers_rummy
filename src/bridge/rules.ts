/**
 * Adapter around @bridge-tools/core (ADR 0002). It is the only module that imports the library, so the
 * library can be replaced by owned code without changes elsewhere. All values here are plain JSON strings
 * and objects; the library's own types do not leave this file.
 */
import {
	Auction,
	Board as LibraryBoard,
	Score,
	Trick,
	type Types,
} from "@bridge-tools/core";
import type { Seat } from "../protocol";
import { type Card, rankOf, type Suit, suitOf } from "./cards";

export type Strain = Suit | "NT";
export const LEVELS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Level = (typeof LEVELS)[number];
/** Strains from low to high, the order in which bids rank within a level. */
export const STRAINS: readonly Strain[] = ["C", "D", "H", "S", "NT"];

export type Bid = `${Level}${Strain}`;
export type Call = "P" | "X" | "XX" | Bid;

/** Every call in bid-box order: pass, double, redouble, then the 35 bids from 1C to 7NT. */
export const CALLS: readonly Call[] = [
	"P",
	"X",
	"XX",
	...LEVELS.flatMap((level) =>
		STRAINS.map((strain): Bid => `${level}${strain}`),
	),
];

export function isCall(value: unknown): value is Call {
	return (
		typeof value === "string" && (CALLS as readonly string[]).includes(value)
	);
}

export type Vulnerability = "none" | "NS" | "EW" | "both";

export interface Contract {
	readonly level: Level;
	readonly strain: Strain;
	readonly declarer: Seat;
	readonly doubling: "" | "X" | "XX";
}

function libraryCall(call: Call): Types.AuctionCall {
	if (call === "P" || call === "X" || call === "XX") return { call };
	return {
		call: { level: Number(call[0]), suit: call.slice(1) as Types.SuitOrNT },
	};
}

function libraryAuction(calls: readonly Call[]): Types.AuctionCall[] {
	return calls.map(libraryCall);
}

function libraryCard(card: Card): Types.Card {
	return { suit: suitOf(card), rank: rankOf(card) };
}

function ownCard(card: Types.Card): Card {
	return `${card.suit}${card.rank}`;
}

const LIBRARY_VULNERABILITY: Readonly<
	Record<Vulnerability, Types.Vulnerability>
> = {
	none: "NvNv",
	NS: "VNv",
	EW: "NvV",
	both: "VV",
};

/** Dealer and vulnerability of a board in the standard 16-board cycle. */
export function boardSetup(number: number): {
	dealer: Seat;
	vulnerability: Vulnerability;
} {
	if (!Number.isSafeInteger(number) || number < 1)
		throw new Error(`board number must be a positive integer: ${number}`);
	const ns = LibraryBoard.isPlayerVulnerableOnBoard(number, "N");
	const ew = LibraryBoard.isPlayerVulnerableOnBoard(number, "E");
	const vulnerability = ns ? (ew ? "both" : "NS") : ew ? "EW" : "none";
	return { dealer: LibraryBoard.calculateDealer(number), vulnerability };
}

/** Four passes, or three passes after a bid. */
export function isAuctionOver(calls: readonly Call[]): boolean {
	return Auction.isAuctionEnded(libraryAuction(calls));
}

/** True when `call` may follow `calls` in an auction that is not over. */
export function isLegalCall(calls: readonly Call[], call: Call): boolean {
	return (
		!isAuctionOver(calls) &&
		Auction.isAuctionValid(libraryAuction([...calls, call]))
	);
}

/** The contract of a finished auction, or null when the board was passed out. */
export function finalContract(
	calls: readonly Call[],
	dealer: Seat,
): Contract | null {
	const contract = Auction.calculateContract(libraryAuction(calls), dealer);
	if (contract === null) throw new Error("the auction is not over");
	if (contract === "Passout") return null;
	return {
		level: contract.level as Level,
		strain: contract.strain,
		declarer: contract.declarer,
		doubling: contract.redoubled ? "XX" : contract.doubled ? "X" : "",
	};
}

/** The cards of `hand` that may be played to `trick`: the led suit when held, otherwise any card. */
export function playableCards(
	trick: readonly Card[],
	hand: readonly Card[],
): Card[] {
	return Trick.generatePlayableCards(
		trick.map(libraryCard),
		hand.map(libraryCard),
	).map(ownCard);
}

/** The seat that wins a complete trick of four cards, which `leader` started. */
export function trickWinner(
	trick: readonly Card[],
	leader: Seat,
	strain: Strain,
): Seat {
	if (trick.length !== 4)
		throw new Error(`a trick has 4 cards, not ${trick.length}`);
	return Trick.evaluate(trick.map(libraryCard), leader, strain);
}

/** Duplicate score from North-South's side; a passed-out board (null) scores 0. */
export function scoreContract(
	contract: Contract | null,
	vulnerability: Vulnerability,
	declarerTricks: number,
): number {
	if (
		!Number.isInteger(declarerTricks) ||
		declarerTricks < 0 ||
		declarerTricks > 13
	)
		throw new Error(
			`tricks must be an integer from 0 to 13: ${declarerTricks}`,
		);
	if (contract === null) return 0;
	const libraryContract: Types.PlayableContract = {
		level: contract.level,
		strain: contract.strain,
		declarer: contract.declarer,
		...(contract.doubling === "X" ? { doubled: true } : {}),
		...(contract.doubling === "XX" ? { redoubled: true } : {}),
	};
	return Score.calculate(
		libraryContract,
		LIBRARY_VULNERABILITY[vulnerability],
		declarerTricks,
	).score;
}
