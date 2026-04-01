# automationdemoapp

JavaScript observability and remediation demo application for containers and Kubernetes.

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
docker run --rm -p 3000:3000 ghcr.io/danatrace/automationdemoapp:latest
```

## Kubernetes deploy

Update the image reference in `k8s/banking-observability-demo.yaml` if needed, then apply:

```bash
kubectl apply -f k8s/banking-observability-demo.yaml
kubectl -n banking-demo port-forward svc/banking-observability-demo 3000:80
```

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