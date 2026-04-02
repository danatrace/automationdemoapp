#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-banking.localtest.me}"

kubectl get namespace banking-demo >/dev/null 2>&1 || kubectl create namespace banking-demo

sed 's~domain.placeholder~'"$DOMAIN"'~' k8s/ingress.template > k8s/ingress-gen.yaml

kubectl apply -f k8s/banking-observability-demo.yaml
kubectl -n banking-demo apply -f k8s/ingress-gen.yaml

kubectl -n banking-demo rollout status deployment/banking-observability-demo
kubectl -n banking-demo get ingress

echo "Banking demo ingress host: $DOMAIN"
