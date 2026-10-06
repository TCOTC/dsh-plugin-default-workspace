# dsh-plugin-default-workspace

A small, personal DSH plugin that pins the **no-context fallback Workspace of new
Sessions** to `D:\dsh-workspace`.

## Why this exists

DSH chooses the Workspace of a new Session from context, never from
configuration:

| Situation | Stock DSH behavior | With this plugin |
|---|---|---|
| A Session holding a conversation is open in some folder | the new Session stays in that folder | unchanged |
| The app opens on a saved Session holding a conversation | that Session is restored | unchanged |
| An explicit target is passed (a workspace row's **+**, *add workspace*) | that target is used | unchanged |
| **Nothing to go on**: no saved selection, a saved Session that no longer exists, or a saved/current **empty New Session** (nothing ever sent) | the *most recently active* Workspace | **`D:\dsh-workspace`** |

An empty New Session is not "already conversing in another folder": DSH marks a
Session `blank` (`SessionSummary.blank`) until its first turn starts, and that
flag is what decides the last row above. Clicking a workspace row and typing
still starts the conversation in that folder; the folder only takes over once
there is a conversation in it.

The Host owns no setting for this. The only "default workspace" concept in DSH
(`workspaceRegistry.initializeDefault`, `<Documents>\deepseek-harness\default-workspace`)
is created once on a pristine install and requires an empty Workspace registry
*and* empty Session history, so it cannot be repointed on an installation that
already has Sessions.

## Files

| Path | Role |
|---|---|
| `package.json` | Package manifest: host half plus the `dsh.client` declaration and `exports["./client"]` the Client module system scans |
| `lib/index.js` | Host half — deliberately empty; the policy is browser-side |
| `lib/client.js` | Browser half — wraps `uiWorkspace.startSession` and `uiWorkspace.restoreSelection` |
| `test/interception.test.mjs` | Maintenance check: runs the real browser bundle against a fake `uiWorkspace` and asserts every rule above |
| `test/host-integration.test.mjs` | Maintenance check: asks the running Host whether it composes and serves this plugin's browser half |
| `test/probe-report.mjs` | Reads the decision trace the browser half writes into the page's localStorage |
| `LICENSE` | MIT |

The browser half wraps the two navigation entry points on the `uiWorkspace`
service instance. Both wrappers delegate to the stock method for every case they
do not own, and swallow their own failures back into the stock flow, so the
worst case is exactly the stock behavior.

## Three constraints this plugin had to learn the hard way

Each one caused a silent, evidence-free failure on the live Desktop app; the
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
  restart** is what loads the new half.
- **Bump `POLICY_VERSION` whenever the wrapped policy changes**, otherwise a page
  that already installed the old wrapper treats the new half as a no-op.

## Verify

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$plugin = "$env:USERPROFILE\.dsh\plugins\dsh-plugin-default-workspace"

# the interception rules, against a fake uiWorkspace service
& $node "$plugin\test\interception.test.mjs"

# the live Host actually composed and serves the browser half
& $node "$plugin\test\host-integration.test.mjs"

# what the page actually did: policy versions installed, branch per decision
& $node "$plugin\test\probe-report.mjs"
```

In the GUI:

- Quit and reopen the app while an **empty** New Session in another folder was the
  last thing open — the app must come up on a New Session in `D:\dsh-workspace`.
- Quit and reopen while a **conversation** in another folder was the last thing
  open — that conversation must come back, still in its own folder.
- With a conversation open in another folder, press **New Session** (Ctrl+N) —
  it must stay in that folder. With an empty New Session open in another folder,
  Ctrl+N must go to `D:\dsh-workspace`; a workspace row's own **+** always targets
  that row's folder.

## Disable or remove

- Disable: delete the `- insert:` patch from `cordis.patch.yml` (the HMR watcher
  unmounts the entry live; otherwise restart).
- Remove completely: delete `%USERPROFILE%\.dsh\plugins\dsh-plugin-default-workspace`.
- The profile patch as it was before this plugin was added is not part of this
  package; keep your own copy of `cordis.patch.yml` if you want one.

## Maintenance after a DSH update

The browser half depends on private members of the stock `uiWorkspace` service
(`workspaces`, `sessions`, `selection`, `mainReference`, `lifetime`,
`connectWorkspace`, `replaceMain`) and on the Session summary's `blank` flag. A
DSH update may rename them; the wrappers then fail closed into the stock behavior
(a console warning appears in the renderer, and the trace records
`interception-failed`). Re-run the checks above after an update: a failure names
the rule that broke. The constants to change are `DEFAULT_WORKSPACE_PATH` and
`DEFAULT_WORKSPACE_ID` in `lib/client.js`; bump `POLICY_VERSION` with any policy
change so the installed page replaces the wrapper instead of keeping it.

## License

MIT — see `LICENSE`.
