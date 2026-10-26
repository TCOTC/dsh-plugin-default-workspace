# dsh-plugin-default-workspace

A small DSH plugin that pins the **no-context fallback Workspace of new
Sessions** to one folder, chosen in the Settings dialog, and keeps the
provisional **New Session** row out of the Workspace list until its composer
holds input.

## Why this exists

DSH chooses the Workspace of a new Session from context, never from
configuration:

| Situation | Stock DSH behavior | With this plugin |
|---|---|---|
| A Session holding a conversation is open in some folder | the new Session stays in that folder | unchanged |
| The app opens on a saved Session holding a conversation | that Session is restored | unchanged |
| An explicit target is passed (a workspace row's **+**, *add workspace*) | that target is used | unchanged |
| **Nothing to go on**: no saved selection, a saved Session that no longer exists, or a saved/current **empty New Session** (nothing ever sent) | the *most recently active* Workspace | **the folder chosen in Settings** |
| **The Session you are viewing is archived** | the main selection is cleared and the app drops to its *choose a Workspace* hero | **a new Session in that Session's own Workspace**, or the chosen folder when it had no Workspace |

An empty New Session is not "already conversing in another folder": DSH marks a
Session `blank` (`SessionSummary.blank`) until its first turn starts, and that
flag is what decides the last-but-one row above. Clicking a workspace row and
typing still starts the conversation in that folder; the folder only takes over
once there is a conversation in it.

Archiving is the one case where the folder that comes back is *not* the chosen
one: the conversation is gone but the project is not, so archiving a Session in
`D:\CodeProjects\Moltenfrost` leaves you in `Moltenfrost` with a fresh New
Session. A Session that belonged to no Workspace has no folder of its own to
keep, so it falls back to the chosen folder — the same rule as the row above.
Only clearing a main Session is honoured this way; archiving any other row
navigates nothing, exactly as before.

The Host owns no setting for this. The only "default workspace" concept in DSH
(`workspaceRegistry.initializeDefault`, `<Documents>\deepseek-harness\default-workspace`)
is created once on a pristine install and requires an empty Workspace registry
*and* empty Session history, so it cannot be repointed on an installation that
already has Sessions.

## The New Session row

Stock DSH draws the selected blank Session in the Workspace list right away: the
row is labeled **New Session** and exists before anything was typed into it. On
an app that opens on an empty New Session, that is a row in the sidebar the
moment the window appears.

This plugin keeps that one row out of the list until the composer holds
something:

- no text and no typed chip (a file reference or a command) -> the row is not
  shown;
- the first character typed, pasted, or inserted -> the row appears, without a
  reload and without sending anything;
- the composer cleared again -> the row hides again.

While a turn is being submitted the draft clears *before* the Session stops
being blank, so the row keeps its state for that moment instead of blinking out
between the two events; the Session's first turn then releases the rule for good.

Only the *current* blank Session is affected; every other blank Session is
already hidden by DSH, and a Session becomes an ordinary row at its first turn,
at which point this policy releases it. The Session itself, its unsent draft, and
every navigation rule are untouched: the policy hides the row, it never changes
which Session the list contains. Choosing **Follow DSH** on the settings page
releases the row as well.

The hide rule is a stylesheet keyed by Session id, not a change applied to the
row. That ordering is the point: a row hidden *after* the list has laid it out
would make the rows below jump down and then back up — clicking **New Session**
would visibly bounce the list. Two things make the ordering hold:

- the navigation flow pre-hides the Session at `connectBlank`, the moment the id
  is known and before `replaceMain` makes its row visible — this is what covers
  the *first* click, when the id is new and no rule exists for it yet;
- the row policy subscribes to the Session projection as early as it can, so a
  blank that enters the list by another route is still ahead of the render.

A blank that is already the main selection is not pre-hidden (reopening the blank
you are looking at keeps its row exactly as it was), and the stylesheet is
rewritten only when the decision changes. The row keeps no extra attributes, and
a page that never matches the id (older DSH, a different list) simply shows the
stock row.

## Choosing the folder

Settings carries one page from this plugin, **Default folder**, as its own
navigation tab (`settings.section`, order 30 — after the shipped sections):

- the selector lists every registered Workspace by path, plus **Follow DSH**,
  which switches the plugin off and restores the stock "most recently active
  Workspace" rule;
- **Choose another folder…** opens the same folder chooser the Workspace UI
  uses — the Desktop preload dialog when the shell exposes it, otherwise the
  Host chooser through `uiWorkspace.pickDirectory()`. A folder the Workspace
  registry does not know yet is registered first, exactly like
  **Add workspace…** (`uiWorkspace.workspaces.create({ path })`), so a picked
  folder is immediately usable;
- the choice is stored in the page's localStorage under
  `dsh.default-workspace.settings` and is read at every routing decision, so it
  applies to the next New Session with no reload and no re-apply.

With nothing stored, the compiled-in `DEFAULT_WORKSPACE_PATH` still applies, so
an installation that never opens the page behaves exactly as it did before. A
stored folder that is not registered has no effect and the stock rule stays in
charge — this plugin never invents a Workspace.

The preference lives in the browser, not in the Host user-settings document: the
policy this plugin installs is browser-side, and a Host-backed field would make
the host half depend on the framework's schema package, which a plugin mounted
from a bare `file:///…` path cannot resolve. See *Why localStorage* below.

## Files

| Path | Role |
|---|---|
| `package.json` | Package manifest: host half plus the `dsh.client` declaration and `exports["./client"]` the Client module system scans |
| `lib/index.js` | Host half — deliberately empty; the policy and its Settings page are browser-side |
| `lib/client.js` | Browser half — wraps `uiWorkspace.startSession`, `uiWorkspace.restoreSelection`, and `uiWorkspace.clearMain`, contributes the **Default folder** Settings page, and keeps the provisional New Session row out of the list until its composer has input |
| `test/interception.test.mjs` | Maintenance check: runs the real browser bundle against a fake `uiWorkspace` and asserts every rule above, the Settings page included |
| `test/blank-row.test.mjs` | Maintenance check: runs the same bundle against a fake document and asserts the New Session row visibility rules |
| `test/host-integration.test.mjs` | Maintenance check: asks the running Host whether it composes and serves this plugin's browser half |
| `test/probe-report.mjs` | Reads the decision trace the browser half writes into the page's localStorage |
| `CHANGELOG.md` | Release notes |
| `LICENSE` | MIT |

The browser half wraps three navigation entry points on the `uiWorkspace`
service instance. The two navigation wrappers delegate to the stock method for
every case they do not own; the third wraps the clear that ends an archive.
Every wrapper swallows its own failures back into the stock flow, so the worst
case is exactly the stock behavior.

The row policy is separate from those wrappers and reads the facts the Workspace
list and the composer already publish — `data-row-key="session:<id>"` on a row,
`data-composer-input` on the editable surface, and `data-composer-chip` on a
typed reference — plus the Session list's own `retainedBy.mainView` and `blank`
fields. Its only write is one stylesheet keyed by Session id, and a failure
leaves the row exactly as stock drew it.

### Why localStorage

The Host settings document edits fields a plugin declares with `.volatile()` in
its exported `Config` schema, which comes from `@deepseek-ai/schemastery`. A
plugin mounted as a `file:///…` Loader row resolves its own imports relative to
its directory, so that bare specifier is unreachable without shipping a
`node_modules` next to the plugin. The preference is therefore browser-local,
which is also where the policy lives. The cost is that it is per browser origin
and invisible to the Host configuration file; the benefit is a plugin with no
dependencies at all.

## Five constraints this plugin had to learn the hard way

Each one was learned against the live app rather than from documentation; the
traces from `test/probe-report.mjs` are what pinned them down.

1. **Declare no `inject`.** With `inject: ["uiWorkspace"]` the plugin never
   applied at all — no error, no console line, just a page where the policy did
   not exist. The service does not exist yet when the entry is applied
   (the trace shows `apply` → `waiting` → installed 247 ms later), so the
   browser half polls `ctx.get("uiWorkspace")` every 50 ms instead of waiting.
2. **Never read another plugin's services through a context proxy.** The stock
   bootstrap builds its supersession signal with
   `this.ctx.layout.beginNavigation()`; doing that from here throws
   `cannot get property "layout" without inject` — which made the primary path
   fall back to the stock flow. Supersession is now checked against
   `mainReference`, and `test/interception.test.mjs` runs against a service whose
   `ctx` has no `layout` at all, so this cannot regress unnoticed.
3. **`blank`, not "exists", decides.** A saved Session that still exists but
   never received a turn is an empty New Session, and must not pin its folder.
   DSH's `SessionSummary.blank` carries exactly that fact.
4. **The boot watcher is one-shot, and archiving is not a navigation entry
   point.** `uiWorkspace.watchNavigation` restores a selection exactly once, at
   startup; afterwards it only watches for one thing — a main Session that has
   become archived — and its reaction to that is `clearMain()`, which drops the
   main reference *and* the persisted selection and leaves the stock hero
   standing. Wrapping `startSession` and `restoreSelection` therefore misses
   archiving completely, and a page that archives its main Session sits on
   "choose a Workspace" until the user navigates by hand. The trace proves it:
   the two `startSession` decisions that recovered the app are 20 seconds apart,
   with nothing at all recorded in between. `clearMain` is the only choke point
   every archive route passes through — the row action, the shortcut, the
   stop-and-archive dialog, another plugin, and the watcher's own
   `clearArchivedCurrent` — so that is what gets wrapped, and it reads the
   Session's Workspace *before* delegating, because the clear is what erases the
   identity that names it.
5. **The New Session row is a DOM fact, not a service one.** No service exposes
   "is this row rendered": the row comes from the stock Workspace browser, so
   the only place to keep it out of the list is CSS aimed at the list. The rule
   has to be in force *before* the row mounts. Hiding the row after the list has
   laid it out makes the rows below jump down and back up, which is what made
   **New Session** bounce the list on the first attempts; two orderings were
   needed to remove it for good: the rule is keyed by Session id and written
   from the projection subscription, and a brand new id is pre-hidden inside the
   `connectBlank` wrapper — the one moment the id exists before `replaceMain`
   renders the row. The *first* click is the interesting one, because that is
   the only time the id is new.

## Mounting

The plugin is mounted by one patch in the profile's user patch layer,
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`. The patch dialect
(`@deepseek-ai/cordis-plugin-include`) is id-targeted, so adding a *new*
top-level row means a patch with no `id` and an `insert` list — a bare
`- id: <new id>` patch matches nothing and is skipped with a warning:

```yaml
- insert:
    - id: default-workspace
      name: file:///C:/Users/<you>/.dsh/plugins/dsh-plugin-default-workspace/lib/index.js
```

The absolute `file:` name keeps the plugin out of the profile's pnpm-managed
`node_modules`, so installing or updating other plugins cannot prune it (the
loader's own `anchorInsertedPluginNames` is what turns a `./…` name into a
file URL relative to the patch file, so an absolute one is also fine).

Reload rules when editing this plugin:

- Editing `cordis.patch.yml` **is** hot-reloaded: the profile HMR watcher
  re-applies the patch layer through `reconcileProfilePatches`, which mounts or
  unmounts this entry live. No restart needed.
- Editing `lib/client.js` reaches the running Host's Client module graph
  immediately: a new bundle revision is composed and served (proven by
  `test/host-integration.test.mjs`, which derives the revision from the file's own
  metadata). The **page**, however, does not re-fetch it on its own — the Electron
  HTTP cache showed no new bundle fetch after boot — so a **page reload or app
  restart** is what loads the new half, and with it the Settings page.
- **Bump `POLICY_VERSION` whenever the wrapped policy changes**, otherwise a page
  that already installed the old wrapper treats the new half as a no-op.

## Verify

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$plugin = "$env:USERPROFILE\.dsh\plugins\dsh-plugin-default-workspace"

# the interception rules, against a fake uiWorkspace service
& $node "$plugin\test\interception.test.mjs"

# the New Session row rules, against a fake document
& $node "$plugin\test\blank-row.test.mjs"

# the live Host actually composed and serves the browser half
& $node "$plugin\test\host-integration.test.mjs"

# what the page actually did: policy versions installed, branch per decision
& $node "$plugin\test\probe-report.mjs"
```

In the GUI:

- Open **Settings**: a **Default folder** tab must appear in the navigation,
  after the shipped sections. Pick a Workspace, or **Choose another folder…** and
  pick a directory; the page must show the new folder immediately.
- Open or start an **empty** New Session: the Workspace list must not show its
  **New Session** row, and clicking **New Session** must not move the rows below
  at all. Type a character in the composer — the row must appear at once, still
  named New Session; clear the composer and it must disappear again, again with
  no motion of the rows below. `probe-report.mjs` must show `blank-row` decisions
  with the Session id in `"hidden"` and then an empty `"hidden"`.
- Quit and reopen the app while an **empty** New Session in another folder was the
  last thing open — the app must come up on a New Session in the chosen folder,
  and that row must stay hidden until you type.
- Quit and reopen while a **conversation** in another folder was the last thing
  open — that conversation must come back, still in its own folder.
- With a conversation open in another folder, press **New Session** (Ctrl+N) —
  it must stay in that folder. With an empty New Session open in another folder,
  Ctrl+N must go to the chosen folder; a workspace row's own **+** always targets
  that row's folder.
- Select **Follow DSH** on the page and repeat the last check: the new Session must
  stay in the most recently active Workspace instead, and the empty New Session
  row must be visible again, exactly as stock draws it.
- Open a Session in a folder that is **not** the chosen one and archive it (the
  row's archive button, or its **…** menu → **Archive session**) — the app must
  come straight back to that same folder with a fresh New Session, never to the
  *choose a Workspace* hero, and `probe-report.mjs` must show a `clearMain`
  decision with `"branch":"keep"`. Archive a Session from **Ungrouped** instead:
  that one must land in the chosen folder (`"branch":"default"`). With **Follow
  DSH** selected, archiving the Session you are viewing must drop you to the
  stock hero — the interception is off along with the rest of the policy.

## Disable or remove

- Disable: delete the `- insert:` patch from `cordis.patch.yml` (the HMR watcher
  unmounts the entry live; otherwise restart).
- Remove completely: delete `%USERPROFILE%\.dsh\plugins\dsh-plugin-default-workspace`.
- Remove the stored preference: clear the `dsh.default-workspace.settings` key
  from the app's localStorage (the page's **Follow DSH** choice is stored there
  too).
- The profile patch as it was before this plugin was added is not part of this
  package; keep your own copy of `cordis.patch.yml` if you want one.

## Maintenance after a DSH update

The browser half depends on private members of the stock `uiWorkspace` service
(`workspaces.list`, `workspaces.create`, `pickDirectory`, `sessions`,
`selection`, `mainReference`, `lifetime`, `connectWorkspace`, `connectBlank`,
`openWorkspace`, `replaceMain`, `clearMain`), on
the Session summary's `blank` flag, and — for the Settings page — on the
`settings.section` slot type and the `slots`/`locale` services. The row policy
adds the stock Workspace browser's `data-row-key="session:<id>"` row marker and
the composer's `data-composer-input` / `data-composer-chip` markers. A DSH update
may rename any of them; the navigation wrappers then fail closed into the stock
behavior (a console warning appears in the renderer, and the trace records
`interception-failed`), the page either disappears or reports
`settings-page-failed`, and the row policy records `blank-row-failed` and leaves
the row as stock drew it (an id that no longer matches leaves the row visible).
Re-run the checks above after an update: a failure names the rule that broke.

`DEFAULT_WORKSPACE_PATH` and `DEFAULT_WORKSPACE_ID` in `lib/client.js` are now
only the **initial** default, used while nothing is stored; the live value is the
stored preference. Bump `POLICY_VERSION` with any policy change so the installed
page replaces the wrapper instead of keeping it.

## License

MIT — see `LICENSE`.
