/**
 * Maintenance check for dsh-plugin-default-workspace.
 *
 * Run it after a DSH update to confirm this plugin still fits the Client
 * Workspace navigation policy it wraps:
 *
 *   node test/interception.test.mjs
 *
 * It executes the real browser bundle, materializes its factory, and drives the
 * intercepted entry points against a fake `uiWorkspace` service whose shape
 * mirrors the stock one. Rules 21–27 cover the Settings page: the stored
 * preference the page writes, its own navigation tab, and the folder chooser it
 * drives through the Desktop preload bridge. Rules 28–37 cover the archive
 * clear: the Workspace an archived main Session comes back in, the pinned
 * fallback, and every way that interception must stay out of the way. The New
 * Session row visibility rules live in `test/blank-row.test.mjs`. Exit code
 * 0 means every rule still holds; a failure names the rule that broke.
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
/**
 * React stand-in: the bundle may require the shell's React for its Settings row
 * and must not need any other module.
 */
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {}
};
const plugin = factory((id) => (id === "react" ? reactStub : undefined));
assert.equal(typeof plugin.apply, "function", "the browser half must export apply");
assert.equal(plugin.inject, undefined, "the browser half must not gate itself on an inject it may never see");
const { SETTINGS_KEY, SETTINGS_NS, SETTINGS_PAGE_ID, SETTINGS_ORDER } = plugin.internals;
/**
 * Depth-first search for the first element of one type in a rendered tree.
 * @param node - element tree node.
 * @param type - element type to find.
 * @returns the element, or undefined.
 */
function findElement(node, type) {
	if (node === null || node === undefined || typeof node !== "object") return;
	if (node.type === type) return node;
	const children = node.props?.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		const found = findElement(child, type);
		if (found !== undefined) return found;
	}
	return;
}

/**
 * Build a fake `uiWorkspace` service, its projections, and a call recorder.
 * `live-session` holds a conversation; the `blank-*` Sessions are empty New
 * Sessions nothing was ever sent to, as DSH's `blank` flag reports them.
 * With `late`, the service is invisible until `releaseService()` is called,
 * which models a plugin applied before the service exists.
 */
function harness({ items, selection = {}, mainReference, phases = "ready", connectThrows = false, late = false }) {
	const calls = {
		startSession: [], restoreSelection: [], openWorkspace: [], connectWorkspace: [], replaceMain: [], clearMain: [], archiveSession: []
	};
	const workspaces = { phase: phases, items };
	const sessions = {
		phase: phases,
		byId: {
			"live-session": { id: "live-session", blank: false },
			"blank-elsewhere": { id: "blank-elsewhere", blank: true },
			"blank-default": { id: "blank-default", blank: true },
			// A Session outside every Workspace: nothing names a folder for it.
			"loose-session": { id: "loose-session", blank: false }
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
		},
		/** Stock `clearMain`: drop the main reference and the saved selection. */
		clearMain() {
			calls.clearMain.push(true);
			const previous = service.mainReference;
			service.mainReference = undefined;
			previous?.release?.();
		},
		/** Stock `archiveSession`: archive on the Host, then clear a main view it held. */
		async archiveSession(sessionId) {
			calls.archiveSession.push(sessionId);
			if (service.mainReference?.sessionId === sessionId) service.clearMain();
		}
	};
	/** The unwrapped stock methods, so a test can model an upgrade from an older revision. */
	const stock = {
		startSession: service.startSession,
		restoreSelection: service.restoreSelection,
		clearMain: service.clearMain
	};
	let visible = !late;
	/** Slot registry stand-in: records what the settings row registers, and where. */
	const registrations = [];
	const effects = [];
	const slots = {
		inject(name, register) {
			registrations.push({ slot: name, contribution: register() });
		},
		register(options, component) {
			return { options, component };
		}
	};
	/** Locale stand-in: `bind` resolves the dictionaries the plugin registered. */
	const dictionaries = [];
	const locale = {
		register(namespace, sets) {
			dictionaries.push({ namespace, sets });
		},
		bind: (namespace) => (key, values) => {
			const entry = dictionaries.find((item) => item.namespace === namespace);
			const template = entry?.sets?.en?.[key] ?? key;
			if (values === undefined) return template;
			return template.replace(/\{(\w+)\}/gu, (match, name) => (name in values ? String(values[name]) : match));
		}
	};
	const ctx = {
		get: (name) => {
			if (name === "uiWorkspace") return visible ? service : undefined;
			if (name === "slots") return slots;
			if (name === "locale") return locale;
			return undefined;
		},
		// Cordis runs an effect body immediately and keeps its disposer.
		effect: (callback) => {
			const disposer = callback();
			effects.push(disposer);
			return disposer;
		}
	};
	plugin.apply(ctx);
	/** The two projection snapshots the stock `restoreSelection` receives from its caller. */
	const args = [workspaces, sessions];
	return {
		service,
		calls,
		args,
		stock,
		registrations,
		dictionaries,
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

// 21. a folder stored in Settings overrides the compiled-in default.
{
	resetProbes();
	localStorage.setItem(SETTINGS_KEY, JSON.stringify({ target: {
		path: "D:\\ExampleProjects\\sample-app",
		workspaceId: OTHER_ID
	} }));
	const { service, calls } = harness({ items: readyItems, mainReference: undefined });
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [OTHER_ID], "the folder stored in Settings must win over the compiled-in default");
	assert.deepEqual(calls.startSession, [], "a stored folder must not fall through to the stock target");
	localStorage.removeItem(SETTINGS_KEY);
}
// 22. "follow DSH" is an explicit choice, not an unset value.
{
	resetProbes();
	localStorage.setItem(SETTINGS_KEY, JSON.stringify({ target: null }));
	const { service, calls } = harness({ items: readyItems, mainReference: undefined });
	service.startSession();
	await settle();
	assert.deepEqual(calls.startSession, [undefined], "the stock choice must keep the stock target");
	assert.deepEqual(calls.openWorkspace, [], "the stock choice must not open any pinned folder");
	localStorage.removeItem(SETTINGS_KEY);
}
// 23. a stored folder that is not registered keeps the stock flow: never a broken target.
{
	resetProbes();
	localStorage.setItem(SETTINGS_KEY, JSON.stringify({ target: {
		path: "D:\\nowhere\\not-registered",
		workspaceId: null
	} }));
	const { service, calls, args } = harness({ items: readyItems, selection: {} });
	service.startSession();
	await settle();
	await service.restoreSelection(...args);
	assert.deepEqual(calls.startSession, [undefined], "an unregistered stored folder must keep the stock target");
	assert.deepEqual(calls.restoreSelection, [true], "an unregistered stored folder must keep the stock restore");
	localStorage.removeItem(SETTINGS_KEY);
}
// 24. the folder is edited from a Settings page with its own navigation tab.
{
	resetProbes();
	const { registrations, dictionaries } = harness({ items: readyItems });
	const page = registrations.find((entry) => entry.slot === "settings.section");
	assert.ok(page !== undefined, "the plugin must contribute a Settings section of its own");
	assert.equal(page.contribution.options.name, "settings.section", "the page must register under the declared section slot");
	assert.equal(page.contribution.options.id, SETTINGS_PAGE_ID, "the page must claim this plugin's own section id");
	assert.equal(page.contribution.options.order, SETTINGS_ORDER, "the page must place itself after the shipped sections");
	assert.equal(typeof page.contribution.options.label, "function", "the navigation tab must re-read its label per projection so it follows the locale");
	assert.equal(typeof page.contribution.options.inject, "function", "the page's data and write path come from its inject face");
	assert.equal(typeof page.contribution.component, "function", "the page must ship a component");
	assert.ok(dictionaries.some((entry) => entry.namespace === SETTINGS_NS), "the page's copy must be registered under its own locale namespace");
}
// 25. choosing a registered Workspace on the page drives the next decision, with no re-apply.
{
	resetProbes();
	const { registrations, service, calls } = harness({ items: readyItems, mainReference: undefined });
	const page = registrations.find((entry) => entry.slot === "settings.section");
	const props = { ...page.contribution.options.inject(), t: (key) => key, close: () => {} };
	const select = findElement(page.contribution.component(props), "select");
	assert.ok(select !== undefined, "the page must render the folder selector");
	assert.equal(select.props.value, `workspace:${DEFAULT_ID}`, "while nothing is stored, the compiled-in default shows as the current folder");
	select.props.onChange({ target: { value: `workspace:${OTHER_ID}` } });
	const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
	assert.equal(stored.target.workspaceId, OTHER_ID, "choosing a Workspace must store its identity");
	assert.equal(stored.target.path, "D:\\ExampleProjects\\sample-app", "choosing a Workspace must store its path");
	service.startSession();
	await settle();
	assert.deepEqual(calls.openWorkspace, [OTHER_ID], "the stored choice must drive the next decision without a re-apply");
	localStorage.removeItem(SETTINGS_KEY);
}
// 26. the chooser registers a folder the Workspace registry does not know yet.
{
	resetProbes();
	const { registrations, service } = harness({ items: readyItems, mainReference: undefined });
	const created = [];
	service.workspaces.create = async (input) => {
		created.push(input);
		return {
			workspaceId: "created-workspace",
			path: input.path
		};
	};
	globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => "D:\\Brand\\New" };
	try {
		const page = registrations.find((entry) => entry.slot === "settings.section");
		const props = { ...page.contribution.options.inject(), t: (key) => key, close: () => {} };
		const button = findElement(page.contribution.component(props), "button");
		assert.ok(button !== undefined, "the page must render the folder chooser button");
		await button.props.onClick();
		assert.deepEqual(created, [{ path: "D:\\Brand\\New" }], "a folder outside the registry must be registered the way Add workspace… does");
		assert.equal(JSON.parse(localStorage.getItem(SETTINGS_KEY)).target.workspaceId, "created-workspace", "the adopted Workspace must become the stored default");
	} finally {
		delete globalThis.__DSH_DIRECTORY_PICKER__;
		localStorage.removeItem(SETTINGS_KEY);
	}
}
// 27. cancelling the chooser changes nothing.
{
	resetProbes();
	localStorage.removeItem(SETTINGS_KEY);
	const { registrations } = harness({ items: readyItems, mainReference: undefined });
	let adopted = 0;
	globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => null };
	try {
		const page = registrations.find((entry) => entry.slot === "settings.section");
		const props = {
			...page.contribution.options.inject(),
			t: (key) => key,
			close: () => {},
			adopt: async () => {
				adopted += 1;
			}
		};
		const button = findElement(page.contribution.component(props), "button");
		await button.props.onClick();
		assert.equal(adopted, 0, "a cancelled pick must not register a Workspace");
		assert.equal(localStorage.getItem(SETTINGS_KEY), null, "a cancelled pick must not store a preference");
	} finally {
		delete globalThis.__DSH_DIRECTORY_PICKER__;
	}
}

// 28. archiving the Session you are viewing reopens its own Workspace.
{
	resetProbes();
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	await service.archiveSession("live-session");
	await settle();
	assert.deepEqual(calls.clearMain, [true], "archiving the main Session must run the stock clear exactly once");
	assert.deepEqual(calls.openWorkspace, [OTHER_ID], "the Workspace the archived Session was in must come back");
}
// 29. a cleared Session that belonged to no Workspace falls back to the pinned folder.
{
	resetProbes();
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "loose-session" } });
	await service.archiveSession("loose-session");
	await settle();
	assert.deepEqual(calls.openWorkspace, [DEFAULT_ID], "a cleared Session outside every Workspace must fall back to the pinned folder");
}
// 30. archiving some other row leaves the main view alone.
{
	resetProbes();
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	await service.archiveSession("blank-elsewhere");
	await settle();
	assert.deepEqual(calls.clearMain, [], "archiving another row must not clear the main view");
	assert.deepEqual(calls.openWorkspace, [], "archiving another row must not navigate");
}
// 31. a clear that removed no main Session is left exactly as stock left it.
{
	resetProbes();
	const { service, calls } = harness({ items: readyItems, mainReference: undefined });
	service.clearMain();
	await settle();
	assert.deepEqual(calls.clearMain, [true], "the stock clear must still happen with nothing selected");
	assert.deepEqual(calls.openWorkspace, [], "a clear with no main Session must not invent a navigation");
	assert.ok(
		probeEvents().some((event) => event.event === "clearMain" && event.detail.reason === "no-main-session"),
		"a clear that owned nothing must say so in the trace"
	);
}
// 32. the archive interception is still the user's choice: Follow DSH leaves it alone.
{
	resetProbes();
	localStorage.setItem(SETTINGS_KEY, JSON.stringify({ target: null }));
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "loose-session" } });
	service.clearMain();
	await settle();
	assert.deepEqual(calls.openWorkspace, [], "the stock choice must leave a cleared Session with no folder of its own alone");
	localStorage.removeItem(SETTINGS_KEY);
}
// 33. the archive decision is in the trace the Host side reads.
{
	resetProbes();
	const { service } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	service.clearMain();
	await settle();
	const decision = probeEvents().find((event) => event.event === "clearMain");
	assert.ok(decision !== undefined, "the archive decision must be recorded");
	assert.equal(decision.detail.branch, "keep", "the trace must name the kept-Workspace branch");
	assert.equal(decision.detail.target, OTHER_ID, "the trace must name the Workspace that came back");
}
// 34. a failing reopen must not reach the stock navigation that called the clear.
{
	resetProbes();
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	service.openWorkspace = () => {
		throw new Error("reopen failed");
	};
	service.clearMain();
	await settle();
	assert.deepEqual(calls.clearMain, [true], "a failing reopen must still let the stock clear happen");
	assert.ok(
		probeEvents().some((event) => event.event === "clearMain" && event.detail.reason === "reopen-failed"),
		"a failing reopen must be recorded"
	);
}
// 35. an unreadable projection must not block the stock clear.
{
	resetProbes();
	const { service, calls } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	service.workspaces.list.getSnapshot = () => {
		throw new Error("projection failed");
	};
	service.clearMain();
	await settle();
	assert.deepEqual(calls.clearMain, [true], "an unreadable projection must not block the stock clear");
	assert.deepEqual(calls.openWorkspace, [], "an unreadable projection must not navigate");
	assert.ok(
		probeEvents().some((event) => event.event === "clearMain" && event.detail.reason === "interception-failed"),
		"the failed interception must be recorded"
	);
}
// 36. reapplying wraps the clear once.
{
	resetProbes();
	const { service, calls, reapply } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	reapply();
	service.clearMain();
	await settle();
	assert.deepEqual(calls.clearMain, [true], "a repeated apply must run the stock clear once");
	assert.deepEqual(calls.openWorkspace, [OTHER_ID], "a repeated apply must not stack a second reopen on the first");
}
// 37. an upgrade from a revision that never wrapped the clear must wrap the stock method.
{
	resetProbes();
	const { service, calls, reapply, stock } = harness({ items: readyItems, mainReference: { sessionId: "live-session" } });
	// The installed revision wrapped only the two navigation entries: its marker
	// does not name `clearMain`, and the instance still holds the stock method.
	service.__defaultWorkspaceFallback = {
		version: 6,
		originals: {
			startSession: stock.startSession,
			restoreSelection: stock.restoreSelection
		}
	};
	service.clearMain = stock.clearMain;
	reapply();
	service.clearMain();
	await settle();
	assert.deepEqual(calls.clearMain, [true], "the upgraded wrapper must run the stock clear once");
	assert.deepEqual(calls.openWorkspace, [OTHER_ID], "an upgrade must wrap the stock clear, not delegate into a hole");
}

console.log(`ok — ${String(37)} rule groups hold for ${PKG}`);
