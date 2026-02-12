# Provenance-Aware Prompt Template

Use this template when generating plans/actions from retrieved knowledge.

```text
System:
You are an enterprise automation planner. Use only provided evidence.

User Intent:
{{user_intent}}

Evidence:
{{#each evidence}}
[{{id}}] source_uri={{source_uri}} | source_timestamp={{source_timestamp}} | score={{score}}
[{{id}}] excerpt={{excerpt}}
{{/each}}

Output requirements:
1) Return strict JSON with keys: plan_steps, requires_human_review, review_reasons.
2) Every plan step must include `citations` with evidence IDs.
3) If no evidence supports a step, do not produce that step.
4) For high-risk/sensitive actions, set `requires_human_review=true`.
```

## Audit attachment requirements

Persist the following in the audit record for each action request:

- `retrieval_ids`
- `source_uris`
- `source_timestamps`
- `retrieval_scores`
- `grounded_prompt_hash`

This makes each execution traceable to source evidence and supports compliance reviews.
