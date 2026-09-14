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

This is **automatic rebuild + automatic publish**, not browser HMR. An already-open standalone page or NocoDB iframe continues running the JavaScript bundle it originally loaded. After `build published` appears in the builder log, refresh the standalone WebUI or close and reopen the NocoDB MindMap modal to load the new release.

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

In embed mode the Web UI uses a dedicated NocoDB adapter instead of the upstream `window.takeOverApp` document-storage path. Vue waits for `mindmap:init`; the parent-provided full document is then used directly to create the SimpleMindMap instance. Standalone mode and the upstream takeover mode remain unchanged.

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

- `mindmap:ready`: bridge is loaded and available. It is emitted on startup and also in response to `mindmap:hello`, so a prewarmed iframe can be adopted later without losing the one-time startup signal.
- `mindmap:app-ready`: Vue and SimpleMindMap are initialized from the parent-provided full data.
- `mindmap:dirty`: `{ dirty, revision }`; emitted after initialization when the live document changes. Repeated edits while already dirty still emit the new revision so auto-save debounce can restart.
- `mindmap:save`: `{ requestId, revision, data }`; explicit save request. `Ctrl/Cmd + S` triggers this message.
- `mindmap:data`: `{ data, dirty, revision }`; response to a data request.
- `mindmap:save-status`: acknowledgement after the bridge processes `mindmap:save-result`.

### Parent -> Web UI

- `mindmap:hello`: reusable readiness handshake. The bridge replies with `mindmap:ready` every time it receives a valid hello.
- `mindmap:init`: supplies the initial full SimpleMindMap data and starts the app. The NocoDB userscript normally sends `dirty: false`; initialization itself never makes the document dirty.
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

The dedicated embed bridge sets `window.nocodbMindMapEmbedMode` before Vue starts. A parent that adopts a prewarmed iframe first sends `mindmap:hello`; the bridge responds with `mindmap:ready`, after which the parent can safely send `mindmap:init`. The app still waits for `mindmap:init`; no record editor is instantiated before the parent provides the full NocoDB document.

```text
parent -> mindmap:hello
bridge -> mindmap:ready
mindmap:init
  -> deep-cloned initialData
  -> init Vue once
  -> Edit.vue calls getData()
  -> new MindMap({ data, layout, theme, themeConfig, viewData })
  -> attach the live MindMap instance to the adapter
  -> mindmap:app-ready
```

Embed mode deliberately does **not** use `window.takeOverApp` for document persistence, does not merge partial document snapshots in `api/index.js`, and does not call `setFullData()` after initialization. The live SimpleMindMap instance is therefore the only runtime document state after startup.

Standalone Web UI behavior and the upstream `window.takeOverApp` path for other integrations are preserved.

## Data ownership

The document has one-way ownership during startup and one authoritative runtime source:

```text
parent/NocoDB JSON
  -> initialData snapshot
  -> SimpleMindMap constructor

runtime
  -> live SimpleMindMap instance
  -> mindMap.getData(true) for save/data responses
```

Normal upstream `storeData()` calls are intercepted only in NocoDB embed mode and reduced to `markDirty()`. They no longer maintain a second merged document object. This avoids theme/layout/view state being overwritten by an independent storage copy.

## Dirty tracking

After initialization the adapter listens directly to the SimpleMindMap instance for:

```text
data_change
view_data_change
view_theme_change
```

Upstream `storeData()` calls in embed mode also reduce to `markDirty()` as a compatibility path. A microtask-level dedupe prevents one logical change from incrementing the revision multiple times in the same task.

Initial render events are ignored until the renderer settles. The adapter then records the current full document as the baseline and only marks dirty when a later `getData(true)` snapshot differs from that baseline. Opening a record without editing therefore remains clean.

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

## Performance

The userscript preconnects to the MindMap origin and creates a persistent off-screen embed iframe while the NocoDB page is idle. It does not send `mindmap:init`, so no record editor is created, but the Web UI document and modules are already loaded. On the next open the same iframe is moved into the modal and the parent actively performs a `mindmap:hello` -> `mindmap:ready` handshake. This avoids relying on a startup-only ready event that may have fired long before the modal existed.

The parent also has recovery timers: if the adopted iframe does not answer the handshake, or if it answers but does not reach `mindmap:app-ready` after initialization, the userscript replaces it with one fresh iframe and retries once. A second failure is surfaced as an explicit WebUI initialization error instead of leaving the loading cover forever. After a modal closes, a new off-screen iframe is prepared for the following open.

The current public deployment serves production-built hashed assets through nginx. The builder publishes a release only after the entire Vue build succeeds, and the `/site/current` symlink is switched atomically. Existing browser tabs and already-open iframes are not forcibly reloaded when a release is published; reload or reopen them after `build published` when testing new frontend behavior.

## Repository responsibilities

This repository owns the full mind-map editing UI and iframe bridge. It does not contain the NocoDB API token and does not call the NocoDB API directly.

The NocoDB userscript owns:

- record/base/table context;
- NocoDB API token storage and status UI;
- GET/PATCH requests;
- the outer modal and iframe;
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
- **The old webpack-dev-server deployment could obscure version state.** Cloudflare, iframe prewarming, fixed/static bundle URLs, and an already-open page made it possible to keep exercising an old runtime even after source changes. The current hashed production build + atomic nginx deployment was introduced to remove that ambiguity.
- **A successful source update is not the same as a successful publish.** Wait for `[static-build] ... build published ...` before testing. While a build is running, nginx intentionally keeps serving the last successful release. If a build fails, the previous release remains live.
- **Open pages do not hot-reload.** The current architecture automatically rebuilds and publishes, but does not replace JavaScript inside an already-open tab or iframe. Refresh standalone pages and reopen the NocoDB modal before testing a newly published frontend change.
- **Do not map printable Space directly to the F2 callback synchronously.** It works functionally but can corrupt the first text-editor positioning pass. Keep the current `preventDefault` + next-animation-frame F2 callback design unless the underlying SimpleMindMap input lifecycle changes and is re-tested.
- **Do not replace the runtime F2 callback with a custom `textEdit.show()` implementation without a concrete reason.** Reusing `getShortcutFn('F2')` keeps Space aligned with upstream editing behavior and reduces maintenance drift.
- **Node 20 + webpack 4 production builds need the OpenSSL compatibility option in the current toolchain.** Removing `NODE_OPTIONS=--openssl-legacy-provider` reproduces `error:0308010C:digital envelope routines::unsupported` during Terser minification. Re-evaluate this only after upgrading the frontend build stack.
- **The userscript does not need a Space-specific change.** Space editing is owned by this WebUI repository. The userscript remains responsible for NocoDB context, iframe lifecycle/prewarm, messaging, API access, and persistence.

When debugging future frontend changes, prefer this order:

```text
1. confirm source file changed
2. confirm builder log reached "build published"
3. check /build.json builtAt
4. refresh standalone WebUI / reopen NocoDB modal
5. inspect the live Vue instance or shortcut map only after the new build is definitely loaded
```
