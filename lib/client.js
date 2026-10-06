/**
 * Browser half of dsh-plugin-default-workspace.
 *
 * DSH picks the Workspace of a new Session from context, never from
 * configuration: `uiWorkspace.startSession()` inherits the current Session's
 * Workspace and otherwise the most recently active one, and the app-open
 * bootstrap (`restoreSelection`) does the same for its `recentWorkspace`
 * fallback. This plugin keeps every one of those rules and replaces only the
 * "no context at all" fallback with one fixed folder:
 *
 *   - a saved selection whose Session holds a real conversation     -> stock
 *   - a Session with content currently open in another folder       -> stock
 *   - an explicit `startSession(workspaceId)` target                -> stock
 *   - nothing to go on: no saved selection, an unknown Session, or
 *     an empty New Session nothing was ever sent to                 -> D:\dsh-workspace
 *
 * A blank Session is not "already conversing in another folder": DSH marks a
 * Session `blank` until its first turn starts, so an empty New Session left
 * behind in some folder must not pin that folder across a restart.
 *
 * Three properties keep this working on a live installation:
 *
 *   - The plugin declares no `inject`. A plugin that waits for a service it
 *     cannot see stays pending forever and silently installs nothing, so a
 *     missing `uiWorkspace` is polled for instead. For the same reason it must
 *     not read another plugin's services through a proxy: the stock bootstrap's
 *     `layout.beginNavigation()` throws `cannot get property "layout" without
 *     inject`, so supersession is checked against `mainReference` instead.
 *   - `restoreSelection` may have already run by the time the policy installs,
 *     so a bounded correction right after install redirects a blank Session in
 *     another folder, exactly as the wrapper would have.
 *   - Every install attempt and routing decision is appended to the page's
 *     localStorage under {@link PROBE_KEY}, which `test/probe-report.mjs` reads
 *     back from the Host side.
 *
 * The wrappers delegate to the stock implementation for everything else and
 * swallow their own failures, so the worst case is the stock behavior.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-default-workspace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/** Folder new Sessions fall back to when the app has no other folder context. */
		const DEFAULT_WORKSPACE_PATH = "D:\\dsh-workspace";
		/**
		* Durable identity of that folder's Workspace record, used when the stored
		* path spelling differs (case, separator, junction target).
		*/
		const DEFAULT_WORKSPACE_ID = "fb2689d9-7543-4430-9f73-fb714cff1d16";
		/**
		* Bump when the wrapped policy changes, so a live re-apply of this bundle
		* replaces the previous wrapper instead of leaving it installed.
		*/
		const POLICY_VERSION = 5;
		/**
		* Marker on the service instance holding the policy version and the stock
		* methods this policy wrapped, so repeated applies can neither double-wrap
		* nor delegate into an older wrapper.
		*/
		const INSTALLED = "__defaultWorkspaceFallback";
		/** localStorage key holding the bounded decision trace this plugin writes. */
		const PROBE_KEY = "dsh.default-workspace.probe";
		/** Trace length kept, newest last: enough for one app-open sequence. */
		const PROBE_LIMIT = 24;
		/** How often a service that does not exist yet is retried, in milliseconds. */
		const RETRY_MS = 50;
		/** Retry attempts before the wait is reported as given up. */
		const RETRY_LIMIT = 200;
		/** Delays after install at which a boot selection made without the policy is corrected. */
		const CORRECTION_DELAYS_MS = [500, 1500];
		/**
		* Append one decision to the page's localStorage trace. Diagnostics must
		* never affect navigation, so every failure here is swallowed.
		* @param event - short event name.
		* @param detail - optional serializable detail.
		*/
		function probe(event, detail) {
			try {
				const store = globalThis.localStorage;
				if (store === undefined) return;
				const raw = store.getItem(PROBE_KEY);
				const previous = raw === null ? undefined : JSON.parse(raw);
				const events = previous !== undefined && Array.isArray(previous.events) ? previous.events : [];
				events.push({
					at: Date.now(),
					version: POLICY_VERSION,
					event,
					...detail === undefined ? {} : { detail }
				});
				store.setItem(PROBE_KEY, JSON.stringify({
					version: POLICY_VERSION,
					events: events.slice(-PROBE_LIMIT)
				}));
			} catch {}
		}
		/**
		* Compare paths the way Windows does: separator-insensitive and case-insensitive,
		* ignoring a trailing separator.
		* @param value - workspace path as stored.
		* @returns the comparison key.
		*/
		function pathKey(value) {
			return String(value).replace(/[\\/]+$/, "").replace(/\//gu, "\\").toLowerCase();
		}
		/**
		* The fallback Workspace id: preferred by path, else by recorded identity.
		* @param workspaces - Workspace projection snapshot.
		* @returns the Workspace id, or undefined when the folder is not registered.
		*/
		function fallbackWorkspaceId(workspaces) {
			const items = workspaces === undefined || workspaces.items === undefined ? [] : workspaces.items;
			const key = pathKey(DEFAULT_WORKSPACE_PATH);
			for (const item of items) if (item !== undefined && typeof item.path === "string" && pathKey(item.path) === key) return item.workspaceId;
			for (const item of items) if (item !== undefined && item.workspaceId === DEFAULT_WORKSPACE_ID) return item.workspaceId;
			return;
		}
		/**
		* The Workspace owning a Session, or undefined when it is ungrouped.
		* @param workspaces - Workspace projection snapshot.
		* @param sessionId - Session to look up.
		* @returns the owning Workspace id.
		*/
		function ownerWorkspaceId(workspaces, sessionId) {
			for (const item of workspaces.items) if (item.sessionIds.includes(sessionId)) return item.workspaceId;
			return;
		}
		/**
		* The Workspace of the conversation the user is looking at — the folder a
		* New Session inherits, exactly as the stock `startSession` derives it.
		* An empty New Session supplies no folder: DSH's `blank` flag stays true
		* until the Session's first turn starts, so a blank Session is not
		* "already conversing in another folder".
		* @param service - `uiWorkspace` service instance.
		* @param workspaces - Workspace projection snapshot.
		* @param sessions - Session projection snapshot.
		* @returns the owning Workspace id, or undefined when nothing here is a conversation.
		*/
		function conversationWorkspaceId(service, workspaces, sessions) {
			const reference = service.mainReference;
			const current = reference === undefined ? undefined : reference.sessionId;
			if (current === undefined) return;
			const summary = sessions.byId[current];
			if (summary !== undefined && summary.blank === true) return;
			return ownerWorkspaceId(workspaces, current);
		}
		/**
		* Redirect a blank Session sitting outside the pinned folder, as the wrapper
		* would have. Used once right after install, in case the stock boot
		* selection already ran without the policy.
		* @param ctx - browser plugin context.
		*/
		function correctBootSelection(ctx) {
			try {
				const service = resolveService(ctx);
				if (service === undefined) return;
				const workspaces = service.workspaces.list.getSnapshot();
				const sessions = service.sessions.list.getSnapshot();
				if (workspaces.phase !== "ready" || sessions.phase !== "ready") return;
				const reference = service.mainReference;
				const current = reference === undefined ? undefined : reference.sessionId;
				if (current === undefined) return;
				const summary = sessions.byId[current];
				if (summary === undefined || summary.blank !== true) return;
				const target = fallbackWorkspaceId(workspaces);
				if (target === undefined) return;
				const owner = ownerWorkspaceId(workspaces, current);
				if (owner === target) return;
				probe("correct", {
					from: owner === undefined ? null : owner,
					to: target
				});
				service.openWorkspace(target).catch((reason) => {
					console.warn("default-workspace: corrective navigation failed", reason);
				});
			} catch (error) {
				probe("correct-failed", { message: String(error) });
			}
		}
		/**
		* Wrap the two navigation entry points on one service instance. The stock
		* methods are captured once on the instance: a live re-apply of a newer
		* policy version replaces the wrappers instead of stacking on them.
		* @param service - `uiWorkspace` service instance.
		* @returns whether this call installed a wrapper (false when already current).
		*/
		function install(service) {
			const previous = service[INSTALLED];
			if (previous !== undefined && previous.version === POLICY_VERSION) return false;
			const originals = previous === undefined ? {
				startSession: service.startSession,
				restoreSelection: service.restoreSelection
			} : previous.originals;
			service[INSTALLED] = {
				version: POLICY_VERSION,
				originals
			};
			const startSession = originals.startSession;
			const restoreSelection = originals.restoreSelection;
			/**
			* New Session flow: substitute the pinned folder unless the caller named a
			* target or a conversation is open in some folder.
			* @param workspaceId - explicit target, when the caller named one.
			*/
			service.startSession = function (workspaceId) {
				try {
					if (workspaceId === undefined) {
						const workspaces = service.workspaces.list.getSnapshot();
						const sessions = service.sessions.list.getSnapshot();
						if (workspaces.phase === "ready" && sessions.phase === "ready") {
							const current = conversationWorkspaceId(service, workspaces, sessions);
							const target = current === undefined ? fallbackWorkspaceId(workspaces) : undefined;
							probe("startSession", {
								branch: target === undefined ? "stock" : "default",
								current: current === undefined ? null : current,
								target: target === undefined ? null : target
							});
							if (target !== undefined) {
								service.openWorkspace(target).catch((reason) => {
									console.warn("default-workspace: new Session failed; falling back to the stock target", reason);
								});
								return;
							}
						} else probe("startSession", {
							branch: "stock",
							reason: "projections-not-ready"
						});
					}
				} catch (error) {
					probe("startSession", {
						branch: "stock",
						reason: "interception-failed",
						message: String(error)
					});
					console.warn("default-workspace: startSession interception failed; using the stock flow", error);
				}
				return startSession.call(service, workspaceId);
			};
			/**
			* App-open bootstrap: substitute the pinned folder for a persisted
			* selection that names no Session holding a conversation — unknown, or
			* still blank.
			* @param workspaces - Workspace projection snapshot.
			* @param sessions - Session projection snapshot.
			* @returns completion of the restore.
			*/
			service.restoreSelection = async function (workspaces, sessions) {
				try {
					const saved = service.selection.getSnapshot();
					const savedId = saved.sessionId;
					const summary = savedId === undefined ? undefined : sessions.byId[savedId];
					// Only a Session that moved past its first turn pins a folder; an
					// unknown or still-blank Session leaves the pinned default in charge.
					const continuesConversation = summary !== undefined && summary.blank !== true;
					if (saved.subagentAddress === undefined && !continuesConversation) {
						const target = fallbackWorkspaceId(workspaces);
						probe("restoreSelection", {
							branch: target === undefined ? "stock" : "default",
							savedId: savedId === undefined ? null : savedId,
							blank: summary === undefined ? null : summary.blank === true,
							target: target === undefined ? null : target,
							workspaces: workspaces.items.length
						});
						if (target !== undefined) {
							// `connectWorkspace` + `replaceMain` is the stock bootstrap's own
							// pair. `replaceMain`'s navigation signal normally comes from the
							// `layout` service, which this plugin may not read without an
							// `inject` it deliberately does not declare, so supersession is
							// checked here instead: a selection that appeared while
							// connecting wins.
							const sessionId = await service.connectWorkspace(target);
							if (service.mainReference === undefined) service.replaceMain(sessionId, service.lifetime.signal, "preserve");
							else probe("restoreSelection", {
								branch: "superseded",
								target
							});
							return;
						}
					} else probe("restoreSelection", {
						branch: "stock",
						reason: saved.subagentAddress === undefined ? "conversation" : "subagent",
						savedId: savedId === undefined ? null : savedId,
						blank: summary === undefined ? null : summary.blank === true
					});
				} catch (error) {
					probe("restoreSelection", {
						branch: "stock",
						reason: "interception-failed",
						message: String(error)
					});
					console.warn("default-workspace: bootstrap interception failed; using the stock flow", error);
				}
				return restoreSelection.call(service, workspaces, sessions);
			};
			return true;
		}
		/**
		* Resolve the Workspace navigation service from this context, or from the
		* root when it is registered outside this plugin's own scope.
		* @param ctx - browser plugin context.
		* @returns the service instance, or undefined while it does not exist.
		*/
		function resolveService(ctx) {
			try {
				const direct = ctx.get("uiWorkspace");
				if (direct !== undefined) return direct;
				const root = ctx.root;
				if (root === undefined || root === ctx) return;
				return root.get("uiWorkspace");
			} catch (error) {
				probe("resolve-failed", { message: String(error) });
				return;
			}
		}
		/**
		* Install the policy on the Workspace navigation service. This plugin
		* declares no `inject`: a plugin that waits for a service it cannot see
		* would stay pending forever and silently install nothing, so a missing
		* service is polled for instead.
		* @param ctx - browser plugin context.
		*/
		function apply(ctx) {
			probe("apply");
			let first = false;
			const attempt = () => {
				const service = resolveService(ctx);
				if (service === undefined) return false;
				try {
					first = install(service);
					probe("policy", {
						installed: first,
						version: POLICY_VERSION
					});
					if (first) for (const delay of CORRECTION_DELAYS_MS) setTimeout(() => correctBootSelection(ctx), delay);
				} catch (error) {
					probe("install-failed", { message: String(error) });
					console.warn("default-workspace: cannot install the default Workspace policy", error);
				}
				return true;
			};
			if (attempt()) return;
			probe("waiting", { everyMs: RETRY_MS });
			let attempts = 0;
			const timer = setInterval(() => {
				if (attempt()) clearInterval(timer);
				else if (++attempts >= RETRY_LIMIT) {
					clearInterval(timer);
					probe("gave-up", { attempts });
				}
			}, RETRY_MS);
			try {
				ctx.effect(() => () => clearInterval(timer), "default-workspace: uiWorkspace wait");
			} catch (error) {
				probe("effect-failed", { message: String(error) });
			}
		}
		exports.apply = apply;
		return module.exports;
	}
});
