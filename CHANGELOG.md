# Changelog

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
