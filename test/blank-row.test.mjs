/**
 * Maintenance check for the provisional New Session row this plugin hides.
 *
 *   node test/blank-row.test.mjs
 *
 * It drives the real browser bundle against a fake document. The core rule is
 * that the hide rule lives in a stylesheet keyed by Session id and is written
 * before the row mounts — hiding the row after the list has laid it out makes
 * the rows below jump down and back up. Exit code 0 means the row is still
 * hidden exactly while the composer is empty; a failure names the rule that broke.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const clientPath = join(root, manifest.exports["./client"].default);

/** localStorage stand-in: the policy records its decision trace through it. */
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

let registration;
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			registration = value;
		}
	}
};
await import(pathToFileURL(clientPath).href);
const plugin = registration.factory((id) => (id === "react" ? {
	createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
	useState: (initial) => [initial, () => {}],
	useEffect: () => {}
} : undefined));
const {
	SETTINGS_KEY,
	blankMainSessionId,
	blankRowSelector,
	blankRowRule,
	blankRowStylesheet,
	composerContentState,
	planBlankRows,
	installBlankRowPolicy,
	install
} = plugin.internals;

const RULE = (id) => `[data-row-key="session:${id}"]{display:none!important}`;

/* ------------------------------------------------------------------ *
 * Fakes: one ready Session projection, one composer, one style sheet. *
 * ------------------------------------------------------------------ */

/** The composer's contenteditable host: text, chips, phase, and visibility. */
function makeComposer({ text = "", chips = 0, phase = "plain", visible = true } = {}) {
	const composer = {
		textContent: text,
		phase,
		getClientRects: () => (visible ? [{}] : []),
		getAttribute: (name) => (name === "data-phase" ? composer.phase : null),
		querySelector: (selector) => (selector === "[data-composer-chip]" && chips > 0 ? {} : null)
	};
	return composer;
}

/** A `uiWorkspace` stand-in carrying only the Session list the policy reads. */
function makeService(initial = {}) {
	const listeners = new Set();
	const snapshot = {
		phase: "ready",
		byId: initial,
		ids: Object.keys(initial)
	};
	const list = {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
	return {
		sessions: { list },
		snapshot,
		/** Replace the listed Sessions and notify the policy, as the Host would. */
		set(byId, phase = "ready") {
			snapshot.phase = phase;
			snapshot.byId = byId;
			snapshot.ids = Object.keys(byId);
			for (const listener of [...listeners]) listener();
		},
		listenerCount: () => listeners.size
	};
}

/** A context stand-in: the service is the only provider, effects run at once. */
function makeCtx(service) {
	const disposers = [];
	return {
		get: (name) => (name === "uiWorkspace" ? service : undefined),
		effect: (callback) => {
			const disposer = callback();
			disposers.push(disposer);
			return disposer;
		},
		disposeAll() {
			while (disposers.length > 0) disposers.pop()?.();
		}
	};
}

/** The page stand-in and the fake globals the policy reaches for. */
function makePage({ composers = [] } = {}) {
	const listeners = new Map();
	const frames = [];
	const observers = [];
	const styles = [];
	let frameId = 0;
	const document = {
		body: {},
		documentElement: {},
		head: {
			appendChild: (tag) => styles.push(tag)
		},
		createElement: () => {
			const tag = {
				dataset: {},
				textContent: ""
			};
			tag.remove = () => {
				const index = styles.indexOf(tag);
				if (index >= 0) styles.splice(index, 1);
			};
			return tag;
		},
		addEventListener: (type, listener) => {
			const list = listeners.get(type) ?? [];
			list.push(listener);
			listeners.set(type, list);
		},
		removeEventListener: (type, listener) => {
			const list = listeners.get(type) ?? [];
			const index = list.indexOf(listener);
			if (index >= 0) list.splice(index, 1);
		},
		querySelector: (selector) => {
			const match = /^style\[data-plugin-css="(.*)"\]$/u.exec(selector);
			if (match === null) return null;
			return styles.find((tag) => tag.dataset.pluginCss === match[1]) ?? null;
		},
		querySelectorAll: (selector) => (selector === "[data-composer-input]" ? composers : [])
	};
	globalThis.document = document;
	globalThis.MutationObserver = class {
		constructor(callback) {
			this.callback = callback;
			this.active = false;
			observers.push(this);
		}
		observe() {
			this.active = true;
		}
		disconnect() {
			this.active = false;
		}
	};
	globalThis.requestAnimationFrame = (callback) => {
		frames.push(callback);
		frameId += 1;
		return frameId;
	};
	globalThis.cancelAnimationFrame = () => {};
	return {
		document,
		composers,
		styles,
		listeners,
		observers,
		/** The rules the policy currently has in force. */
		rules: () => (styles.length === 0 ? "" : styles[0].textContent),
		/** Run every queued animation frame, oldest first. */
		flush() {
			while (frames.length > 0) frames.shift()();
		},
		/** Fire one document event, as the composer or shell would. */
		fire(type, event = {}) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
		},
		/** Change the composer and report the input event the editor emits. */
		type(text, chips = 0) {
			for (const composer of composers) {
				composer.textContent = text;
				composer.chips = chips;
			}
			this.fire("input");
		}
	};
}

const blankRecord = (id, mainView = 1) => ({ id, blank: true, retainedBy: { mainView } });
const liveRecord = (id, mainView = 1) => ({ id, blank: false, retainedBy: { mainView } });
const previous = () => ({ hidden: new Set(), revealed: new Set(), pending: new Set(), main: undefined });

// 1. The main blank Session is the row owner; every other Session is not.
{
	const snapshot = {
		byId: {
			live: liveRecord("live", 0),
			blank: blankRecord("blank"),
			background: blankRecord("background", 0)
		}
	};
	assert.equal(blankMainSessionId(snapshot), "blank", "only the main blank Session owns the provisional row");
	assert.equal(blankMainSessionId({ byId: { live: liveRecord("live") } }), undefined, "a conversation never owns the blank row");
	assert.equal(blankMainSessionId({ byId: { background: blankRecord("background", 0) } }), undefined, "a blank Session the main view does not retain must not be adopted");
	assert.equal(blankMainSessionId({ byId: { noRetainedBy: { id: "noRetainedBy", blank: true } } }), undefined, "a summary without retainedBy must be ignored");
	assert.equal(blankMainSessionId(undefined), undefined, "an absent projection must be ignored");
}

// 2. The composer counts text and chips, and nothing else.
{
	const reference = { ...makeComposer(), querySelector: (selector) => (selector === "[data-composer-chip]" ? {} : null) };
	const docOf = (composers) => ({ querySelectorAll: () => composers });
	assert.equal(composerContentState(docOf([makeComposer({ text: "hello" })])), true, "typed text must count as content");
	assert.equal(composerContentState(docOf([makeComposer({ text: "\n" })])), false, "an empty rich-text paragraph must not count");
	assert.equal(composerContentState(docOf([makeComposer({ text: "\u200B\uFEFF" })])), false, "the zero-width characters of an empty editor must not count");
	assert.equal(composerContentState(docOf([reference])), true, "a typed reference chip must count");
	assert.equal(composerContentState(docOf([makeComposer({ text: "hello", visible: false })])), undefined, "a composer outside the view is no evidence at all");
	assert.equal(composerContentState(docOf([makeComposer({ text: "", phase: "submitting" })])), undefined, "a composer submitting a turn must keep the current decision");
	assert.equal(composerContentState(docOf([makeComposer({ text: "", phase: "adjudicating" })])), undefined, "a composer still adjudicating must keep the current decision");
	assert.equal(composerContentState(docOf([])), undefined, "a page without a composer has nothing to judge");
}

// 3. The selector refuses to build a query out of a forged id.
{
	assert.equal(blankRowSelector("blank-1"), `[data-row-key="session:blank-1"]`, "a Session id must name its own row");
	assert.equal(blankRowSelector('x"] , body'), null, "a forged id must not reach a selector");
	assert.equal(blankRowSelector(undefined), null, "an absent id must not build a selector");
}

// 4. The stylesheet body names every hidden Session and nothing else.
{
	assert.equal(blankRowRule("blank-1"), RULE("blank-1"), "the rule must hide exactly the named row");
	assert.equal(blankRowRule("../evil"), "", "an unusable id must produce no rule");
	assert.equal(blankRowStylesheet(new Set()), "", "no hidden Session means no rules");
	assert.equal(blankRowStylesheet(new Set(["a-1", "b-2"])), `${RULE("a-1")}${RULE("b-2")}`, "every hidden Session must keep its rule");
}

// 5. The main blank stays hidden until its composer holds something.
{
	const snapshot = { byId: { blank: blankRecord("blank") } };
	const boot = planBlankRows(snapshot, "blank", "blank", undefined, previous());
	assert.deepEqual([...boot.hidden], ["blank"], "a blank row with no composer mounted must stay hidden after boot");
	const typed = planBlankRows(snapshot, "blank", "blank", true, boot);
	assert.deepEqual([...typed.hidden], [], "content must drop the hide rule");
	assert.deepEqual([...typed.revealed], ["blank"], "content must record that this blank was revealed");
	const cleared = planBlankRows(snapshot, "blank", "blank", false, typed);
	assert.deepEqual([...cleared.hidden], ["blank"], "clearing the composer must hide the row again");
	const panel = planBlankRows(snapshot, "blank", "blank", undefined, typed);
	assert.deepEqual([...panel.hidden], [], "an unmounted composer must not re-hide a row that was already revealed");
}

// 6. The rule is dropped at the first turn, and other blanks keep theirs.
{
	const twoBlanks = { byId: { a: blankRecord("a"), b: blankRecord("b") } };
	const both = { hidden: new Set(["a", "b"]), revealed: new Set(), pending: new Set(), main: "a" };
	const turned = planBlankRows({ byId: { a: liveRecord("a"), b: blankRecord("b") } }, "a", undefined, false, both);
	assert.deepEqual([...turned.hidden], ["b"], "a Session that received its first turn must lose its rule");
	const switched = planBlankRows(twoBlanks, "b", "b", false, both);
	assert.deepEqual([...switched.hidden].sort(), ["a", "b"], "switching blanks must not reveal the previous blank");
	const fresh = planBlankRows(twoBlanks, "b", "b", false, previous());
	assert.deepEqual([...fresh.hidden], ["b"], "a brand new blank is hidden from its first decision");
}

// 7. The rule is in the stylesheet before the row exists.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ blank: blankRecord("blank") });
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	assert.equal(page.rules(), RULE("blank"), "the hide rule must exist before the sidebar row mounts");
	assert.equal(page.styles.length, 1, "the policy must own exactly one stylesheet");
	ctx.disposeAll();
}

// 8. Typing drops the rule; clearing the composer restores it.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ blank: blankRecord("blank") });
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	page.type("hello");
	assert.equal(page.rules(), "", "typing must drop the rule before the next layout");
	const composer = page.composers[0];
	composer.phase = "submitting";
	page.type("");
	assert.equal(page.rules(), "", "the rule must stay off while the turn is submitting");
	composer.phase = "plain";
	page.fire("input");
	assert.equal(page.rules(), RULE("blank"), "clearing after the submission must restore the rule");
	ctx.disposeAll();
}

// 9. The rule is dropped when the blank Session receives its first turn.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ blank: blankRecord("blank") });
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	assert.equal(page.rules(), RULE("blank"), "the blank row starts hidden");
	service.set({ blank: liveRecord("blank") });
	page.flush();
	assert.equal(page.rules(), "", "the rule must be gone once the Session holds a turn");
	ctx.disposeAll();
}

// 10. Follow DSH leaves the row exactly as stock draws it.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ blank: blankRecord("blank") });
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	assert.equal(page.rules(), RULE("blank"), "the default choice hides the row first");
	store.set(SETTINGS_KEY, JSON.stringify({ target: null }));
	page.fire("input");
	assert.equal(page.rules(), "", "Follow DSH must not hide the row");
	store.delete(SETTINGS_KEY);
	ctx.disposeAll();
}

// 11. A projection that is not ready must not reveal the row and back.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ blank: blankRecord("blank") });
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	service.set({ blank: blankRecord("blank") }, "loading");
	page.flush();
	assert.equal(page.rules(), RULE("blank"), "a not-ready projection must leave the rule in force");
	service.set({ blank: blankRecord("blank") });
	page.flush();
	assert.equal(page.rules(), RULE("blank"), "the rule must still be in force when the projection returns");
	ctx.disposeAll();
}

// 12. Disposal removes the stylesheet and releases the projection.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ blank: blankRecord("blank") });
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	ctx.disposeAll();
	assert.equal(page.styles.length, 0, "disposal must remove the stylesheet");
	assert.equal(service.listenerCount(), 0, "disposal must release the Session projection");
	assert.equal(page.observers.every((observer) => observer.active === false), true, "disposal must disconnect the observer");
}

// 13. A Session pre-hidden before its row existed keeps the rule until listed.
{
	const preHidden = { hidden: new Set(["new-blank"]), revealed: new Set(), pending: new Set(["new-blank"]), main: undefined };
	const beforeList = planBlankRows({ byId: {} }, undefined, undefined, false, preHidden);
	assert.deepEqual([...beforeList.hidden], ["new-blank"], "a pre-hidden Session must stay hidden until it is listed");
	const listed = planBlankRows({ byId: { "new-blank": blankRecord("new-blank") } }, "new-blank", "new-blank", false, beforeList);
	assert.deepEqual([...listed.pending], [], "listing the Session must settle the pending mark");
	assert.deepEqual([...listed.hidden], ["new-blank"], "the listed blank must stay hidden");
	const turned = planBlankRows({ byId: { "new-blank": liveRecord("new-blank") } }, "new-blank", undefined, false, listed);
	assert.deepEqual([...turned.hidden], [], "a pre-hidden Session still loses its rule at the first turn");
}

// 14. A brand new blank is hidden before the navigation flow can render it.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({});
	let resolveBlank;
	service.connectBlank = () => new Promise((resolve) => {
		resolveBlank = resolve;
	});
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	install(service);
	const attempt = service.connectBlank("workspace-1");
	resolveBlank("session-new-blank");
	await attempt;
	assert.match(page.rules(), /session-new-blank/u, "the new blank must be hidden before replaceMain renders its row");
	ctx.disposeAll();
}

// 15. A blank reused from an earlier navigation is pre-hidden too.
{
	const page = makePage({ composers: [makeComposer()] });
	const service = makeService({ "old-blank": blankRecord("old-blank", 0) });
	let resolveBlank;
	service.connectBlank = () => new Promise((resolve) => {
		resolveBlank = resolve;
	});
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	install(service);
	const attempt = service.connectBlank("workspace-1");
	resolveBlank("old-blank");
	await attempt;
	assert.match(page.rules(), /old-blank/u, "a reused blank that is not on screen must be hidden before it renders");
	ctx.disposeAll();
}

// 16. The blank already on screen keeps the state it had.
{
	const page = makePage({ composers: [makeComposer({ text: "draft" })] });
	const service = makeService({ "old-blank": blankRecord("old-blank") });
	service.mainReference = { sessionId: "old-blank" };
	let resolveBlank;
	service.connectBlank = () => new Promise((resolve) => {
		resolveBlank = resolve;
	});
	const ctx = makeCtx(service);
	installBlankRowPolicy(ctx);
	install(service);
	assert.equal(page.rules(), "", "a blank with a draft is visible before the call");
	const attempt = service.connectBlank("workspace-1");
	resolveBlank("old-blank");
	await attempt;
	assert.equal(page.rules(), "", "reopening the blank already on screen must not change its row");
	ctx.disposeAll();
}

// 17. The previous Session's composer is not read on the switch itself.
{
	const snapshot = { byId: { "next-blank": blankRecord("next-blank") } };
	const before = {
		hidden: new Set(["next-blank"]),
		revealed: new Set(),
		pending: new Set(["next-blank"]),
		main: "old-session"
	};
	const first = planBlankRows(snapshot, "next-blank", "next-blank", true, before);
	assert.deepEqual([...first.hidden], ["next-blank"], "the old draft must not reveal the new blank on the switch");
	const second = planBlankRows(snapshot, "next-blank", "next-blank", false, first);
	assert.deepEqual([...second.hidden], ["next-blank"], "the empty new composer keeps the row hidden");
	const typed = planBlankRows(snapshot, "next-blank", "next-blank", true, second);
	assert.deepEqual([...typed.hidden], [], "a draft in the new composer reveals the row");
}

console.log("ok — 17 rules hold for the provisional New Session row");
