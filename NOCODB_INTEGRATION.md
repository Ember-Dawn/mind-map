# NocoDB Embed Integration

This fork keeps the upstream Web UI and adds a lightweight embed bridge for the NocoDB userscript integration.

## Deployment

The public WebUI no longer runs directly from webpack-dev-server. The repository now uses two Docker services:

```text
mind-map-builder
  -> watches WebUI source
  -> runs a production Vue build
  -> publishes a complete static release under /site

mind-map
  -> nginx
  -> serves /site/current on port 80
```

The service is exposed on the host at:

```text
http://127.0.0.1:9871
```

Recommended Cloudflare Tunnel target:

```text
http://localhost:9871
```

Initial deployment or any Docker/Compose configuration change requires rebuilding the containers:

```bash
docker compose down
docker compose up -d --build
```

After that, normal WebUI source updates do not require a container restart. `mind-map-builder` watches:

```text
web/src/
web/public/
web/vue.config.js
```

When one of those paths changes, `web/scripts/static-watch.js` debounces the events, runs a production Vue build, copies the complete build to a new release directory, writes `build.json`, and atomically switches `/site/current` to the new release. Nginx keeps serving the previous successful release while a new build is running, so a failed build does not replace the working site with a partial or broken release.

This is **automatic rebuild + automatic publish**, not browser HMR. An already-open standalone page or NocoDB iframe continues running the JavaScript bundle it originally loaded. After `build published` appears in the builder log, refresh the standalone WebUI or refresh the current NocoDB page before testing the new embed build. Closing and reopening the MindMap modal is not sufficient anymore because the current integration keeps one iframe alive and reuses it across modal opens and record switches.

Useful commands:

```bash
docker compose logs -f mind-map-builder
```

A successful build ends with a message similar to:

```text
[static-build] ... build published in 18.4s
```

The currently served release exposes:

```text
/build.json
```

Its `builtAt` timestamp is a simple way to verify that the public site has switched to a newly published build.

The production bundles use hashed filenames and nginx sends `Cache-Control: no-store` headers. This avoids the earlier failure mode where GitHub and the container source were current but the browser still executed an old fixed-name bundle.

The builder currently uses Node 20 with the repository's Vue CLI 4 / webpack 4 toolchain. Because webpack 4's production minification path is not natively compatible with OpenSSL 3, the builder container sets:

```text
NODE_OPTIONS=--openssl-legacy-provider
```

Do not remove this compatibility option unless the frontend build toolchain is upgraded and a production build has been verified without it.

## Embed URL

Standalone mode remains unchanged. NocoDB integration is enabled only when the Web UI is opened with:

```text
/?embed=1&parentOrigin=<encoded NocoDB origin>
```

Example:

```text
/?embed=1&parentOrigin=https%3A%2F%2Fnocodb.380782744.xyz
```

In embed mode the Web UI uses a dedicated NocoDB adapter instead of the upstream `window.takeOverApp` document-storage path. Vue waits for the first `mindmap:init`; the parent-provided full document is then used directly to create the SimpleMindMap instance. Later `mindmap:init` messages reuse the already-running Vue/SimpleMindMap instance to switch the current record document. Standalone mode and the upstream takeover mode remain unchanged.

## Message protocol

Parent messages:

```js
{
  source: 'nocodb-mindmap',
  type: '...'
}
```

Web UI messages:

```js
{
  source: 'mind-map-web',
  type: '...'
}
```

### Web UI -> parent

- `mindmap:ready`: bridge is loaded and available. It is emitted on startup and also in response to `mindmap:hello`, so readiness can be re-confirmed without relying on a one-time startup signal.
- `mindmap:app-ready`: the current record document has finished initial loading or a later record switch and is ready for editing.
- `mindmap:dirty`: `{ dirty, revision }`; emitted after initialization when the live document changes. Repeated edits while already dirty still emit the new revision so auto-save debounce can restart.
- `mindmap:save`: `{ requestId, revision, data }`; explicit save request. `Ctrl/Cmd + S` triggers this message.
- `mindmap:data`: `{ data, dirty, revision }`; response to a data request.
- `mindmap:save-status`: acknowledgement after the bridge processes `mindmap:save-result`.

### Parent -> Web UI

- `mindmap:hello`: reusable readiness handshake. The bridge replies with `mindmap:ready` every time it receives a valid hello.
- `mindmap:init`: supplies a complete SimpleMindMap document. The first valid init starts Vue/SimpleMindMap; later init messages replace the current record document in the persistent instance and reset the dirty/save baseline. The NocoDB userscript normally sends `dirty: false`; initialization itself never makes the document dirty.
- `mindmap:request-save`: asks the Web UI to send its latest `getData(true)` through `mindmap:save`.
- `mindmap:request-data`: asks the Web UI to return current data without saving.
- `mindmap:save-result`: `{ requestId, ok, error }`; acknowledges the NocoDB PATCH result.

A minimal init message is:

```js
{
  source: 'nocodb-mindmap',
  type: 'mindmap:init',
  dirty: false,
  data: {
    layout: 'logicalStructure',
    root: {},
    theme: {
      template: 'classic15',
      config: {}
    },
    view: null
  }
}
```

Language, editor configuration, and local UI preferences remain normal Web UI localStorage settings. They are not a second mind-map document store. In the SimpleMindMap constructor, the NocoDB document's `data`, `layout`, `theme`, `themeConfig`, and `viewData` are applied after general editor config so an old local config cannot override the record's saved document state.

## Initialization model

The dedicated embed bridge sets `window.nocodbMindMapEmbedMode` before Vue starts. The first iframe load follows a normal `mindmap:hello` -> `mindmap:ready` handshake. The app still waits for the first `mindmap:init`; no record editor is instantiated before the parent provides the full NocoDB document.

First open in a NocoDB page:

```text
iframe load
parent -> mindmap:hello
bridge -> mindmap:ready
mindmap:init
  -> deep-cloned initialData
  -> init Vue once
  -> Edit.vue calls getData()
  -> new MindMap({ data, layout, theme, themeConfig, viewData })
  -> attach the live MindMap instance to the adapter
  -> establish baseline after render settles
  -> mindmap:app-ready
```

Later record switches reuse that same running app:

```text
parent reads Record B
parent -> mindmap:init(Record B full document)
  -> cancel/clear previous record transient save state
  -> replace bridge initialData/current document context
  -> existing MindMap.setFullData(...)
  -> reset view/render for the new full document
  -> establish a new baseline after render settles
  -> mindmap:app-ready
```

Embed mode deliberately does **not** use `window.takeOverApp` for document persistence and does not merge partial document snapshots in `api/index.js`. The live SimpleMindMap instance remains the only runtime document state. `setFullData()` is used only when switching a persistent iframe from one complete NocoDB record document to another; it is not a second storage layer.

Standalone Web UI behavior and the upstream `window.takeOverApp` path for other integrations are preserved.

## Data ownership

The document has one authoritative parent source at load/switch time and one authoritative runtime source while editing:

```text
first record
parent/NocoDB JSON
  -> initialData snapshot
  -> SimpleMindMap constructor

later record switch
parent/NocoDB JSON
  -> new full-document snapshot
  -> existing SimpleMindMap.setFullData(...)

runtime
  -> live SimpleMindMap instance
  -> mindMap.getData(true) for save/data responses
```

Normal upstream `storeData()` calls are intercepted only in NocoDB embed mode and reduced to `markDirty()`. They do not maintain a second merged document object. This avoids theme/layout/view state being overwritten by an independent storage copy.

## Dirty tracking

After initialization the adapter listens directly to the SimpleMindMap instance for:

```text
data_change
view_data_change
view_theme_change
```

Upstream `storeData()` calls in embed mode also reduce to `markDirty()` as a compatibility path. A microtask-level dedupe prevents one logical change from incrementing the revision multiple times in the same task.

Initial render events are ignored until the renderer settles. The adapter then records the current full document as the baseline and only marks dirty when a later `getData(true)` snapshot differs from that baseline. Opening a record without editing therefore remains clean.

Before a later `mindmap:init` switches records, the bridge clears the previous document's auto-save/pending-save state and resets initialization guards. The new document establishes its own baseline only after its render settles, so asynchronous state from the previous record cannot clear or mark dirty on the new record.

## Saving model

Normal edits update the live SimpleMindMap instance and mark the current revision dirty. Embed mode uses a 2-second debounce: every real document change restarts the timer; after 2 seconds without another change the bridge automatically sends the current full `getData(true)` to the parent for persistence.

```text
edit
  -> dirty
  -> restart 2 s timer
  -> auto-save current getData(true)

manual save / Ctrl+S / parent close-confirm save
  -> live mindMap.getData(true)
  -> deep-cloned full data
  -> mindmap:save
  -> userscript PATCHes NocoDB
  -> mindmap:save-result
  -> bridge compares saved revision with current revision
  -> dirty=false only when they still match
```

Manual save remains available and bypasses the debounce delay. The parent may explicitly request a save even when its own cached dirty flag is false. The Web UI always returns the current complete `getData(true)` for an explicit `mindmap:request-save`; the parent decides whether to PATCH. This makes the explicit Save button a reliable persistence action rather than depending on status synchronization.

If more edits happen while a save is in flight, the successful response for the older revision does not clear the new dirty state.

## Default layout and theme

The NocoDB userscript creates new documents with:

```text
layout = logicalStructure
theme.template = classic15
```

`logicalStructure` is the right-expanding `逻辑结构图`; `classic15` is the `simple-mind-map-plugin-themes` theme displayed as `脑图经典15`. Existing NocoDB mind maps retain their saved layout and theme.

## Performance and iframe lifecycle

The current integration uses **preconnect + first-use lazy load + one persistent iframe per NocoDB page**.

When the NocoDB page starts, the userscript only adds a preconnect hint for the MindMap origin. It does **not** create a hidden/off-screen MindMap iframe and does not start Vue or SimpleMindMap in the background.

```text
NocoDB page start
  -> preconnect to mindmap origin only

first MindMap open
  -> create the real iframe
  -> iframe loads WebUI
  -> hello / ready
  -> init current record
  -> Vue + SimpleMindMap start once

modal close
  -> hide the outer modal
  -> keep iframe / Vue / SimpleMindMap alive

later MindMap open
  -> reuse the same iframe
  -> fetch target NocoDB record
  -> send a new mindmap:init
  -> switch full document in the existing instance
```

This means resource usage is **not one iframe per record** and **not one iframe per table**. Within one NocoDB browser tab / SPA page instance there is at most one persistent MindMap iframe, shared by all records and by table navigation that does not cause a full page reload. A second NocoDB browser tab has its own userscript runtime and therefore may keep its own single persistent iframe.

The trade-off is deliberate: after the first use, one iframe document, one Vue app, one SimpleMindMap instance, and the current record document stay in memory until that NocoDB page is refreshed or closed. In return, later opens avoid re-downloading and reinitializing the whole WebUI and normally pay only the NocoDB GET plus full-document switch/render cost.

The parent still has recovery timers, but the iframe handshake timer starts only after the real iframe `load` event. Network download time is therefore no longer counted against the 8-second hello/ready window. This avoids the old failure mode where a slow-but-valid first load was declared failed, replaced, and then appeared to work only on the retry because browser caches were warm.

The current public deployment serves production-built hashed assets through nginx. The builder publishes a release only after the entire Vue build succeeds, and the `/site/current` symlink is switched atomically. Existing browser tabs and persistent NocoDB iframes are not forcibly reloaded when a release is published; refresh the NocoDB page after `build published` when testing new frontend behavior.

## Repository responsibilities

This repository owns the full mind-map editing UI and iframe bridge. It does not contain the NocoDB API token and does not call the NocoDB API directly.

The NocoDB userscript owns:

- record/base/table context;
- NocoDB API token storage and status UI;
- GET/PATCH requests;
- the outer modal and persistent iframe lifecycle;
- explicit save and close confirmation;
- validating the iframe origin before accepting messages.

The root `Dockerfile`, `docker-compose.yml`, `nginx.conf`, and `web/scripts/static-watch.js` implement the current production-style auto-build/static-serving deployment. The upstream-style `dist/` and other production-compatible files remain in the repository where needed, but the public service no longer depends on webpack-dev-server/HMR.

## Node-edit shortcut

Across the full WebUI, including standalone mode and NocoDB embed mode, `F2` keeps its upstream behavior. `Space` is implemented as a thin adapter in `Edit.vue`; it does **not** maintain a separate node-edit implementation.

When a plain Space keydown is received, the adapter only acts when exactly one node is selected, no text editor is already open, no modifier key is held, the key is not an IME composition/repeat event, and focus is not inside an input, textarea, select, or contenteditable element. It then synchronously calls `preventDefault()`, `stopPropagation()`, and `stopImmediatePropagation()` so the printable Space event cannot reach the text editor or the normal shortcut chain.

The adapter waits until the next animation frame and then re-checks the selection/editing state. It retrieves the **current runtime F2 callback** from `mindMap.keyCommand.getShortcutFn('F2')` and calls that callback. Therefore the edit operation itself still follows SimpleMindMap's own installed F2 behavior, but it runs after the original printable Space key event has completely finished.

This delay is important. A previous implementation registered the F2 callback directly under `Spacebar` in SimpleMindMap's `keyCommand` map. That made Space open the editor, but because Space is a printable key, the same keydown could affect the newly created text editor. The visible symptom was that the editor/text first appeared near the page's upper-left corner and moved back to the selected node after the next typed character triggered a fresh measurement/render. Separating the printable Space event from the F2 callback by one animation frame removes that positioning glitch.

## Maintenance notes and known pitfalls

The following points were verified during the NocoDB/Space integration work and should be treated as maintenance constraints rather than rediscovered assumptions:

- **Source freshness must be verified at runtime.** During earlier debugging, GitHub and the bind-mounted source contained new methods while the browser's Vue instance did not. Console checks such as `typeof document.querySelector('.editContainer')?.__vue__?.<method>` exposed that the page was still executing an old bundle. Do not conclude that a new shortcut implementation is broken until the served build is confirmed current.
- **The old webpack-dev-server deployment could obscure version state.** Cloudflare, iframe caching, fixed/static bundle URLs, and an already-open page made it possible to keep exercising an old runtime even after source changes. The current hashed production build + atomic nginx deployment was introduced to remove that ambiguity.
- **A successful source update is not the same as a successful publish.** Wait for `[static-build] ... build published ...` before testing. While a build is running, nginx intentionally keeps serving the last successful release. If a build fails, the previous release remains live.
- **Open pages and persistent iframes do not hot-reload.** The current architecture automatically rebuilds and publishes, but does not replace JavaScript inside an already-open tab or the persistent NocoDB iframe. Refresh standalone pages and refresh the NocoDB page before testing a newly published frontend change; merely closing/reopening the modal reuses the old iframe.
- **Keep one persistent iframe per NocoDB page.** Do not reintroduce one iframe per record/table or background off-screen iframe accumulation. Record switches should reuse the existing app and replace the complete document through the embed bridge.
- **Do not start handshake timeout before iframe `load`.** Network loading and hello/ready handshake are different phases. Starting the 8-second handshake timer before `load` can recreate the old false-timeout/retry behavior on cold or slow loads.
- **Do not map printable Space directly to the F2 callback synchronously.** It works functionally but can corrupt the first text-editor positioning pass. Keep the current `preventDefault` + next-animation-frame F2 callback design unless the underlying SimpleMindMap input lifecycle changes and is re-tested.
- **Do not replace the runtime F2 callback with a custom `textEdit.show()` implementation without a concrete reason.** Reusing `getShortcutFn('F2')` keeps Space aligned with upstream editing behavior and reduces maintenance drift.
- **Node 20 + webpack 4 production builds need the OpenSSL compatibility option in the current toolchain.** Removing `NODE_OPTIONS=--openssl-legacy-provider` reproduces `error:0308010C:digital envelope routines::unsupported` during Terser minification. Re-evaluate this only after upgrading the frontend build stack.
- **The userscript does not need a Space-specific change.** Space editing is owned by this WebUI repository. The userscript remains responsible for NocoDB context, persistent iframe lifecycle, messaging, API access, and persistence.

When debugging future frontend changes, prefer this order:

```text
1. confirm source file changed
2. confirm builder log reached "build published"
3. check /build.json builtAt
4. refresh standalone WebUI / refresh the NocoDB page
5. inspect the live Vue instance or shortcut map only after the new build is definitely loaded
```
