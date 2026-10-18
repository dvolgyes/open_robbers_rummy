export interface TurnSound {
	unlock(): void;
	beep(): void;
	dispose(): void;
}

/** A short sound cue that uses the browser's audio permission from the first user gesture. */
export function turnSound(): TurnSound {
	let context: AudioContext | undefined;
	let disposed = false;

	const getContext = (): AudioContext | undefined => {
		if (disposed || typeof window.AudioContext !== "function") return undefined;
		context ??= new window.AudioContext();
		return context;
	};

	const play = (audio: AudioContext): void => {
		if (disposed || audio.state !== "running") return;
		const now = audio.currentTime;
		const oscillator = audio.createOscillator();
		const volume = audio.createGain();
		oscillator.frequency.value = 880;
		volume.gain.setValueAtTime(0.0001, now);
		volume.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
		volume.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
		oscillator.connect(volume);
		volume.connect(audio.destination);
		oscillator.start(now);
		oscillator.stop(now + 0.17);
	};

	const resume = (): void => {
		const audio = getContext();
		if (audio && audio.state !== "running") {
			void audio.resume().catch(() => {});
		}
	};

	return {
		unlock: resume,
		beep() {
			const audio = getContext();
			if (!audio) return;
			if (audio.state === "running") play(audio);
			else
				void audio.resume().then(
					() => play(audio),
					() => {},
				);
		},
		dispose() {
			disposed = true;
			if (context && context.state !== "closed") {
				void context.close().catch(() => {});
			}
		},
	};
}
