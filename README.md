# automationdemoapp

JavaScript observability and remediation demo application for containers and Kubernetes.

## Notice

This application is currently being tested and is provided for demonstration and evaluation purposes.

Use of this application is at your own risk. The software is provided "as is" without warranties of any kind.

## Security Notice

This demo is intentionally built for observability and chaos testing, not for production banking workloads.

Before exposing this app publicly, set strong environment values:

- `SESSION_SECRET`: required in production. Use a long random value.
- `METRICS_TOKEN`: optional but recommended to protect `/metrics` with a bearer token.
- `AUTH_RATE_LIMIT_MAX`: optional auth request cap per 15-minute window (default `20`).
- `CHAOS_RATE_LIMIT_MAX`: optional chaos/load request cap per minute (default `30`).

## Features

- Simulated banking UI with login, signup, account balance, and transactions.
- Simulated stocks page with changing market prices.
- Disaster activation page with three chaos modes:
	- immediate CPU saturation
	- gradual CPU ramp over time
	- intermittent application errors
- Remediation endpoint and UI action to clear all active chaos conditions.
- Structured request and business-event logging with request correlation IDs.
- Prometheus metrics at `/metrics` and health probes at `/healthz` and `/readyz`.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Demo login:

- username: `demo`
- password: `demo123`

## Container build

```bash
docker build -t ghcr.io/danatrace/automationdemoapp:latest .
export SESSION_SECRET="$(openssl rand -hex 32)"
docker run --rm -p 3000:3000 \
	-e NODE_ENV=production \
	-e SESSION_SECRET="$SESSION_SECRET" \
	ghcr.io/danatrace/automationdemoapp:latest
```

The container image runs with `NODE_ENV=production`, so `SESSION_SECRET` must be set.

## Kubernetes deploy

1. Make sure the image in `k8s/banking-observability-demo.yaml` is pullable by your cluster.

	Option A: push to your own registry and update the image value.

	```bash
	docker build -t <your-registry>/automationdemoapp:latest .
	docker push <your-registry>/automationdemoapp:latest
	```

	Option B (local cluster): build locally and load into the cluster runtime.

	```bash
	docker build -t automationdemoapp:local .
	# kind example:
	kind load docker-image automationdemoapp:local
	```

	Then set the deployment image to `automationdemoapp:local`.
2. Set a real value for `SESSION_SECRET` in `k8s/banking-observability-demo.yaml` (replace `replace-with-a-long-random-secret`).
3. Apply the manifest and wait for rollout:

```bash
kubectl apply -f k8s/banking-observability-demo.yaml
kubectl -n banking-demo rollout status deployment/banking-observability-demo
kubectl -n banking-demo port-forward svc/banking-observability-demo 3000:80
```

If rollout does not complete, check:

```bash
kubectl -n banking-demo get pods
kubectl -n banking-demo describe pod <pod-name>
kubectl -n banking-demo logs deploy/banking-observability-demo
```

For `ImagePullBackOff`, inspect pull events first:

```bash
kubectl -n banking-demo describe pod <pod-name> | sed -n '/Events:/,$p'
```

Common causes:

- image name/tag does not exist
- private registry without `imagePullSecrets`
- local image not loaded into the cluster runtime

## Observability notes

- Server logs are JSON and include request IDs, auth events, transaction events, chaos events, and remediation events.
- Browser actions are posted back to the server through `/api/client-logs` so UI steps are traceable in one stream.
- `readyz` intentionally reports degraded state while destructive chaos modes are active to help demo remediation workflows.

## Chaos REST API

- `GET /api/chaos/status`: current aggregated chaos state.
- `GET /api/chaos/modes`: list of supported chaos modes and active state.
- `POST /api/chaos/saturation`: activate immediate CPU saturation.
- `DELETE /api/chaos/saturation`: deactivate immediate CPU saturation.
- `POST /api/chaos/ramp`: activate slow CPU ramp.
- `DELETE /api/chaos/ramp`: deactivate slow CPU ramp.
- `POST /api/chaos/errors`: activate intermittent error injection.
- `DELETE /api/chaos/errors`: deactivate intermittent error injection.
- `POST /api/chaos/:mode`: generic activation endpoint where `:mode` is `saturation`, `ramp`, or `errors`.
- `DELETE /api/chaos/:mode`: generic deactivation endpoint.
- `POST /api/chaos/remediate`: deactivate all chaos modes at once.

## Load Generator API

- `GET /api/load/status`: current load generator state (active, userCount, requestsGenerated, startedAt).
- `POST /api/load/start`: start load generator with concurrent users. Body: `{ "userCount": 1 }` (1-100000, clamped).
- `POST /api/load/stop`: stop load generator and reset state.
- Each virtual user fires randomized requests to `/api/account`, `/api/stocks`, and `/api/transactions` every 2-5 seconds.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.