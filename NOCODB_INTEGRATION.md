# NocoDB Embed Integration

This fork keeps the upstream Web UI and adds a lightweight embed bridge for the NocoDB userscript integration.

## Development deployment

The repository runs as a single development container with Vue HMR enabled.

```bash
docker compose up -d --build
```

The service is exposed on the host at:

```text
http://127.0.0.1:9871
```

Recommended Cloudflare Tunnel target:

```text
http://localhost:9871
```

The repository is bind-mounted into the container so edits under `web/src/` are visible immediately. `/app/web/node_modules` is stored in the Docker named volume `mind-map-node-modules`. On first start, the container runs `npm ci` automatically if `node_modules/.bin/vue-cli-service` is missing.

The development server is published through `https://mindmap.380782744.xyz`. Because TLS terminates at Cloudflare while webpack-dev-server itself still listens on plain HTTP inside the container, `web/vue.config.js` explicitly tells the webpack-dev-server v3 client to use the public HTTPS host for SockJS/HMR instead of `localhost:8080`. The defaults can be overridden with `MIND_MAP_DEV_PUBLIC_HOST` and `MIND_MAP_DEV_PUBLIC_URL` if the public development hostname changes.

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

The current deployment still uses Vue Dev Server for hot reload. Its HMR client is configured for the Cloudflare-facing public host, so browser sessions opened through `https://mindmap.380782744.xyz` connect back through `/sockjs-node` on port 443 instead of attempting to reach the browser machine's `localhost:8080`. A future production build served by nginx can reduce cold-start overhead further.

## Repository responsibilities

This repository owns the full mind-map editing UI and iframe bridge. It does not contain the NocoDB API token and does not call the NocoDB API directly.

The NocoDB userscript owns:

- record/base/table context;
- NocoDB API token storage and status UI;
- GET/PATCH requests;
- the outer modal and iframe;
- explicit save and close confirmation;
- validating the iframe origin before accepting messages.

The existing root `nginx.conf`, `dist/`, and production-style static deployment files are retained for upstream compatibility, while the provided `docker-compose.yml` uses the Vue development server for hot reload.

## Node-edit shortcut

Across the full WebUI, including standalone mode and NocoDB embed mode, `F2` keeps its upstream behavior and `Space` enters the same node editor through the callback that the live SimpleMindMap instance registered for `F2`.

`Space` is intentionally handled by a small capture-phase `keydown` adapter rather than being registered as another SimpleMindMap `keyCommand` shortcut. The adapter only acts when exactly one node is selected, no text editor is already open, no modifier key is pressed, and focus is not in an input, textarea, select, or contenteditable element. It prevents the triggering Space from becoming text input, stops that key event from reaching the normal shortcut chain, and invokes the upstream F2 callback on the next animation frame. Delaying the callback until the original Space event has finished avoids the RichText/TextEdit editor being created and immediately affected by the same printable key event, which previously could make the first editor frame appear at the page origin before a later input corrected its position.

Once node editing is active, the adapter does nothing, so Space is ordinary text input inside both the plain text editor and the RichText editor. The implementation still reuses the installed runtime `simple-mind-map` F2 behavior rather than maintaining a separate node-edit path.
