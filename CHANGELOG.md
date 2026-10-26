# Changelog

## 1.4.0

- **The provisional New Session row now stays out of the Workspace list until
  the composer holds input.** Stock DSH draws the selected blank Session as a
  **New Session** row as soon as it exists, so an app that opens on an empty New
  Session shows a sidebar row nothing was typed into. The browser half now hides
  that one row while the composer has no text and no typed chip, reveals it on
  the first input — typed, pasted, or inserted — and hides it again when the
  composer is cleared. The Session, its unsent draft, and every navigation rule
  are untouched; the row is released at the Session's first turn, and **Follow
  DSH** releases it along with the routing policy.
- The hide rule is a stylesheet keyed by Session id, written from the Session
  projection subscription *before* the row mounts. Hiding the row after the list
  had laid it out made the rows below jump down and back up on **New Session**;
  with the rule already in force the row enters the document with no size, so the
  list below does not move. The projection subscription is established while
  `uiWorkspace` boots, not on the first row.
- The navigation flow now **pre-hides a blank before its row can render**: the
  `connectBlank` wrapper sees the resolved Session id before `replaceMain`, the
  one moment that precedes the row, and writes the rule there. This closes the
  remaining first-click race, when the id is new and no rule exists for it yet.
  A blank that is already the main selection keeps its settled state, so
  reopening the blank you are looking at does not hide and show it again.
- While a turn is submitting, the composer's cleared draft is not treated as an
  empty composer: the row keeps its visible state until the turn starts, then
  the rule is released for good.
- `POLICY_VERSION` 7 → 11.
- New `test/blank-row.test.mjs`: 17 rules over the main blank Session, the
  composer's content state, rule generation, the hide/reveal/release cycle,
  switching blanks, the not-ready projection, the pre-hide propagation, **Follow
  DSH**, and disposal.

## 1.3.0

- **Archiving the Session you are viewing no longer strands the app on its
  *choose a Workspace* hero.** Stock `uiWorkspace.archiveSession` ends in
  `clearMain()`, which drops the main reference and the persisted selection, and
  the stock navigation watcher — a one-shot startup restore — never puts a
  Workspace back. The browser half now wraps `uiWorkspace.clearMain` as a third
  entry point and reopens the Workspace the cleared Session belonged to with a
  fresh New Session. A cleared Session that belonged to no Workspace falls back
  to the chosen folder, and a clear that removed no main Session is left exactly
  as stock left it.
- `clearMain` is wrapped rather than `archiveSession` because it is the one
  choke point every archive route passes through: the row action, the shortcut,
  the stop-and-archive dialog, an archive performed by another plugin, and the
  watcher's own `clearArchivedCurrent`.
- A method this policy has never wrapped before is now taken from the live
  service instance when an older marker is replaced, so a live re-apply of this
  revision over 1.2.0 cannot inherit a hole where `clearMain` used to be.
- `POLICY_VERSION` 6 → 7.
- Test suite: 27 → 37 rule groups (the kept Workspace, the pinned fallback,
  another row's archive, an empty clear, the **Follow DSH** choice, the trace,
  a failing reopen, an unreadable projection, a repeated apply, and the upgrade
  path from a revision that never wrapped the clear).

## 1.2.0

- The preference moved from a row inside Settings → General to a **page with its
  own navigation tab**: it registers into the `settings.section` slot at order
  30, after the shipped sections (Account −10, General 0, Models 10, Plugins 15,
  Agent presets 20), with a locale-following `label` thunk.
- The page renders the same selector and chooser, now with the registered
  Workspace count, an empty-state note when nothing is registered, and its own
  page stylesheet.
- Test rules 24–27 now assert the section registration (slot, id, order, label
  thunk) and drive the page component through its rendered element tree.

## 1.1.0

- The pinned folder is now a user preference instead of a build-time constant:
  the browser half contributes a **Default folder** row to Settings → General,
  listing every registered Workspace plus **Follow DSH** (the stock rule).
- **Choose another folder…** opens the folder chooser the Workspace UI itself
  uses — the Desktop preload dialog when present, otherwise
  `uiWorkspace.pickDirectory()`. A folder that is not registered yet is
  registered first through `uiWorkspace.workspaces.create({ path })`, the same
  adoption **Add workspace…** performs.
- The choice is stored in the page's localStorage
  (`dsh.default-workspace.settings`) and read at every routing decision, so it
  takes effect on the next New Session without a reload. With nothing stored,
  the compiled-in `DEFAULT_WORKSPACE_PATH` still applies.
- `POLICY_VERSION` 5 → 6.
- Test suite: 20 → 27 rule groups (stored preference, stock choice, unregistered
  folder, row registration, row-driven routing, adoption, cancellation).

## 1.0.0

- First release: wraps `uiWorkspace.startSession` and
  `uiWorkspace.restoreSelection` so a New Session created with no folder context
  falls back to one fixed folder instead of the most recently active Workspace.
