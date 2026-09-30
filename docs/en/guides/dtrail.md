# d-trail trace service

d-trail is an optional provenance and plan-verification service for DataFoundry. It runs plans, records a trace trail of the decisions taken, and validates that trail end-to-end. The service lives in its own repository (Python, FastAPI) and runs as a separate process.

## Runtime topology

| Process | Default endpoint | Purpose |
| --- | --- | --- |
| d-trail MCP | `http://127.0.0.1:8060/mcp` | Exposes `dtrail_plan_verify`, `dtrail_trail_read`, `dtrail_candidate_list` for agent grounding |
| d-trail REST | `http://127.0.0.1:8061` | Run management, trail readback and validation API |

DataFoundry's Web and API processes remain unchanged. d-trail is not started by `deploy.sh` or `npm run start`; start it separately when trace/plan verification is needed.

## Install and start

The d-trail service is developed in its own repository. Install Python 3.10+ and the project's dependencies (see the d-trail README), then start both processes in separate terminals:

```bash
uv run dtrail-serve --port 8060 --transport streamable-http
uv run dtrail-api --port 8061
```

The two ports correspond to the MCP (`:8060/mcp`) and REST (`:8061`) endpoints in the table above. The d-trail README contains provider examples and CLI commands for running and validating trails.

## Connect it in DataFoundry

In the Web workbench, open MCP settings and add an external server with:

| Field | Example |
| --- | --- |
| `name` | `d-trail` |
| `serverUrl` | `http://127.0.0.1:8060/mcp` |
| `apiUrl` | `http://127.0.0.1:8061` |
| `transport` | `streamable-http` |
| `toolManifest` | `[{ "name": "dtrail_plan_verify" }, { "name": "dtrail_trail_read" }, { "name": "dtrail_candidate_list" }]` |

Use a name or id containing `dtrail` so the d-trail panel recognizes the server.

## Verify

```bash
curl http://127.0.0.1:8061/healthz
```

If the panel reports the service as unavailable, check both processes, ports, and the MCP transport. Keep API keys in environment variables or a secret manager; if the d-trail service reads a `service_token` for bearer auth, configure it in the MCP server secret, not in the request bodies.

## Security notes

The d-trail REST API accepts an optional bearer token via `service_token`. When it is enabled, supply it through the Web MCP settings secret so the `/dtrail` proxy forwards the `Authorization` header to the service. Do not paste tokens into guide examples or run bodies.
