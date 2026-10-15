---
name: runpod-finetune
description: Run a model fine-tuning / training job on RunPod (pod or serverless) with cost controls. Use when the user wants to fine-tune or train a model on RunPod GPUs.
---

# Fine-tuning on RunPod

RunPod has **no dedicated "fine-tune" API**: training = run your training container on a GPU pod (or a serverless worker for batch jobs). This skill wraps that workflow with the `runpod` MCP tools.

## Workflow
1. **Clarify**: base model, dataset location, method (LoRA/QLoRA/full), framework (Axolotl, Unsloth, TRL, LLaMA-Factory), budget cap, max hours.
2. **Pick GPU**: estimate VRAM (QLoRA 7B ≈ 24GB, LoRA 13B ≈ 40–48GB, 70B QLoRA ≈ 80GB+). Query prices/stock with `runpod_graphql` (`gpuTypes`).
3. **Persist storage**: create/attach a network volume (`runpod_create_network_volume`) for checkpoints and datasets so work survives pod deletion. Same data center as the pod.
4. **Launch**: `runpod_create_pod` with a training image/template (e.g. `winglian/axolotl`, `unsloth/unsloth`, or a `runpod/pytorch` image), `volumeInGb`/`networkVolumeId`, `env` (e.g. `HF_TOKEN`, `WANDB_API_KEY` — take from the user; never echo them), `ports ["22/tcp"]`, and a `dockerStartCmd` that runs training and, at the end, uploads results (HF Hub/S3) and optionally exits.
5. **Monitor**: `runpod_get_pod` for status/ports; user can SSH for logs. Report cost so far via `runpod_pod_billing`.
6. **Finish**: confirm artifacts are saved off-pod, then `runpod_stop_pod` / `runpod_delete_pod` (ask first). Verify nothing is still RUNNING.

## Cost guardrails
- Show estimate = hourly price × expected hours before launching; get explicit approval.
- Prefer community/spot only for resumable jobs (checkpoint often).
- Set the training script to auto-terminate; always re-list pods at the end.

## Serverless batch variant
For inference-style or short batch jobs: create a template + endpoint (`runpod_create_endpoint`, `workersMin: 0`), submit with `runpod_serverless_run`, poll `runpod_serverless_status`, then delete the endpoint when done.
