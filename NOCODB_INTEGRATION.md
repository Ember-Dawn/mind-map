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

## Embed URL

Standalone mode remains unchanged. NocoDB integration is enabled only when the Web UI is opened with:

```text
/?embed=1&parentOrigin=<encoded NocoDB origin>
```

Example:

```text
/?embed=1&parentOrigin=https%3A%2F%2Fnocodb.380782744.xyz
```

In embed mode the Web UI enables the existing `window.takeOverApp` mechanism before Vue starts. The mind-map document is supplied by the parent page instead of being loaded from the Web UI's normal localStorage document slot.

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

- `mindmap:ready`: bridge is loaded; parent can send initial data.
- `mindmap:app-ready`: Vue and SimpleMindMap are initialized and the parent-provided full data has been applied.
- `mindmap:dirty`: `{ dirty }`; emitted when the edited document changes.
- `mindmap:save`: `{ requestId, revision, data }`; explicit save request. `Ctrl/Cmd + S` triggers this message.
- `mindmap:data`: `{ data, dirty, revision }`; response to a data request.
- `mindmap:save-status`: acknowledgement after the bridge processes `mindmap:save-result`.

### Parent -> Web UI

- `mindmap:init`: supplies the initial full SimpleMindMap data and starts the app. It may include `dirty: true` for a newly created, not-yet-persisted document.
- `mindmap:request-save`: asks the Web UI to send its latest `getData(true)` through `mindmap:save`.
- `mindmap:request-data`: asks the Web UI to return current data without saving.
- `mindmap:save-result`: `{ requestId, ok, error }`; acknowledges the NocoDB PATCH result.

A minimal init message is:

```js
{
  source: 'nocodb-mindmap',
  type: 'mindmap:init',
  dirty: true,
  data: {
    layout: 'mindMap',
    root: {},
    theme: {
      template: 'classic15',
      config: {}
    },
    view: null
  }
}
```

`mindmap:init` may also include `config`, `language`, and `localConfig`. If omitted, embed mode keeps Web UI configuration, language, and local UI preferences in the iframe origin's localStorage; only the mind-map document itself is delegated to NocoDB.

## Initialization model

The bridge waits for `mindmap:init` before starting Vue. `startApp()` also retries if `window.initApp` is not installed yet, closing the small startup race between the bridge module and `main.js`.

When the `app_inited` event supplies the SimpleMindMap instance, the bridge applies the parent-provided full data once more with `setFullData()` before reporting `mindmap:app-ready`. The parent keeps its loading cover visible until this acknowledgement. This prevents the embedded editor from briefly exposing upstream example data such as the default `根节点` before the NocoDB document is ready.

## Dirty tracking

The bridge keeps the existing takeover `saveMindMapData()` hook, but dirty tracking no longer relies on that indirect path alone.

After initialization it also listens directly to the SimpleMindMap instance for:

```text
data_change
view_data_change
```

A microtask-level dedupe combines a direct event and the corresponding `storeData()` callback into one revision increment, so ordinary edits reliably emit `mindmap:dirty` without double-counting the same change.

A new document can arrive with `dirty: true` in `mindmap:init`; this state is preserved through initialization so closing an unsaved new map still requires explicit save or discard.

## Saving model

Normal edits never call the NocoDB API. They update bridge memory and mark the current revision dirty.

```text
edit
  -> dirty only
  -> no NocoDB PATCH

manual save / Ctrl+S / parent close-confirm save
  -> getData(true)
  -> mindmap:save
  -> userscript PATCHes NocoDB
  -> mindmap:save-result
  -> bridge compares saved revision with current revision
  -> dirty=false only when they still match
```

The parent may explicitly request a save even when its own cached dirty flag is false. The Web UI always returns the current complete `getData(true)` for an explicit `mindmap:request-save`; the parent decides whether to PATCH. This makes the explicit Save button a reliable persistence action rather than depending on status synchronization.

If more edits happen while a save is in flight, the successful response for the older revision does not clear the new dirty state.

## Default theme

The NocoDB userscript creates new documents with:

```text
theme.template = classic15
```

which is the `simple-mind-map-plugin-themes` theme displayed as `脑图经典15`. Existing NocoDB mind maps retain their saved theme.

## Performance

The userscript may preconnect to the MindMap origin and create a temporary off-screen embed iframe while the NocoDB page is idle. That preload does not send `mindmap:init`, so Vue/SimpleMindMap is not instantiated for a record; it only warms the Web UI document and static module cache. The real iframe can therefore reuse already fetched resources when the user opens a mind map.

The current deployment still uses Vue Dev Server for hot reload. A future production build served by nginx can reduce cold-start overhead further.

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
