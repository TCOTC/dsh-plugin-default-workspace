/**
 * Read the decision trace the browser half writes into the page's localStorage.
 *
 *   node test/probe-report.mjs
 *
 * The trace is the only record of what the renderer did — which policy version
 * installed, and which branch each navigation decision took — and it survives
 * outside DevTools because the Desktop shell's localStorage is a LevelDB on
 * disk. Newest trace last; a missing key means the browser half never ran.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const KEY = "dsh.default-workspace.probe";
const dir = join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"), "@deepseek-ai", "dsh-desktop", "Local Storage", "leveldb");

/** Files holding the store, oldest first, so the last occurrence is the newest value. */
function levelDbFiles(directory) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".log") || name.endsWith(".ldb"))
		.map((name) => join(directory, name))
		.sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
}

/** The balanced JSON object starting at `start`, or undefined. */
function balancedJson(text, start) {
	if (text[start] !== "{") return;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return;
}

let report;
const occurrences = [];
for (const file of levelDbFiles(dir)) {
	const text = readFileSync(file).toString("latin1");
	let from = 0;
	while (true) {
		const at = text.indexOf(KEY, from);
		if (at < 0) break;
		occurrences.push({ file, text, at });
		from = at + KEY.length;
	}
}
for (const occurrence of occurrences.reverse()) {
	// LevelDB frames the value behind a record header rather than a separator byte,
	// so the value is the first JSON object starting shortly after the key.
	const from = occurrence.at + KEY.length;
	const start = occurrence.text.indexOf("{", from);
	if (start < 0 || start - from > 32) continue;
	const candidate = balancedJson(occurrence.text, start);
	if (candidate === undefined) continue;
	try {
		report = JSON.parse(candidate);
		break;
	} catch {}
}
if (report === undefined) {
	console.log(`no trace: "${KEY}" is absent from ${dir}`);
	console.log("the browser half has not run in this installation's page yet");
	process.exitCode = 1;
} else {
	console.log(`trace version ${String(report.version)} — ${String(report.events.length)} event(s), newest last`);
	for (const event of report.events) {
		const when = new Date(event.at).toLocaleTimeString();
		const detail = event.detail === undefined ? "" : ` ${JSON.stringify(event.detail)}`;
		console.log(`  ${when}  v${String(event.version)}  ${String(event.event)}${detail}`);
	}
}
