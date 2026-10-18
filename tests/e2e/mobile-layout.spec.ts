import { expect, test } from "@playwright/test";

test("compact auction fits the visible width and centers its width cap", async ({
	page,
	baseURL,
}) => {
	if (!baseURL) throw new Error("baseURL is not configured");
	await page.setViewportSize({ width: 246, height: 606 });
	await page.goto(baseURL);
	await page.evaluate(() => {
		document.documentElement.style.scrollbarGutter = "stable";
		document.body.innerHTML = `
			<main>
				<section class="room" data-form="compact">
					<div class="stage">
						<div class="bridge-table" data-phase="auction">
							<div class="mobile-auction">
								<div class="mobile-auction-topbar">
									<div class="icon-group">
										<button>Call</button><button>Mic</button><button>Audio</button>
									</div>
									<button class="mobile-auction-share">Share URL</button>
									<button class="mobile-auction-exit">Exit</button>
								</div>
								<div class="mobile-auction-board">
									<div class="mobile-auction-hand">
										<div class="seat" data-visible="true">
											<div class="seat-label">North</div>
											<div class="hand hand-row" data-mobile-card-layout="4-2">
												${Array.from({ length: 4 }, () => '<span class="card"><span class="face">A</span></span>').join("")}
												<span class="card suit-start"><span class="face">K</span></span>
												<span class="card"><span class="face">Q</span></span>
												<span class="card"><span class="face">J</span></span>
												<span class="suit-group trump suit-start">
													${Array.from({ length: 3 }, () => '<span class="card"><span class="face">10</span></span>').join("")}
												</span>
												<span class="card suit-start"><span class="face">9</span></span>
												<span class="card"><span class="face">8</span></span>
												<span class="card"><span class="face">7</span></span>
											</div>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</section>
			</main>`;
		const updateWidthScale = (): void => {
			document.documentElement.style.setProperty(
				"--compact-width-font-size",
				`${document.body.clientWidth * 0.044444444}px`,
			);
		};
		updateWidthScale();
		new ResizeObserver(updateWidthScale).observe(document.body);
	});

	const narrow = await page.evaluate(() => {
		const exit = document.querySelector(".mobile-auction-exit");
		if (!exit) throw new Error("Exit button is missing");
		return {
			contentRight: document.body.getBoundingClientRect().right,
			exitRight: exit.getBoundingClientRect().right,
			rootFontSize: getComputedStyle(document.documentElement).fontSize,
			bodyFontSize: getComputedStyle(document.body).fontSize,
		};
	});
	expect(narrow.exitRight).toBeLessThanOrEqual(narrow.contentRight);
	expect(narrow.bodyFontSize).toBe(narrow.rootFontSize);

	await page.setViewportSize({ width: 928, height: 559 });
	const landscape = await page.locator("main").evaluate((main) => {
		const bounds = main.getBoundingClientRect();
		const body = document.body.getBoundingClientRect();
		return {
			left: bounds.left - body.left,
			right: body.right - bounds.right,
		};
	});
	expect(Math.abs(landscape.left - landscape.right)).toBeLessThanOrEqual(1);

	const handBounds = await page
		.locator(".mobile-auction-board")
		.evaluate((board) => {
			const hand = board.querySelector(".hand");
			const lastCard = hand?.lastElementChild;
			if (!(hand instanceof HTMLElement) || !(lastCard instanceof HTMLElement))
				throw new Error("Own hand cards are missing");
			return {
				boardRight: board.getBoundingClientRect().right,
				lastCardRight: lastCard.getBoundingClientRect().right,
			};
		});
	expect(handBounds.lastCardRight).toBeLessThanOrEqual(handBounds.boardRight);
});
