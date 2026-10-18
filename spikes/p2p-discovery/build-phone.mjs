// Builds phone-dist/p2p-phone-probe.html: one self-contained file with phone.html, the bundled
// phone.ts (with Trystero from this spike's lockfile) and a new random room.
// Every build makes a new room, so the phone and the desktop must open the same build.
// Usage: node build-phone.mjs. The file path goes to stdout; the room code goes to stderr.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "phone-dist");
const outFile = join(outDir, "p2p-phone-probe.html");

const result = await build({
	configFile: false,
	root: here,
	logLevel: "warn",
	build: {
		write: false,
		minify: true,
		lib: {
			entry: join(here, "phone.ts"),
			formats: ["iife"],
			name: "phoneProbeBundle",
			fileName: "phone",
		},
	},
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(
	(bundle) => bundle.output,
);
const chunks = outputs.filter((item) => item.type === "chunk");
if (chunks.length !== 1 || outputs.length !== 1) {
	throw new Error(
		`expected one script chunk and no assets, got ${outputs.map((item) => item.fileName).join(", ")}`,
	);
}

// Inside <script>, the HTML parser ends the script at "</script" and changes state at "<!--".
const code = chunks[0].code.replace(/<\/(script)/gi, "<\\/$1");
if (code.includes("<!--")) {
	throw new Error("the bundle contains <!--, so it cannot be inlined safely");
}

const config = {
	room: randomBytes(16).toString("base64url"),
	password: randomBytes(32).toString("base64url"),
};
const template = await readFile(join(here, "phone.html"), "utf8");
const fill = (html, marker, content) => {
	if (html.split(marker).length !== 2) {
		throw new Error(`phone.html must contain ${marker} exactly once`);
	}
	// A function replacement, so "$" in the minified code stays as it is.
	return html.replace(marker, () => content);
};
const page = fill(
	fill(
		template,
		"<!--PROBE_CONFIG-->",
		`<script type="application/json" id="probe-config">${JSON.stringify(config)}</script>`,
	),
	"<!--PROBE_SCRIPT-->",
	`<script>${code}</script>`,
);

await mkdir(outDir, { recursive: true });
await writeFile(outFile, page);
process.stderr.write(
	`built ${Math.round(page.length / 1024)} KB, room code ${config.room.slice(0, 6)}\n`,
);
process.stdout.write(`${outFile}\n`);
