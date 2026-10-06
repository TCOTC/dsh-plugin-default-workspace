/**
 * Host integration check: ask the running Desktop Host whether this plugin's
 * browser half is composed into the Client module graph.
 *
 *   node test/host-integration.test.mjs
 *
 * The Host serves a bundle only for a package it discovered through
 * `dsh.client` + `exports["./client"]`, read from disk, and gave a graph row
 * with a revision derived from that file's metadata. A 200 therefore proves the
 * whole Host half of the wiring: the Loader entry, the package resolution, and
 * the composed Client graph the browser loads from. Run it after enabling the
 * plugin; a mismatch means the Host has not re-scanned this file yet (re-add the
 * patch entry, or restart the app).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ID = manifest.name;
const clientPath = join(root, manifest.exports["./client"].default);
const base = process.env.DSH_WEB_URL ?? "http://127.0.0.1:19387";

/** The Host's `framedHash` over bundle metadata — how client-modules derives a graph revision. */
function artifactRevision(baseline) {
	const hash = createHash("sha1").update("plugin-artifact").update("\0");
	for (const part of [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)]) {
		hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	}
	return hash.digest("hex").slice(0, 12);
}

const rev = artifactRevision(statSync(clientPath));
const url = `${base}/plugins/??${ID}/client.js&rev=${rev}`;
let response;
try {
	response = await fetch(url);
} catch (error) {
	throw new Error(`cannot reach the running Host at ${base} (is the Desktop app open?): ${String(error)}`);
}
const body = response.status === 200 ? await response.text() : "";
console.log(`host=${base} id=${ID} rev=${rev} status=${String(response.status)} bytes=${String(body.length)}`);
if (response.status !== 200) throw new Error(`the Host does not serve this plugin's browser half; enable the Loader entry (or restart) and retry: ${url}`);
if (!body.includes(`id: "${ID}"`)) throw new Error("the served bundle does not register this plugin's module id");
if (!body.includes("DEFAULT_WORKSPACE_PATH")) throw new Error("the served bundle is not this plugin's code");
if (!body.includes("continuesConversation")) throw new Error("the Host serves a stale bundle revision; unmount and remount the Loader entry (or restart the app) so it re-reads the file");
console.log("ok — the Host serves this plugin's browser half from the Client module graph");
