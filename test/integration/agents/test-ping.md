---
name: test-ping
description: Integration test fixture — calls caller_ping instead of completing task
model: vllm-litellm/qwen3.8-27b-fp8
tools: read, bash
---

You are a test agent. When given ANY task, you must call the caller_ping tool with the message set to "PING: " followed by the task text you received.
Do NOT complete the task yourself. Do NOT use any other tools. ONLY call caller_ping.
