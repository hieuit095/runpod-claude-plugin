# runpod — Claude Code plugin

Control RunPod from Claude Code: pods, serverless endpoints/jobs, templates, network volumes, registry auth, billing, and raw GraphQL.

## Install
```bash
export RUNPOD_API_KEY=...        # https://www.runpod.io/console/user/settings
claude --plugin-dir /home/hieuit095/runpod-plugin
```
(or add the folder as a local marketplace / `/plugin` install.) Requires Node 18+; no npm install needed.

## What you get
- **40 MCP tools**: 30 REST tools generated from RunPod's OpenAPI spec (`spec/openapi.json`, refresh with
  `curl https://rest.runpod.io/v1/openapi.json -o spec/openapi.json`), 8 serverless runtime tools
  (`run`, `runsync`, `status`, `stream`, `cancel`, `retry`, `health`, `purge_queue`), and `runpod_graphql`.
- **Skills**: `runpod` (operations + cost rules) and `runpod-finetune` (training workflow).

## Notes
- Fine-tuning has no dedicated RunPod API; it's done by launching a training container on a pod.
- Creating pods/endpoints bills immediately; the skills instruct Claude to confirm cost first.
