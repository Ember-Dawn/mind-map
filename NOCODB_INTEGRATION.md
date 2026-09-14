# NocoDB Embed Integration

This fork keeps the upstream Web UI and adds a lightweight embed bridge for the NocoDB userscript integration.

## Development deployment

The repository is intended to run as a single development container with Vue HMR enabled.

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

The container uses the repository itself as a bind mount so edits under `web/src/` are visible immediately. `/app/web/node_modules` is kept in the Docker named volume `mind-map-node-modules`, so the host source tree is not populated with container dependencies.

On the first start, the container checks for `node_modules/.bin/vue-cli-service`. If it is missing, it runs `npm ci` automatically before starting the Vue development server.

## Embed URL

Standalone mode remains unchanged. NocoDB integration is enabled only when the Web UI is opened with:

```text
/?embed=1&parentOrigin=<encoded NocoDB origin>
```

Example:

```text
/?embed=1&parentOrigin=https%3A%2F%2Fnocodb.380782744.xyz
```

In embed mode the Web UI enables the existing `window.takeOverApp` mechanism before Vue starts. The mind-map document is therefore supplied by the parent page instead of being loaded from the Web UI's normal localStorage document slot.

## Message protocol

Messages from the NocoDB parent page must use:

```js
{
  source: 'nocodb-mindmap',
  type: '...'
}
```

Messages emitted by the Web UI use:

```js
{
  source: 'mind-map-web',
  type: '...'
}
```

### Web UI -> parent

- `mindmap:ready`: bridge is loaded; parent can send initial data.
- `mindmap:app-ready`: Vue and the SimpleMindMap instance are initialized.
- `mindmap:dirty`: `{ dirty }`; emitted when the edited document changes.
- `mindmap:save`: `{ requestId, revision, data }`; explicit save request. `Ctrl/Cmd + S` triggers this message.
- `mindmap:data`: `{ data, dirty, revision }`; response to a data request.
- `mindmap:save-status`: save-result acknowledgement mirrored back for UI/integration diagnostics.

### Parent -> Web UI

- `mindmap:init`: supplies the initial full SimpleMindMap data and starts the app.
- `mindmap:request-save`: asks the Web UI to send its latest full data through `mindmap:save`.
- `mindmap:request-data`: asks the Web UI to return current data without saving.
- `mindmap:save-result`: `{ requestId, ok, error }`; acknowledges the NocoDB PATCH result.

A minimal init message is:

```js
{
  source: 'nocodb-mindmap',
  type: 'mindmap:init',
  data: {
    layout: 'mindMap',
    root: {},
    theme: {
      template: 'default',
      config: {}
    },
    view: null
  }
}
```

`mindmap:init` may also include `config`, `language`, and `localConfig`. If these optional values are omitted, embed mode keeps the Web UI configuration, language, and local UI preferences in the iframe origin's localStorage; only the mind-map document itself is delegated to NocoDB.

## Saving model

Embed mode does not treat normal `storeData()` calls as external persistence. They only refresh the bridge's in-memory document and mark it dirty. NocoDB should be written only after the parent receives an explicit `mindmap:save` message.

This supports the intended workflow:

```text
edit
  -> dirty only
  -> no NocoDB PATCH

manual save / Ctrl+S / parent close-confirm save
  -> mindmap:save
  -> userscript PATCHes NocoDB
  -> mindmap:save-result
  -> dirty=false when the saved revision is still current
```

If more edits happen while a save is in flight, a successful response for the older revision does not incorrectly clear the dirty state.

## Repository responsibilities

This repository owns the full mind-map editing UI and iframe bridge. It does not contain the NocoDB API token and does not call the NocoDB API directly.

The NocoDB userscript is responsible for:

- record/base/table context;
- NocoDB API token storage;
- GET/PATCH requests;
- the outer modal and iframe;
- close/save confirmation;
- validating the iframe origin before accepting messages.

The existing root `nginx.conf`, `dist/`, and production-style static deployment files are retained for upstream compatibility, but the provided `docker-compose.yml` uses the Vue development server for hot reload.
