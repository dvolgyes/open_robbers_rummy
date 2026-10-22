import { RTCPeerConnection as WeriftPeerConnection } from "werift";
import { parseRoomSetup } from "../bookmark";
import type { MatchState } from "../canasta";
import {
	actionPayload,
	canastaModule,
	parseCanastaState,
} from "../game/canasta";
import { newCommandId } from "../ids";
import { randomNonce } from "../p2p/checks";
import { readMeshConfig } from "../p2p/config";
import { parseRoute } from "../p2p/link";
import type { Mesh } from "../p2p/mesh";
import type { Clock } from "../p2p/ports";
import { MemoryStorage } from "../p2p/storage";
import { TableController, tableIdentity } from "../p2p/table";
import { trysteroMesh } from "../p2p/trystero";
import type { RoomConfig, Seat } from "../protocol";
import {
	botModelOrder,
	DEFAULT_BOT_SETUP,
	isBotName,
	SEATS,
} from "../protocol";
import { type SeatLocks, SeatMemory } from "../session";
import { OpenRouterStrategy } from "./node-openrouter";
import { NODE_PROMPT_TEMPLATES } from "./node-prompts";
import { actionPositionKey } from "./position";
import type { Choice } from "./strategy";
import { chooseTurn, type TurnChooser, turnRequest } from "./turn";

interface Options {
	readonly url: URL;
	readonly username?: string;
	readonly random: boolean;
	readonly model?: string;
}

function parseArgs(argv: readonly string[]): Options {
	let urlText: string | undefined;
	let username: string | undefined;
	let random = false;
	let model: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		if (value === "--random") {
			random = true;
		} else if (value === "--user") {
			const name = argv[++index]?.trim();
			if (!name) throw new Error("--user needs a player name");
			username = name;
		} else if (value === "--model") {
			const name = argv[++index]?.trim();
			if (!name) throw new Error("--model needs a model name");
			model = name;
		} else if (value?.startsWith("--")) {
			throw new Error(`unknown option: ${value}`);
		} else if (urlText === undefined && value !== undefined) {
			urlText = value;
		} else {
			throw new Error("provide one room URL");
		}
	}
	if (urlText === undefined)
		throw new Error(
			"usage: npm run bot -- <room-url> [--user <name>] [--random]",
		);
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw new Error("the room URL is not valid");
	}
	const route = parseRoute(url.hash);
	if (route.kind !== "table")
		throw new Error("the URL does not contain a valid table link");
	return {
		url,
		...(username === undefined ? {} : { username }),
		random,
		...(model === undefined ? {} : { model }),
	};
}

function candidateSeats(
	config: RoomConfig,
	username: string | undefined,
): Seat[] {
	const wanted = username?.toLocaleLowerCase();
	return SEATS.filter((seat) => {
		const name = config.names[seat].trim();
		return wanted === undefined
			? isBotName(name)
			: name.toLocaleLowerCase() === wanted;
	});
}

function describeFailure(error: unknown, secrets: readonly string[]): string {
	const message = error instanceof Error ? error.message : "Unexpected error";
	return secrets.reduce(
		(text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
		message,
	);
}

async function run(options: Options): Promise<void> {
	const route = parseRoute(options.url.hash);
	if (route.kind !== "table")
		throw new Error("the URL does not contain a valid table link");
	const setup = parseRoomSetup(options.url.search);
	const initialCandidates = setup
		? candidateSeats(setup.config, options.username)
		: undefined;
	if (initialCandidates?.length === 0) {
		throw new Error(
			options.username === undefined
				? "no seat named bot or robot was found in the room link"
				: `no seat named ${options.username} was found in the room link`,
		);
	}
	const apiKey = options.random ? undefined : process.env.OPENROUTER_API_KEY;
	const configuredModels = setup?.config.botSetup
		? botModelOrder(setup.config.botSetup)
		: botModelOrder(DEFAULT_BOT_SETUP);
	const modelOrder = options.model
		? [
				options.model,
				...configuredModels.filter((model) => model !== options.model),
			]
		: configuredModels;
	const strategy = apiKey
		? new OpenRouterStrategy(apiKey, {
				model: modelOrder[0] as string,
				fallbackModel: modelOrder[1] as (typeof configuredModels)[number],
				modelOrder,
				retries: setup?.config.botSetup?.retries,
				retryDelayMs: setup?.config.botSetup?.retryDelayMs,
			})
		: undefined;
	// --random picks among the offered options without a model, so it needs no key.
	const chooser: TurnChooser | undefined = options.random
		? {
				choose: async (_prompt, labels) =>
					Math.floor(Math.random() * labels.length),
			}
		: strategy;
	if (chooser === undefined)
		throw new Error("OPENROUTER_API_KEY is missing from .env");
	const meshResult = readMeshConfig(process.env);
	if (!meshResult.ok) throw new Error(meshResult.error);

	const clock: Clock = {
		monotonic: () => performance.now(),
		wall: () => Date.now(),
	};
	const storage = new MemoryStorage();
	const memory = new SeatMemory(undefined, undefined, clock.wall);
	const locks: SeatLocks = {
		heldElsewhere: async () => new Set(),
		hold: (_tableId, _seat, optionsForLock) => {
			queueMicrotask(() => optionsForLock?.onAcquired?.());
			return () => {};
		},
	};
	const identity = await tableIdentity(route.key, undefined);
	let mesh: Mesh | undefined;
	const openMesh = trysteroMesh(
		identity.tableId,
		route.key,
		meshResult.config,
		clock,
		WeriftPeerConnection as unknown as typeof RTCPeerConnection,
	);
	const controller = new TableController({
		identity,
		storage,
		locks,
		memory,
		module: canastaModule,
		hostEligible: false,
		clock,
		every: (ms, tick) => {
			const timer = setInterval(tick, ms);
			return () => clearInterval(timer);
		},
		openMesh: (handlers) => {
			mesh = openMesh(handlers);
			return mesh;
		},
		newId: newCommandId,
		nonce: randomNonce,
	});
	let stopped = false;
	let choosing = false;
	let requestedSeat: Seat | undefined;
	let strategyKey: string | undefined;
	let sentKey: string | undefined;
	let sentFailureCount = 0;
	const triedSeats = new Set<Seat>();
	let startupTimer: NodeJS.Timeout | undefined;
	let removeListener = (): void => {};
	let finish: (error?: Error) => void = () => {};
	const finished = new Promise<void>((resolve, reject) => {
		finish = (error) => {
			if (error) reject(error);
			else resolve();
		};
	});
	const stop = async (error?: Error): Promise<void> => {
		if (stopped) return;
		stopped = true;
		if (startupTimer) clearTimeout(startupTimer);
		removeListener();
		controller.stop();
		await mesh?.leave();
		finish(error);
	};
	const onSignal = (): void => {
		void stop().finally(() => {
			process.exitCode = 130;
		});
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	const chooseSeat = async (view = controller.view()): Promise<void> => {
		if (choosing || requestedSeat !== undefined || view.seat !== null) return;
		const config = view.lobby?.config ?? view.table?.config ?? setup?.config;
		if (!config) return;
		const candidates = candidateSeats(config, options.username);
		if (candidates.length === 0) {
			await stop(
				new Error(
					options.username === undefined
						? "no seat named bot or robot was found"
						: `no seat named ${options.username} was found`,
				),
			);
			return;
		}
		if (!view.lobby) return;
		const available = candidates.find(
			(seat) =>
				!triedSeats.has(seat) &&
				view.lobby?.seats.some((row) => row.seat === seat && row.available),
		);
		if (available === undefined) {
			await stop(new Error("no matching bot seat is currently open"));
			return;
		}
		triedSeats.add(available);
		requestedSeat = available;
		choosing = true;
		try {
			const result = await controller.choose(available);
			if (!result.ok) {
				requestedSeat = undefined;
				if (result.reason === "refused" || result.reason === "held-elsewhere") {
					choosing = false;
					await chooseSeat(controller.view());
					return;
				}
				throw new Error(`could not take seat ${available} (${result.reason})`);
			}
			console.log(`Requested seat ${available}.`);
		} finally {
			choosing = false;
		}
	};

	const sendAction = async (
		match: MatchState,
		accepted: number,
		seat: Seat,
		position: string,
		choice: Choice,
		view: ReturnType<TableController["view"]>,
	): Promise<void> => {
		const currentState = parseCanastaState(
			view.table?.state ?? {},
			identity.tableId,
		);
		const current = currentState?.match;
		if (
			!currentState ||
			!current ||
			actionPositionKey(current.handNo, currentState.actions) !== position
		)
			return;
		const result = await controller.send(
			actionPayload(identity.tableId, match, accepted, choice.action),
		);
		if (!result.ok)
			throw new Error(`could not queue game action (${result.code})`);
		sentKey = position;
		sentFailureCount = view.failures.length;
		console.log(`Sent ${choice.label} for ${seat}.`);
	};

	const drive = async (): Promise<void> => {
		if (stopped) return;
		const view = controller.view();
		if (view.hosting) {
			await stop(
				new Error(
					"host eligibility invariant failed; bot stopped before hosting",
				),
			);
			return;
		}
		if (
			view.status === "expired" ||
			view.status === "incompatible" ||
			view.status === "full"
		) {
			await stop(new Error(`room stopped with status ${view.status}`));
			return;
		}
		if (view.seat === null) {
			if (view.seatError !== null) {
				if (view.seatError === "taken" && !choosing) {
					requestedSeat = undefined;
					await chooseSeat(view);
				} else if (view.seatError !== "taken")
					await stop(new Error(`seat request failed (${view.seatError})`));
				return;
			}
			if (requestedSeat !== undefined) return;
			await chooseSeat(view);
			return;
		}
		requestedSeat = undefined;
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = undefined;
		}
		if (!view.ready || !view.table) return;
		const state = parseCanastaState(view.table.state, identity.tableId);
		const match = state?.match;
		if (!state || !match || match.settled || match.winner !== null) return;
		if (view.outbox.length > 0) return;
		const seat = view.seat;
		const position = actionPositionKey(match.handNo, state.actions);
		if (sentKey === position) {
			if (view.failures.length > sentFailureCount) {
				await stop(new Error("host rejected the bot's action"));
			}
			return;
		}
		if (strategyKey === position) return;
		strategyKey = position;
		try {
			const request = turnRequest(
				match,
				state.actions,
				seat,
				NODE_PROMPT_TEMPLATES,
			);
			if (!request) return;
			const choice = await chooseTurn(chooser, request, (message) =>
				console.error(`${seat}: ${message}`),
			);
			await sendAction(match, state.actions, seat, position, choice, view);
		} catch (error) {
			await stop(new Error(describeFailure(error, [apiKey ?? "", route.key])));
		}
	};

	removeListener = controller.onChange(() => {
		void drive().catch((error: unknown) => {
			void stop(new Error(describeFailure(error, [apiKey ?? "", route.key])));
		});
	});
	startupTimer = setTimeout(
		() => {
			void stop(
				new Error("timed out waiting for an active room and its seat list"),
			);
		},
		setup ? 60_000 : 45_000,
	);
	try {
		await controller.start();
		void drive().catch((error: unknown) => {
			void stop(new Error(describeFailure(error, [apiKey ?? "", route.key])));
		});
		await finished;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		if (!stopped) await stop();
	}
}

try {
	const options = parseArgs(process.argv.slice(2));
	await run(options);
} catch (error) {
	console.error(
		`Bot stopped: ${describeFailure(error, [process.env.OPENROUTER_API_KEY ?? ""])}`,
	);
	process.exitCode = 1;
}
