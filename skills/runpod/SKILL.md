---
name: runpod
description: Operate RunPod infrastructure — create/stop/delete GPU pods, serverless endpoints and jobs, templates, network volumes, billing. Use when the user mentions RunPod, GPU pods, serverless endpoints, or renting GPUs.
---

# RunPod operations

Tools come from the `runpod` MCP server (needs `RUNPOD_API_KEY` in the environment).

## Tool map
- Pods: `runpod_create_pod`, `list_pods`, `get_pod`, `update_pod`, `start_pod`, `stop_pod`, `restart_pod`, `reset_pod`, `delete_pod`
- Serverless config: `runpod_create_endpoint` / `list` / `get` / `update` / `delete`
- Serverless jobs: `runpod_serverless_run` (async), `runsync`, `status`, `stream`, `cancel`, `retry`, `health`, `purge_queue`
- Templates, network volumes, container registry auth: `runpod_*_template`, `*_network_volume`, `*_container_registry_auth`
- Billing: `runpod_pod_billing`, `endpoint_billing`, `network_volume_billing`
- `runpod_graphql`: anything REST lacks — GPU prices/stock, account balance, data centers.

## Rules
1. **Cost safety.** Creating pods/endpoints/volumes bills real money. Before creating, state GPU type, count, cloud type, disk sizes and the hourly price (look it up via GraphQL), and get user confirmation. Never create "just to test".
2. **Always report leftovers.** After a task, list running pods (`desiredStatus=RUNNING`) and tell the user what is still billing. `stop_pod` keeps the disk (disk is still billed); `delete_pod` removes it.
3. Confirm before any delete/purge/cancel.
4. Poll jobs/pods with `get_pod` / `serverless_status`; do not busy-loop — wait between polls.
5. Never print the API key.

## Useful GraphQL
GPU prices and availability:
```graphql
query { gpuTypes { id displayName memoryInGb secureCloud communityCloud
  lowestPrice(input:{gpuCount:1}) { minimumBidPrice uninterruptablePrice stockStatus } } }
```
Balance / spend: `query { myself { clientBalance currentSpendPerHr spendLimit } }`
Data centers: `query { dataCenters { id name location } }`

## Pod creation tips
- `gpuTypeIds` takes ids like `"NVIDIA GeForce RTX 4090"`; `imageName` or `templateId` required for a useful pod.
- Persist work on a network volume (`networkVolumeId`, same data center) or `volumeInGb`; container disk is wiped on stop.
- Expose SSH/Jupyter via `ports: ["22/tcp","8888/http"]`; connection info appears in `get_pod` (`publicIp`, `portMappings`).
