/**
 * Maintenance check for dsh-plugin-default-workspace.
 *
 * Run it after a DSH update to confirm this plugin still fits the Client
 * Workspace navigation policy it wraps:
 *
 *   node test/interception.test.mjs
 *
 * It executes the real browser bundle, materializes its factory, and drives the
 * two intercepted entry points against a fake `uiWorkspace` service whose shape
 * mirrors the stock one. Exit code 0 means every rule still holds; a failure
 * names the rule that broke.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PKG = manifest.name;
const DEFAULT_PATH = "D:\\dsh-workspace";
const DEFAULT_ID = "fb2689d9-7543-4430-9f73-fb714cff1d16";
const OTHER_ID = "5ce99a6d-d8d4-4cc2-9ef5-57178e6cc096";
const PROBE_KEY = "dsh.default-workspace.probe";

assert.equal(manifest.dsh?.client?.platform, "web", "package.json must declare dsh.client.platform = web");
assert.equal(manifest.exports?.["./client"]?.default, "./lib/client.js", "package.json must export the browser half as ./client");
assert.ok(existsSync(join(root, "lib", "index.js")), "package.json must point at a host half");
const clientPath = join(root, manifest.exports["./client"].default);
assert.ok(existsSync(clientPath), `missing browser half: ${clientPath}`);

/** localStorage stand-in: the browser half records its decision trace through it. */
const store = new Map();
globalThis.localStorage = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => {
		store.set(key, String(value));
	},
	removeItem: (key) => {
		store.delete(key);
	}
};
const probeEvents = () => {
	const raw = store.get(PROBE_KEY);
	return raw === undefined ? [] : JSON.parse(raw).events;
};
const resetProbes = () => store.clear();

let registration;
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			registration = value;
		}
	}
};
await import(pathToFileURL(clientPath).href);
assert.ok(registration !== undefined, "the browser half did not register with window.__ModuleLoader__");
assert.equal(registration.id, PKG, "the registered module id must equal the package name");
const factory = registration.factory;
const plugin = factory(() => {
	throw new Error("the browser half must not require any other module");
});
assert.equal(typeof plugin.apply, "function", "the browser half must export apply");
assert.equal(plugin.inject, undefined, "the browser half must not gate itself on an inject it may never see");

/**
 * Build a fake `uiWorkspace` service, its projections, and a call recorder.
 * `live-session` holds a conversation; the `blank-*` Sessions are empty New
 * Sessions nothing was ever sent to, as DSH's `blank` flag reports them.
 * With `late`, the service is invisible until `releaseService()` is called,
 * which models a plugin applied before the service exists.
 */
function harness({ items, selection = {}, mainReference, phases = "ready", connectThrows = false, late = false }) {
	const calls = { startSession: [], restoreSelection: [], openWorkspace: [], connectWorkspace: [], replaceMain: [] };
	const workspaces = { phase: phases, items };
	const sessions = {
		phase: phases,
		byId: {
			"live-session": { id: "live-session", blank: false },
			"blank-elsewhere": { id: "blank-elsewhere", blank: true },
			"blank-default": { id: "blank-default", blank: true }
		}
	};
	const service = {
		mainReference,
		lifetime: new AbortController(),
		// Deliberately carries no `layout`: reading another plugin's service through
		// a context proxy throws without a declared `inject`, and this plugin must
		// never need one.
		ctx: {},
		workspaces: { list: { getSnapshot: () => workspaces } },
		sessions: { list: { getSnapshot: () => sessions } },
		selection: { getSnapshot: () => selection },
		startSession(workspaceId) {
			calls.startSession.push(workspaceId);
		},
		async restoreSelection() {
			calls.restoreSelection.push(true);
		},
		async connectWorkspace(workspaceId) {
			calls.connectWorkspace.push(workspaceId);
			if (connectThrows) throw new Error("connect failed");
			return `session-in-${workspaceId}`;
		},
		replaceMain(sessionId, _signal, panel) {
			calls.replaceMain.push([sessionId, panel]);
		},
		async openWorkspace(workspaceId) {
			calls.openWorkspace.push(workspaceId);
		}
	};
	let visible = !late;
	const ctx = { get: (name) => (visible && name === "uiWorkspace" ? service : undefined) };
	plugin.apply(ctx);
	/** The two projection snapshots the stock `restoreSelection` receives from its caller. */
	const args = [workspaces, sessions];
	return {
		service,
		calls,
		args,
		reapply: () => plugin.apply(ctx),
		releaseService: () => {
			visible = true;
		}
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const readyItems = [
	{ workspaceId: OTHER_ID, path: "D:\\ExampleProjects\\sample-app", sessionIds: ["live-session", "blank-elsewhere"] },
	{ workspaceId: DEFAULT_ID, path: DEFAULT_PATH, sessionIds: ["blank-default"] }
];

// 1. no explicit target and no Session at all -> the pinned folder.
{
	const { service, calls } = harness({ items: readyItems, mainReference: undefined });
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "startSession() without context must open the pinned Workspace");
	assert.deepEqual(calls.startSession, [], "startSession() must not fall through to the stock target");
}
// 2. a conversation is open in another folder -> stock inheritance.
{
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	service.startSession();
	await settle();
	assert.deepEqual(calls.startSession, [undefined], "startSession() inside another conversation must keep the stock target");
	assert.deepEqual(calls.openWorkspace, [], "startSession() must not override the current folder");
}
// 3. an empty New Session is open in another folder -> not a conversation, so the pinned folder.
{
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "blank-elsewhere" } });
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "a blank current Session must not pin its folder");
	assert.deepEqual(calls.startSession, [], "a blank current Session must not reach the stock target");
}
// 4. an explicit target always wins.
{
	const { service, calls } = harness({ items: readyItems, mainReference: undefined });
	service.startSession("explicit-id");
	assert.deepEqual(calls.startSession, ["explicit-id"], "an explicit target must reach the stock flow");
	assert.deepEqual(calls.openWorkspace, [], "an explicit target must not be replaced");
}
// 5. an unknown saved Session -> the pinned folder, through connectWorkspace.
{
	const { service, calls, args } = harness({ items: readyItems, selection: { sessionId: "deleted-session" } });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.connectWorkspace, [DEFAULT_ID], "a stale selection must connect the pinned Workspace");
	assert.deepEqual(calls.replaceMain, [[`session-in-${DEFAULT_ID}`, "preserve"]], "the pinned blank Session must become the selection");
	assert.deepEqual(calls.restoreSelection, [], "a stale selection must not fall through to the stock restore");
}
// 6. an empty selection -> the pinned folder.
{
	const { service, calls, args } = harness({ items: readyItems, selection: {} });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.connectWorkspace, [DEFAULT_ID], "an empty selection must connect the pinned Workspace");
}
// 7. a saved blank New Session in another folder -> the pinned folder.
{
	const { service, calls, args } = harness({ items: readyItems, selection: { sessionId: "blank-elsewhere" } });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.connectWorkspace, [DEFAULT_ID], "an empty New Session in another folder must not pin that folder");
	assert.deepEqual(calls.restoreSelection, [], "an empty New Session must not fall through to the stock restore");
}
// 8. a saved blank New Session already in the pinned folder -> the pinned folder, reused.
{
	const { service, calls, args } = harness({ items: readyItems, selection: { sessionId: "blank-default" } });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.connectWorkspace, [DEFAULT_ID], "a blank Session in the pinned folder must reconnect there");
	assert.deepEqual(calls.restoreSelection, [], "a blank Session in the pinned folder must not reach the stock restore");
}
// 9. a saved Session holding a conversation -> stock restore, folder and all.
{
	const { service, calls, args } = harness({ items: readyItems, selection: { sessionId: "live-session" } });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.restoreSelection, [true], "a live conversation must restore exactly as before");
	assert.deepEqual(calls.connectWorkspace, [], "a live conversation must not be redirected");
}
// 10. a saved subagent address -> stock restore.
{
	const { service, calls, args } = harness({ items: readyItems, selection: { sessionId: "live-session", subagentAddress: "child" } });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.restoreSelection, [true], "a subagent selection must restore exactly as before");
}
// 11. path spelling must not defeat the match.
{
	const trailing = [
		{ workspaceId: OTHER_ID, path: "D:\\ExampleProjects\\sample-app", sessionIds: [] },
		{ workspaceId: DEFAULT_ID, path: "D:\\dsh-workspace\\", sessionIds: [] }
	];
	const { service, calls } = harness({ items: trailing, mainReference: undefined });
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "a trailing separator must not defeat the path match");
}
{
	const slash = [{ workspaceId: DEFAULT_ID, path: "d:/DSH-Workspace", sessionIds: [] }];
	const { service, calls } = harness({ items: slash, mainReference: undefined });
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "case and separator spelling must not defeat the path match");
}
{
	const moved = [{ workspaceId: DEFAULT_ID, path: "D:\\somewhere\\else", sessionIds: [] }];
	const { service, calls } = harness({ items: moved, mainReference: undefined });
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "the recorded Workspace identity must back up the path match");
}
// 12. the pinned folder is unregistered -> stock behavior, never a broken target.
{
	const items = [{ workspaceId: OTHER_ID, path: "D:\\ExampleProjects\\sample-app", sessionIds: ["live-session", "blank-elsewhere"] }];
	const { service, calls, args } = harness({ items, mainReference: { sessionId: "blank-elsewhere" }, selection: { sessionId: "blank-elsewhere" } });
	service.startSession();
	await settle();
	await service.restoreSelection(...args);
	assert.deepEqual(calls.startSession, [undefined], "an unregistered pinned folder must keep the stock target");
	assert.deepEqual(calls.restoreSelection, [true], "an unregistered pinned folder must keep the stock restore");
	assert.deepEqual(calls.connectWorkspace, [], "an unregistered pinned folder must not be connected");
}
// 13. projections that are not ready yet -> stock behavior.
{
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "live-session" }, phases: "loading" });
	service.startSession();
	await settle();
	assert.deepEqual(calls.startSession, [undefined], "unready projections must keep the stock target");
}
// 14. a failing connect must not lose the stock restore.
{
	const { service, calls, args } = harness({ items: readyItems, selection: {}, connectThrows: true });
	await service.restoreSelection(...args);
	assert.deepEqual(calls.restoreSelection, [true], "a failing pinned connect must fall back to the stock restore");
}
// 15. applying twice wraps once.
{
	const { service, calls, reapply } = harness({ items: readyItems, mainReference: undefined });
	reapply();
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "a repeated apply must wrap the service only once");
}
// 16. a newer policy revision replaces the previous wrapper instead of stacking on it.
{
	const { service, calls, reapply } = harness({ items: readyItems, mainReference: { sessionId: "blank-elsewhere" } });
	// Same service instance, as a live re-apply of this bundle arrives: the marker
	// is this plugin's own, and the version it records is what selects replacement.
	service.__defaultWorkspaceFallback.version = 0;
	reapply();
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "a newer policy revision must take over the policy");
	assert.deepEqual(calls.startSession, [], "re-installing must not delegate into the previous wrapper");
}
// 17. every install attempt and decision leaves the trace the Host side can read.
{
	resetProbes();
	const { service } = harness({ items: readyItems, mainReference: { sessionId: "blank-elsewhere" } });
	service.startSession();
	await settle();
	const events = probeEvents();
	const names = events.map((event) => event.event);
	assert.ok(names.includes("apply"), "apply must record its run");
	assert.ok(names.includes("policy"), "the install attempt must be recorded");
	const decision = events.find((event) => event.event === "startSession");
	assert.ok(decision !== undefined, "the routing decision must be recorded");
	assert.equal(decision.detail.branch, "default", "the trace must name the branch taken");
	assert.equal(decision.detail.target, DEFAULT_ID, "the trace must name the target Workspace");
}
// 18. a service that only appears later still gets the policy.
{
	resetProbes();
	const { service, calls, releaseService } = harness({ items: readyItems, mainReference: undefined, late: true });
	service.startSession();
	await settle();
	assert.deepEqual(calls.startSession, [undefined], "an absent service must leave the stock flow untouched");
	assert.ok(probeEvents().some((event) => event.event === "waiting"), "an absent service must be reported and retried");
	releaseService();
	await new Promise((resolve) => setTimeout(resolve, 1200));
	calls.startSession.length = 0;
	calls.openWorkspace.length = 0;
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "a service that appears later must still get the policy");
}

// 19. a boot selection made before the policy installed is still corrected.
{
	resetProbes();
	const { calls } = harness({ items: readyItems, mainReference: { sessionId: "blank-elsewhere" } });
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.ok(calls.openWorkspace.includes(DEFAULT_ID), "a blank Session opened before install must be redirected to the pinned folder");
	assert.ok(probeEvents().some((event) => event.event === "correct"), "the correction must be recorded in the trace");
}
// 20. a selection that appeared while connecting is not overridden.
{
	const { service, calls, args } = harness({ items: readyItems, selection: { sessionId: "blank-elsewhere" }, mainReference: undefined });
	// The user picks a Session while the pinned Workspace is still connecting.
	service.connectWorkspace = async (workspaceId) => {
		calls.connectWorkspace.push(workspaceId);
		service.mainReference = { sessionId: workspaceId };
		return `session-in-${workspaceId}`;
	};
	await service.restoreSelection(...args);
	assert.deepEqual(calls.replaceMain, [], "a Session selected while connecting must win");
	assert.deepEqual(calls.restoreSelection, [], "the pinned path must not also run the stock restore");
}

console.log(`ok — ${String(20)} rule groups hold for ${PKG}`);
