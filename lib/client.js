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
 *   - the main selection cleared because the Session it held was
 *     archived, from any route (the row action, the shortcut, the
 *     stop-and-archive dialog, another plugin, the Host)            -> that Session's own
 *                                                                      Workspace, or
 *                                                                      D:\dsh-workspace when
 *                                                                      it had none
 *
 * A blank Session is not "already conversing in another folder": DSH marks a
 * Session `blank` until its first turn starts, so an empty New Session left
 * behind in some folder must not pin that folder across a restart.
 *
 * That same flag decides the one sidebar row this plugin hides. The stock
 * Workspace list draws the selected blank Session as a **New Session** row as
 * soon as it exists — at app open, that is a row nothing was ever typed into.
 * The browser half keeps a stylesheet that hides that row's id before the row
 * mounts, and drops the rule on the first input. The Session, its draft, and
 * every navigation rule are untouched; a page with no main blank Session looks
 * exactly as stock draws it, and **Follow DSH** releases the row as well.
 *
 * Four properties keep this working on a live installation:
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
 *   - Archiving the Session you are viewing does not go through either of the
 *     two navigation entries above: the stock `archiveSession` ends in
 *     `clearMain()`, which drops the main reference and the saved selection and
 *     leaves the app on its "choose a Workspace" hero, and the same
 *     `clearMain()` is what the stock navigation watcher calls when it notices
 *     the main Session was archived by some other route. `clearMain` is
 *     therefore wrapped as the third — and only — choke point of that state
 *     transition, and it reopens the cleared Session's own Workspace: archiving
 *     a conversation must not cost you the project you were in. A cleared
 *     Session that belonged to no Workspace falls back to the pinned folder, so
 *     the rule stays "no folder of your own to go on -> the chosen folder".
 *     Only a clear that actually removed a main Session is redirected; a clear
 *     with nothing selected is left exactly as stock left it.
 *   - Every install attempt and routing decision is appended to the page's
 *     localStorage under {@link PROBE_KEY}, which `test/probe-report.mjs` reads
 *     back from the Host side.
 *
 * The pinned folder is a user preference, not a build-time constant: the
 * browser half also contributes a Settings page with its own navigation tab
 * (slot `settings.section`, order 30 — after the shipped sections), where the
 * folder is chosen from the registered Workspaces or through the directory
 * picker the Workspace UI itself uses. The choice lives in the page's
 * localStorage under {@link SETTINGS_KEY} and is read at every routing
 * decision, so a change applies to the next New Session without a reload or a
 * re-apply. With no stored choice the compiled-in
 * {@link DEFAULT_WORKSPACE_PATH} still applies, so an installation that never
 * opens the page behaves exactly as before.
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
		/**
		* React as seeded by the shell's module table. Optional on purpose: the
		* routing policy must work in a page that has no Settings surface at all,
		* so a missing React only costs the settings row.
		*/
		let react = null;
		try {
			react = require("react") ?? null;
		} catch {
			react = null;
		}
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
		const POLICY_VERSION = 11;
		/**
		* Marker on the service instance holding the policy version and the stock
		* methods this policy wrapped, so repeated applies can neither double-wrap
		* nor delegate into an older wrapper.
		*/
		const INSTALLED = "__defaultWorkspaceFallback";
		/** localStorage key holding the bounded decision trace this plugin writes. */
		const PROBE_KEY = "dsh.default-workspace.probe";
		/** Trace length kept, newest last: routing decisions plus the row state changes. */
		const PROBE_LIMIT = 40;
		/** How often a service that does not exist yet is retried, in milliseconds. */
		const RETRY_MS = 50;
		/** Retry attempts before the wait is reported as given up. */
		const RETRY_LIMIT = 200;
		/** Delays after install at which a boot selection made without the policy is corrected. */
		const CORRECTION_DELAYS_MS = [500, 1500];
		/** localStorage key holding the folder the user picked in Settings. */
		const SETTINGS_KEY = "dsh.default-workspace.settings";
		/** Id of the Settings page (its own navigation tab) this plugin contributes. */
		const SETTINGS_PAGE_ID = "default-workspace";
		/**
		* Position of the navigation tab, ascending. The shipped sections sit at
		* -10 (Account), 0 (General), 10 (Models), 15 (Plugins) and 20 (Agent
		* presets); 30 places this page after the shipped ones and before the
		* third-party pages that register later in the list.
		*/
		const SETTINGS_ORDER = 30;
		/** Locale namespace owning the settings page copy. */
		const SETTINGS_NS = "default-workspace.settings";
		/** Stylesheet id of the one rule set that hides the provisional row. */
		const BLANK_ROW_CSS_ID = "dsh-plugin-default-workspace/blank-row.css";
		/**
		* Hides a blank Session row before the navigation flow can make it the main
		* selection. Assigned by the row policy while it is installed; the
		* `connectBlank` wrapper calls it the moment a new Session id is known —
		* before `replaceMain` renders the row.
		*/
		let preHideBlankRow = null;
		/** Settings-page copy, keyed by locale (the Chinese set is the key-set source). */
		const SETTINGS_TEXT = {
			zh: {
				nav: "默认文件夹",
				title: "默认文件夹",
				description: "没有任何上下文的会话使用这个文件夹；选「跟随 DSH 原生行为」则不干预。",
				stock: "跟随 DSH 原生行为",
				browse: "选择其他文件夹…",
				picking: "正在选择…",
				unregistered: "（尚未注册为工作区，暂不生效）",
				failed: "操作失败：{message}",
				pickFailed: "无法打开文件夹选择器",
				empty: "还没有注册任何工作区"
			},
			en: {
				nav: "Default folder",
				title: "Default folder",
				description: "Sessions created with no folder context use this folder; choose Follow DSH to leave DSH alone.",
				stock: "Follow DSH",
				browse: "Choose another folder…",
				picking: "Choosing…",
				unregistered: "（not a registered Workspace yet, so it has no effect）",
				failed: "Failed: {message}",
				pickFailed: "cannot open the folder picker",
				empty: "No Workspace is registered yet"
			}
		};
		/**
		* Read the stored preference.
		* @returns undefined when nothing was stored (use the compiled-in default),
		* null for the explicit "follow DSH" choice, or the pinned folder.
		*/
		function readStoredTarget() {
			try {
				const store = globalThis.localStorage;
				if (store === undefined) return;
				const raw = store.getItem(SETTINGS_KEY);
				if (raw === null) return;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return;
				if (parsed.target === null) return null;
				const target = parsed.target;
				if (target === undefined || typeof target.path !== "string" || target.path === "") return;
				return {
					path: target.path,
					workspaceId: typeof target.workspaceId === "string" ? target.workspaceId : null
				};
			} catch {
				return;
			}
		}
		/**
		* Persist the choice the settings row made. The policy reads it back on the
		* next routing decision, so no re-apply is needed.
		* @param target - the pinned folder, or null to follow DSH's own behavior.
		*/
		function writeStoredTarget(target) {
			try {
				globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify({ target }));
			} catch {}
		}
		/**
		* The folder the policy pins, as the stored preference resolves it.
		* @returns the pinned folder (the compiled-in default while nothing is
		* stored), or undefined when the user asked for DSH's own behavior.
		*/
		function resolveTarget() {
			const stored = readStoredTarget();
			if (stored === null) return;
			if (stored !== undefined) return stored;
			return {
				path: DEFAULT_WORKSPACE_PATH,
				workspaceId: DEFAULT_WORKSPACE_ID
			};
		}
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
		* The fallback Workspace id for one target: preferred by path, else by
		* recorded identity. A folder the user stored without an identity (picked
		* outside the Workspace registry) can only match by path.
		* @param workspaces - Workspace projection snapshot.
		* @param target - the pinned folder, as {@link resolveTarget} resolved it.
		* @returns the Workspace id, or undefined when the folder is not registered.
		*/
		function fallbackWorkspaceId(workspaces, target) {
			const items = workspaces === undefined || workspaces.items === undefined ? [] : workspaces.items;
			const key = pathKey(target.path);
			for (const item of items) if (item !== undefined && typeof item.path === "string" && pathKey(item.path) === key) return item.workspaceId;
			if (target.workspaceId === null || target.workspaceId === undefined) return;
			for (const item of items) if (item !== undefined && item.workspaceId === target.workspaceId) return item.workspaceId;
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
				const spec = resolveTarget();
				const target = spec === undefined ? undefined : fallbackWorkspaceId(workspaces, spec);
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
		* Wrap the three navigation entry points on one service instance. The stock
		* methods are captured once on the instance: a live re-apply of a newer
		* policy version replaces the wrappers instead of stacking on them, and a
		* method this policy has never wrapped before is taken from the instance as
		* it stands, so an upgrade from an older revision cannot inherit a hole.
		* @param service - `uiWorkspace` service instance.
		* @returns whether this call installed a wrapper (false when already current).
		*/
		function install(service) {
			const previous = service[INSTALLED];
			if (previous !== undefined && previous.version === POLICY_VERSION) return false;
			const installed = previous === undefined ? undefined : previous.originals;
			const originals = {
				startSession: installed?.startSession ?? service.startSession,
				restoreSelection: installed?.restoreSelection ?? service.restoreSelection,
				clearMain: installed?.clearMain ?? service.clearMain,
				connectBlank: installed?.connectBlank ?? service.connectBlank
			};
			service[INSTALLED] = {
				version: POLICY_VERSION,
				originals
			};
			const startSession = originals.startSession;
			const restoreSelection = originals.restoreSelection;
			const clearMain = originals.clearMain;
			const connectBlank = originals.connectBlank;
			/**
			* Blank creation is the one moment the new Session id is known before
			* `replaceMain` makes its row visible. Hiding the row here closes the one
			* frame in which a brand new blank could be laid out and then collapse —
			* the first **New Session** click, when no rule for its id exists yet.
			*
			* A Session that is already the main selection keeps its settled state
			* (clicking **New Session** on the blank you are looking at must not hide
			* its row and show it again). Every other target — a new Session, or a
			* blank reused from an earlier navigation — is pre-hidden. The wrapper
			* never alters the promise or its result.
			*/
			if (typeof connectBlank === "function") service.connectBlank = function (...args) {
				const attempt = connectBlank.apply(service, args);
				try {
					if (attempt !== undefined && typeof attempt.then === "function" && typeof preHideBlankRow === "function") {
						attempt.then((sessionId) => {
							try {
								if (typeof sessionId !== "string") return;
								if (sessionId === service.mainReference?.sessionId) return;
								preHideBlankRow(sessionId);
							} catch {}
						}, () => {});
					}
				} catch {}
				return attempt;
			};
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
							const spec = current === undefined ? resolveTarget() : undefined;
							const target = spec === undefined ? undefined : fallbackWorkspaceId(workspaces, spec);
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
						const spec = resolveTarget();
						const target = spec === undefined ? undefined : fallbackWorkspaceId(workspaces, spec);
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
			/**
			* The main selection cleared because the Session it held was archived.
			* Archiving the Session you are viewing drops the main reference and the
			* saved selection (`clearMain`), which leaves the app on its "choose a
			* Workspace" hero; nothing in the stock navigation watcher puts a
			* Workspace back, because its one-shot bootstrap has already finished.
			*
			* This plugin reopens the Workspace the cleared Session belonged to — the
			* conversation is gone, the project is not — and falls back to the pinned
			* folder when that Session had no Workspace of its own. The target is
			* resolved *before* the stock clear, because the identity of the Session
			* being cleared is what names the Workspace; a clear that removed no main
			* Session is left entirely alone, so this never invents navigation.
			*
			* `clearMain` is the choke point rather than `archiveSession`: the same
			* clear runs from the archive action's tail and from the stock watcher
			* that notices an archive performed by any other route, so every way the
			* main Session can be archived is covered once, here.
			*/
			if (typeof clearMain === "function") service.clearMain = function () {
				const reference = service.mainReference;
				const cleared = reference === undefined ? undefined : reference.sessionId;
				let target;
				let branch = "stock";
				if (cleared === undefined) {
					// Nothing was selected: this clear removed no main Session, so it is
					// stock's business and not this plugin's.
					probe("clearMain", {
						branch,
						reason: "no-main-session"
					});
				} else {
					try {
						const workspaces = service.workspaces.list.getSnapshot();
						const owner = ownerWorkspaceId(workspaces, cleared);
						if (owner !== undefined) {
							target = owner;
							branch = "keep";
						} else {
							const spec = resolveTarget();
							target = spec === undefined ? undefined : fallbackWorkspaceId(workspaces, spec);
							if (target !== undefined) branch = "default";
						}
						probe("clearMain", {
							branch,
							sessionId: cleared,
							target: target === undefined ? null : target
						});
					} catch (error) {
						target = undefined;
						probe("clearMain", {
							branch: "stock",
							reason: "interception-failed",
							message: String(error)
						});
						console.warn("default-workspace: archive interception failed; leaving the stock clear", error);
					}
				}
				clearMain.call(service);
				if (target === undefined) return;
				try {
					service.openWorkspace(target).catch((reason) => {
						console.warn("default-workspace: reopening the archived Session's Workspace failed", reason);
					});
				} catch (error) {
					probe("clearMain", {
						branch: "stock",
						reason: "reopen-failed",
						message: String(error)
					});
					console.warn("default-workspace: reopening the archived Session's Workspace failed", error);
				}
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
		* Resolve the services the settings row needs. `uiWorkspace` is polled for
		* exactly as the policy polls it; `slots` and `locale` are read the same way
		* rather than declared, because a plugin that waits for a service it cannot
		* see installs nothing at all.
		* @param ctx - browser plugin context.
		* @returns the services, each undefined while it does not exist yet.
		*/
		function resolveSurface(ctx) {
			try {
				return {
					slots: ctx.get("slots"),
					locale: ctx.get("locale"),
					service: resolveService(ctx)
				};
			} catch (error) {
				probe("resolve-surface-failed", { message: String(error) });
				return {};
			}
		}
		/**
		* Open the folder chooser the Workspace UI itself uses: the Desktop preload
		* bridge when the shell exposes one, otherwise the `uiWorkspace` service's
		* own picker (the Host chooser). Cancellation resolves to null.
		* @param service - `uiWorkspace` service instance.
		* @returns the picked path, or null when the user cancelled.
		*/
		async function pickFolder(service) {
			const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
			if (bridge !== undefined && typeof bridge.pick === "function") return await bridge.pick();
			if (service === undefined || typeof service.pickDirectory !== "function") throw new Error(SETTINGS_TEXT.en.pickFailed);
			return await service.pickDirectory();
		}
		/** Stylesheet id of the settings page, unique so a re-apply replaces it. */
		const SETTINGS_CSS_ID = "dsh-plugin-default-workspace/settings-page.css";
		/**
		* Page styles: the panel's own tokens, and the same row geometry the shipped
		* General section uses, so the page sits in the Settings panel like a
		* shipped one.
		*/
		const SETTINGS_CSS = ".dsh-dw-page{flex-direction:column;gap:4px;width:100%;display:flex}.dsh-dw-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}.dsh-dw-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}.dsh-dw-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}.dsh-dw-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;word-break:break-all}.dsh-dw-controls{align-items:center;gap:8px;display:flex}.dsh-dw-select,.dsh-dw-button{border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;align-items:center;padding:0 14px;font-size:14px;line-height:22px;max-width:280px}.dsh-dw-select:hover:not(:disabled),.dsh-dw-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dsh-dw-select:disabled,.dsh-dw-button:disabled{cursor:default;opacity:.6}.dsh-dw-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding-top:12px}";
		/**
		* Append the page's stylesheet, owned by one effect so a re-apply never
		* stacks duplicates.
		* @param ctx - browser plugin context.
		*/
		function installSettingsStyles(ctx) {
			ctx.effect(() => {
				if (typeof document === "undefined") return;
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-plugin-default-workspace";
				tag.dataset.pluginCss = SETTINGS_CSS_ID;
				tag.textContent = SETTINGS_CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "default-workspace: settings page stylesheet");
		}
		/**
		* Copy for the page when the locale service is missing: the page's own
		* language decides between the two dictionaries.
		* @param key - dictionary key.
		* @param values - placeholder values.
		* @returns the resolved copy.
		*/
		function fallbackText(key, values) {
			const language = typeof navigator === "undefined" ? "" : String(navigator.language ?? "");
			const dictionary = SETTINGS_TEXT[language.toLowerCase().startsWith("zh") ? "zh" : "en"];
			const template = dictionary[key] ?? SETTINGS_TEXT.en[key] ?? key;
			if (values === undefined) return template;
			return template.replace(/\{(\w+)\}/gu, (match, name) => (name in values ? String(values[name]) : match));
		}
		/**
		* The select's current value: the explicitly stored choice, or the compiled
		* default when it is registered.
		* @param target - the stored preference (undefined, null, or a folder).
		* @param items - registered Workspaces.
		* @returns the option key.
		*/
		function selectionKey(target, items) {
			if (target === null) return "stock";
			const spec = target === undefined ? {
				path: DEFAULT_WORKSPACE_PATH,
				workspaceId: DEFAULT_WORKSPACE_ID
			} : target;
			// Match the Registry's own entry, so a folder stored without an identity
			// still selects the Workspace that owns that path.
			const match = items.find((item) => pathKey(item.path) === pathKey(spec.path));
			if (match !== undefined) return `workspace:${match.workspaceId}`;
			if (target === undefined) return "stock";
			return `unregistered:${spec.path}`;
		}
		/**
		* The select's options: DSH's own behavior, every registered Workspace, and
		* — while one is pinned — a folder that is not registered (and therefore has
		* no effect until the sidebar adds it).
		* @param target - the stored preference.
		* @param items - registered Workspaces.
		* @param t - row copy.
		* @returns the option descriptors.
		*/
		function selectionOptions(target, items, t) {
			const options = [{
				key: "stock",
				label: t("stock")
			}];
			for (const item of items) options.push({
				key: `workspace:${item.workspaceId}`,
				label: item.path
			});
			const key = selectionKey(target, items);
			if (key.startsWith("unregistered:")) options.push({
				key,
				label: `${key.slice("unregistered:".length)} ${t("unregistered")}`
			});
			return options;
		}
		/**
		* The registered Workspaces as the row lists them.
		* @param projection - the Workspace list projection, or undefined.
		* @returns `{ workspaceId, path }` entries, empty while the projection is absent.
		*/
		function readWorkspaceItems(projection) {
			const snapshot = projection === undefined || typeof projection.getSnapshot !== "function" ? undefined : projection.getSnapshot();
			if (snapshot === undefined || snapshot.items === undefined) return [];
			return snapshot.items.map((item) => ({
				workspaceId: item.workspaceId,
				path: item.path
			}));
		}
		/**
		* The Settings page: the pinned folder, the registered Workspaces to pick
		* it from, and the Workspace UI's own folder chooser.
		* @param props - composed slot props (the injection face, the section's
		* owner props, and the page copy).
		* @returns the page element.
		*/
		function DefaultWorkspaceSettings(props) {
			const { t, service, readTarget, writeTarget, pick, adopt } = props;
			// The service instance is stable, so the projection keeps its identity
			// across renders and the subscription below survives them.
			const projection = service === undefined || service.workspaces === undefined ? undefined : service.workspaces.list;
			const [target, setTarget] = react.useState(readTarget);
			const [items, setItems] = react.useState(() => readWorkspaceItems(projection));
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			react.useEffect(() => {
				if (projection === undefined || typeof projection.subscribe !== "function") return;
				const sync = () => setItems(readWorkspaceItems(projection));
				sync();
				return projection.subscribe(sync);
			}, [projection]);
			const commit = (next) => {
				writeTarget(next);
				setTarget(next);
				setError(null);
			};
			const browse = async () => {
				setError(null);
				setBusy(true);
				try {
					const path = await pick();
					if (path === null || path === undefined) return;
					// A folder the Workspace registry already knows is adopted as-is;
					// anything else is registered first, exactly like "Add workspace…".
					const known = items.find((item) => pathKey(item.path) === pathKey(path));
					if (known !== undefined) {
						commit({
							path: known.path,
							workspaceId: known.workspaceId
						});
						return;
					}
					const created = await adopt(path);
					const registered = created === undefined || created === null ? undefined : created;
					commit({
						path: registered !== undefined && typeof registered.path === "string" ? registered.path : path,
						workspaceId: registered !== undefined && typeof registered.workspaceId === "string" ? registered.workspaceId : null
					});
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					setBusy(false);
				}
			};
			const options = selectionOptions(target, items, t);
			const children = options.map((option) => react.createElement("option", {
				key: option.key,
				value: option.key
			}, option.label));
			const picker = react.createElement("select", {
				className: "dsh-dw-select",
				value: selectionKey(target, items),
				disabled: busy || options.length === 1 && items.length === 0,
				"aria-label": t("title"),
				onChange: (event) => {
					const chosen = event.target.value;
					if (chosen === "stock") {
						commit(null);
						return;
					}
					const item = items.find((candidate) => `workspace:${candidate.workspaceId}` === chosen);
					if (item !== undefined) commit({
						path: item.path,
						workspaceId: item.workspaceId
					});
				}
			}, children);
			const button = react.createElement("button", {
				type: "button",
				className: "dsh-dw-button",
				disabled: busy,
				onClick: () => browse()
			}, busy ? t("picking") : t("browse"));
			const row = react.createElement("div", {
				className: "dsh-dw-row"
			}, react.createElement("div", {
				className: "dsh-dw-text"
			}, react.createElement("div", {
				className: "dsh-dw-title"
			}, t("title")), react.createElement("div", {
				className: "dsh-dw-desc",
				role: error === null ? undefined : "alert"
			}, error === null ? t("description") : t("failed", { message: error }))), react.createElement("div", {
				className: "dsh-dw-controls"
			}, picker, button));
			return react.createElement("div", {
				className: "dsh-dw-page"
			}, row, items.length === 0 ? react.createElement("div", {
				className: "dsh-dw-note"
			}, t("empty")) : null);
		}
		/**
		* Contribute the Settings page that edits the pinned folder. It takes its
		* own navigation tab (`settings.section`) rather than a row inside General.
		* @param ctx - browser plugin context.
		*/
		function installSettingsPage(ctx) {
			if (react === null || react.createElement === undefined) {
				probe("settings-page-skipped", { reason: "no-react" });
				return;
			}
			const attempt = () => {
				const surface = resolveSurface(ctx);
				const slots = surface.slots;
				if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return false;
				try {
					installSettingsStyles(ctx);
					let translate = null;
					if (surface.locale !== undefined && typeof surface.locale.register === "function") {
						try {
							ctx.effect(() => surface.locale.register(SETTINGS_NS, SETTINGS_TEXT), "default-workspace: settings dictionaries");
							translate = surface.locale.bind(SETTINGS_NS);
						} catch (error) {
							probe("settings-locale-failed", { message: String(error) });
						}
					}
					const t = translate ?? fallbackText;
					const injected = () => ({
						service: resolveService(ctx),
						readTarget: readStoredTarget,
						writeTarget: (target) => {
							writeStoredTarget(target);
							probe("settings-target", {
								mode: target === null ? "stock" : "pinned",
								path: target === null ? null : target.path
							});
						},
						pick: () => pickFolder(resolveService(ctx)),
						adopt: async (path) => {
							const service = resolveService(ctx);
							if (service === undefined || typeof service.workspaces.create !== "function") return;
							const created = await service.workspaces.create({ path });
							probe("settings-adopt", {
								path,
								workspaceId: created === undefined ? null : created.workspaceId
							});
							return created;
						}
					});
					// `slots.inject` only runs this once the Settings shell has declared
					// the section slot, so the probe below is the evidence that the page
					// is really in the ledger — not merely that the plugin asked for it.
					slots.inject("settings.section", () => {
						probe("settings-page-mounted", {
							id: SETTINGS_PAGE_ID,
							order: SETTINGS_ORDER,
							workspaces: readWorkspaceItems(surface.service === undefined ? undefined : surface.service.workspaces.list).length
						});
						return slots.register({
							name: "settings.section",
							id: SETTINGS_PAGE_ID,
							order: SETTINGS_ORDER,
							label: () => t("nav"),
							locale: SETTINGS_NS,
							inject: injected
						}, DefaultWorkspaceSettings);
					});
					probe("settings-page", {
						id: SETTINGS_PAGE_ID,
						order: SETTINGS_ORDER,
						translated: translate !== null
					});
				} catch (error) {
					probe("settings-page-failed", { message: String(error) });
					console.warn("default-workspace: cannot contribute the settings page", error);
				}
				return true;
			};
			if (attempt()) return;
			probe("settings-page-waiting", { everyMs: RETRY_MS });
			let attempts = 0;
			const timer = setInterval(() => {
				if (attempt()) clearInterval(timer);
				else if (++attempts >= RETRY_LIMIT) {
					clearInterval(timer);
					probe("settings-page-gave-up", { attempts });
				}
			}, RETRY_MS);
			try {
				ctx.effect(() => () => clearInterval(timer), "default-workspace: settings page wait");
			} catch (error) {
				probe("settings-page-effect-failed", { message: String(error) });
			}
		}
		/**
		* The Session the Workspace list draws as its provisional New Session row:
		* the blank Session the main view retains. That is the same fact the stock
		* list reads (`retainedBy.mainView`) to decide which blank row to show.
		* @param snapshot - Session list projection snapshot, or undefined.
		* @returns the main Session id, or undefined when there is none.
		*/
		function mainSessionId(snapshot) {
			if (snapshot === undefined || snapshot.byId === undefined) return;
			for (const summary of Object.values(snapshot.byId)) {
				if (summary === undefined) continue;
				if ((summary.retainedBy?.mainView ?? 0) > 0) return summary.id;
			}
			return;
		}
		/**
		* The selected Session when it is still blank — the provisional row's owner.
		* @param snapshot - Session list projection snapshot, or undefined.
		* @returns the main blank Session id, or undefined when there is none.
		*/
		function blankMainSessionId(snapshot) {
			const id = mainSessionId(snapshot);
			if (id === undefined) return;
			const summary = snapshot.byId[id];
			return summary !== undefined && summary.blank === true ? id : undefined;
		}
		/**
		* The selector naming one Session row in the Workspace list. The row marker
		* is the stock list's own `data-row-key`; the Session id is validated before
		* it reaches the selector, so a forged id cannot break the query.
		* @param sessionId - Session whose row to name.
		* @returns the selector, or null when the id cannot be a row key.
		*/
		function blankRowSelector(sessionId) {
			if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(sessionId)) return null;
			return `[data-row-key="session:${sessionId}"]`;
		}
		/**
		* What the composer currently holds. Typed references and command chips
		* count as content too, and the zero-width characters an empty rich-text
		* editor keeps in the document do not. A composer that is submitting a turn
		* has no verdict — its draft clears before the Session stops being blank.
		* @param doc - the page document.
		* @returns true for content, false for a mounted but empty composer, and
		* undefined when there is nothing to judge (no composer, or one submitting).
		*/
		function composerContentState(doc) {
			if (doc === undefined || typeof doc.querySelectorAll !== "function") return;
			let mounted = false;
			for (const input of doc.querySelectorAll("[data-composer-input]")) {
				if (typeof input.getClientRects === "function" && input.getClientRects().length === 0) continue;
				mounted = true;
				// While a turn is being submitted the draft is cleared before the
				// Session stops being blank, so the row must keep its current state
				// rather than blink out between the two events.
				const phase = typeof input.getAttribute === "function" ? input.getAttribute("data-phase") : null;
				if (phase === "submitting" || phase === "adjudicating") return;
				if (typeof input.querySelector === "function" && input.querySelector("[data-composer-chip]") !== null) return true;
				const text = typeof input.textContent === "string" ? input.textContent : "";
				if (text.replace(/[\u200B-\u200D\uFEFF]/gu, "").trim() !== "") return true;
			}
			return mounted ? false : undefined;
		}
		/**
		* The rule that keeps one Session's row out of the list. The rule is
		* written to a stylesheet rather than to the row, so it is already in force
		* when the row enters the DOM: hiding a row after the list has laid it out
		* makes the rows below jump down and back up, which is the motion this
		* policy exists to avoid.
		* @param sessionId - Session whose row to hide.
		* @returns the CSS rule, or an empty string for an unusable id.
		*/
		function blankRowRule(sessionId) {
			const selector = blankRowSelector(sessionId);
			return selector === null ? "" : `${selector}{display:none!important}`;
		}
		/**
		* The stylesheet body for one set of hidden Sessions.
		* @param hidden - Session ids whose rows must not render.
		* @returns the concatenated rules.
		*/
		function blankRowStylesheet(hidden) {
			const rules = [];
			for (const id of hidden) {
				const rule = blankRowRule(id);
				if (rule !== "") rules.push(rule);
			}
			return rules.join("");
		}
		/**
		* Decide which blank Session rows the stylesheet must hide.
		*
		* A hidden id survives only while its Session is still blank and listed;
		* the moment the Session receives its first turn the rule is dropped, so
		* the row comes back as an ordinary Session row. The main blank Session is
		* hidden until its composer holds content. A blank whose composer has never
		* held content stays hidden even while the composer is absent (app open, a
		* global panel); one that has been revealed once is not hidden again just
		* because the composer is temporarily unmounted.
		*
		* A pre-hidden id (the `connectBlank` wrapper hid a brand new Session before
		* its row existed) may not be in the projection yet; it is kept until the
		* Session is actually listed, then treated like any other blank.
		*
		* The composer belongs to the Session that was selected when it last
		* rendered, so the first decision after a **known** main Session changes must
		* not read it: the old draft would otherwise reveal the new blank's row for
		* the one frame before the new composer mounts. The first decision of a page
		* has no previous main to compare against and trusts the composer, so a
		* restored draft shows its row immediately.
		* @param snapshot - ready Session list projection snapshot.
		* @param mainId - the main Session id, or undefined.
		* @param mainBlankId - the main blank Session id, or undefined.
		* @param content - {@link composerContentState}'s answer.
		* @param previous - the previous `{ hidden, revealed, pending, main }` state.
		* @returns the next `{ hidden, revealed, pending, main }` state.
		*/
		function planBlankRows(snapshot, mainId, mainBlankId, content, previous) {
			const hidden = new Set();
			const revealed = new Set(previous.revealed);
			const pending = new Set(previous.pending);
			const switched = previous.main !== undefined && previous.main !== mainId;
			const judged = switched ? undefined : content;
			for (const id of previous.hidden) {
				const summary = snapshot.byId === undefined ? undefined : snapshot.byId[id];
				if (summary === undefined) {
					if (pending.has(id)) hidden.add(id);
					continue;
				}
				pending.delete(id);
				if (summary.blank === true) hidden.add(id);
			}
			if (mainBlankId !== undefined) {
				if (judged === true) {
					revealed.add(mainBlankId);
					hidden.delete(mainBlankId);
				} else if (judged === false) hidden.add(mainBlankId);
				else if (!revealed.has(mainBlankId)) hidden.add(mainBlankId);
			}
			return {
				hidden,
				revealed,
				pending,
				main: mainId
			};
		}
		/**
		* Create the stylesheet this policy owns. Rules are rewritten in place, so
		* the rules that hide a not-yet-mounted row are already present when the
		* row mounts, and no layout change is needed afterwards.
		* @param ctx - browser plugin context.
		* @returns `write(hidden)` for the policy's current hidden set.
		*/
		function createBlankRowStylesheet(ctx) {
			let tag = null;
			ctx.effect(() => {
				if (typeof document === "undefined" || document.head === null) return;
				const selector = `style[data-plugin-css=${JSON.stringify(BLANK_ROW_CSS_ID)}]`;
				const stale = document.querySelector(selector);
				if (stale !== null) stale.remove();
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-plugin-default-workspace";
				tag.dataset.pluginCss = BLANK_ROW_CSS_ID;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
					tag = null;
				};
			}, "default-workspace: blank Session row stylesheet");
			return { write: (hidden) => {
				if (tag === null) return;
				const next = blankRowStylesheet(hidden);
				if (tag.textContent !== next) tag.textContent = next;
			} };
		}
		/**
		* Keep the provisional New Session row out of the Workspace list until its
		* composer holds something. The row is stock UI — the selected blank
		* Session is drawn as New Session — so this hides that one row instead of
		* changing the list: the Session, its draft, and every navigation rule stay
		* as they are, and typing reveals the row without a reload. Choosing
		* **Follow DSH** releases the row too: the preference turns this policy off
		* along with the routing rule.
		*
		* Three signals re-read the decision: a row or composer appearing or
		* disappearing (a subtree observer), the composer emitting an input event,
		* and the Session projection changing (a blank Session becomes ordinary at
		* its first turn). The hide rule lives in a stylesheet keyed by Session id,
		* so it is in force before the row enters the document; hiding the row
		* after it has been laid out would make the list below jump down and back
		* up. Nothing throws into the shell; a failure leaves the row exactly as
		* stock drew it.
		* @param ctx - browser plugin context.
		*/
		function installBlankRowPolicy(ctx) {
			if (typeof document === "undefined") {
				probe("blank-row-skipped", { reason: "no-dom" });
				return;
			}
			const doc = document;
			const observed = doc.body ?? doc.documentElement;
			if (observed === null || observed === undefined) {
				probe("blank-row-skipped", { reason: "no-root" });
				return;
			}
			const stylesheet = createBlankRowStylesheet(ctx);
			let frame = 0;
			let disposed = false;
			let lastTrace;
			let subscribedProjection;
			let unsubscribe;
			let waitTimer = 0;
			let attempts = 0;
			let state = {
				hidden: new Set(),
				revealed: new Set(),
				pending: new Set(),
				main: undefined
			};
			/**
			* Hide a brand new blank Session before `replaceMain` can render its row.
			* The navigation wrapper calls this with the id `connectBlank` just
			* resolved, which is the only moment that precedes the row. The id is
			* marked pending until it shows up in a ready projection.
			* @param sessionId - the new blank Session id.
			*/
			const preHide = (sessionId) => {
				if (disposed) return;
				if (resolveTarget() === undefined) return;
				if (blankRowSelector(sessionId) === null) return;
				if (state.hidden.has(sessionId)) return;
				state.hidden.add(sessionId);
				state.pending.add(sessionId);
				stylesheet.write(state.hidden);
				probe("blank-row-prehide", { sessionId });
			};
			preHideBlankRow = preHide;
			/**
			* Retry until `uiWorkspace` exists. The subscription to its Session
			* projection has to be in place before the first blank row renders, or
			* the row would mount visible and only be hidden afterwards.
			*/
			const waitForService = () => {
				if (disposed || waitTimer !== 0 || subscribedProjection !== undefined) return;
				if (++attempts > RETRY_LIMIT) return;
				waitTimer = setTimeout(() => {
					waitTimer = 0;
					refresh();
				}, RETRY_MS);
			};
			/**
			* Re-read the projection and the composer, then rewrite the stylesheet.
			* Every failure is swallowed into the trace.
			*/
			const refresh = () => {
				if (disposed) return;
				try {
					const service = resolveService(ctx);
					if (service === undefined) {
						waitForService();
						return;
					}
					const projection = service.sessions === undefined ? undefined : service.sessions.list;
					if (projection === undefined) {
						waitForService();
						return;
					}
					if (projection !== subscribedProjection && typeof projection.subscribe === "function") {
						if (unsubscribe !== undefined) unsubscribe();
						subscribedProjection = projection;
						unsubscribe = projection.subscribe(schedule);
					}
					const snapshot = projection.getSnapshot?.();
					if (snapshot === undefined || snapshot.phase !== "ready") return;
					const content = composerContentState(doc);
					if (resolveTarget() === undefined) state = {
						hidden: new Set(),
						revealed: new Set(),
						pending: new Set(),
						main: undefined
					};
					else state = planBlankRows(snapshot, mainSessionId(snapshot), blankMainSessionId(snapshot), content, state);
					stylesheet.write(state.hidden);
					const trace = `${content === undefined ? "unknown" : content ? "content" : "empty"}:${[...state.hidden].sort().join(",")}`;
					if (trace !== lastTrace) {
						lastTrace = trace;
						probe("blank-row", {
							hidden: [...state.hidden],
							revealed: [...state.revealed],
							content: content === undefined ? null : content
						});
					}
				} catch (error) {
					probe("blank-row-failed", { message: String(error) });
				}
			};
			/** Coalesce DOM churn into one decision per animation frame. */
			const schedule = () => {
				if (disposed || frame !== 0) return;
				if (typeof requestAnimationFrame !== "function") {
					frame = setTimeout(() => {
						frame = 0;
						refresh();
					}, 16);
					return;
				}
				frame = requestAnimationFrame(() => {
					frame = 0;
					refresh();
				});
			};
			const onInput = () => refresh();
			const observer = typeof MutationObserver === "function" ? new MutationObserver(schedule) : undefined;
			const timers = [];
			try {
				if (observer !== undefined) observer.observe(observed, {
					childList: true,
					subtree: true
				});
				doc.addEventListener("input", onInput, true);
				doc.addEventListener("compositionend", onInput, true);
				refresh();
				// The service and the first row can land after this policy installs;
				// the subscription covers the row, these cover a slow boot.
				for (const delay of [500, 1500]) timers.push(setTimeout(refresh, delay));
			} catch (error) {
				probe("blank-row-failed", { message: String(error) });
			}
			ctx.effect(() => () => {
				disposed = true;
				if (preHideBlankRow === preHide) preHideBlankRow = null;
				for (const timer of timers) clearTimeout(timer);
				if (waitTimer !== 0) clearTimeout(waitTimer);
				if (observer !== undefined) observer.disconnect();
				doc.removeEventListener("input", onInput, true);
				doc.removeEventListener("compositionend", onInput, true);
				if (unsubscribe !== undefined) unsubscribe();
				if (frame === 0) return;
				if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
				else clearTimeout(frame);
			}, "default-workspace: blank Session row visibility");
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
			try {
				installSettingsPage(ctx);
			} catch (error) {
				probe("settings-page-failed", { message: String(error) });
			}
			try {
				installBlankRowPolicy(ctx);
			} catch (error) {
				probe("blank-row-failed", { message: String(error) });
			}
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
		/**
		* Internals the maintenance tests drive directly. The Client module system
		* only reads `apply`, so publishing these costs nothing at runtime.
		*/
		exports.internals = {
			SETTINGS_KEY,
			SETTINGS_NS,
			SETTINGS_PAGE_ID,
			SETTINGS_ORDER,
			DEFAULT_WORKSPACE_PATH,
			DEFAULT_WORKSPACE_ID,
			POLICY_VERSION,
			pathKey,
			readStoredTarget,
			writeStoredTarget,
			resolveTarget,
			fallbackWorkspaceId,
			selectionKey,
			selectionOptions,
			installSettingsPage,
			install,
			blankMainSessionId,
			blankRowSelector,
			blankRowRule,
			blankRowStylesheet,
			composerContentState,
			planBlankRows,
			createBlankRowStylesheet,
			installBlankRowPolicy
		};
		return module.exports;
	}
});
