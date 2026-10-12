# n8n-lead-radar

n8n workflows written as TypeScript, type-checked and validated before they are
allowed to become JSON.

The flagship is a consultancy lead pipeline. Postings arrive from four
applicant-tracking APIs, get rejected cheaply by a deterministic filter, and only
the survivors cost anything: each is matched against an evidence corpus held in a
Bedrock knowledge base, drafted into outreach grounded in what came back, and then
checked by a Bedrock guardrail that rejects any sentence the corpus does not
support.

That last step is the reason the rest exists. A model asked to pitch someone will
invent the experience that would make the pitch land. A contextual-grounding
guardrail is what stops the draft going out when it does.

**Status: builds and validates, not yet run against live AWS.** The graph is
checked by nine structural tests and the SDK's own validator. Five parameters are
still placeholders, listed below, because they name AWS resources that do not
exist yet.

## Why as code

An n8n workflow is JSON, and the canvas is one editor for it. Writing it as code
instead buys three things that matter at nineteen nodes:

- A broken graph fails at `npm run build` with a message, not after an import that
  half worked.
- Invariants that are expensive to see by eye become tests. Two of the nine exist
  because the invariant was broken during the writing of this workflow.
- The diff is readable. A moved node in the UI rewrites coordinates throughout the
  JSON; here it does not appear at all.

Authoring uses [`@n8n/workflow-sdk`](https://www.npmjs.com/package/@n8n/workflow-sdk),
n8n's own SDK, so the graph is built by the same code that n8n's tooling uses rather
than by hand-assembled JSON.

```bash
npm install
npm run build      # src/workflows/*.ts -> dist/*.json
npm test           # structural gates on the built JSON
npm run typecheck
```

`dist/` is generated and not committed, so build first, then import
`dist/lead-radar.json` with **Workflows > Import from file**.

The build is reproducible: node ids are carried forward by node name from any
previous output rather than minted fresh, and the webhook id is pinned in source.
Re-importing a rebuilt workflow therefore does not churn the ids n8n matches
nodes on.

## The pipeline

| Stage | Nodes | What it is for |
| --- | --- | --- |
| Ingest | Schedule and Webhook triggers, Set, Split Out, HTTP Request | One request per board, driven by data rather than one node per source. A board that is down leaves by the error output instead of taking the run with it. |
| Normalise | Code, Set, Remove Duplicates | Four ATS payload shapes into one lead record, deduplicated across executions so a posting that sits on a board for three weeks is drafted once. |
| Prefilter | Filter | The cheap rejection. Everything after this costs three Bedrock calls per lead, so wrong continent, wrong seniority and agency repostings leave here on string matching. |
| Grounded drafting | AWS Bedrock ×3, If | Retrieve the matching evidence, generate from it, then check the result against it. |
| Outcomes | Set ×3, Summarize | Grounded drafts are recorded, ungrounded ones are flagged with the guardrail's own assessment, failures are kept rather than swallowed. |

All three operations of
[`@silurt/n8n-nodes-aws-bedrock`](https://www.npmjs.com/package/@silurt/n8n-nodes-aws-bedrock)
are load-bearing here: `retrieve` finds the evidence, `retrieveAndGenerate` writes
from it, and `apply` on a guardrail decides whether what was written is supported.

An intervention is not a failure. It means the draft claimed something the corpus
does not carry, which is either a bad draft or a real gap in the corpus, and both
are worth a human look. That is why the false branch records the guardrail's
assessments rather than discarding the item.

## What the tests check

Nine gates, run against the built JSON rather than the source:

- Every connection names a node that exists.
- The Bedrock nodes carry the published scoped package name, so an import does not
  show them as unknown.
- All three Bedrock operations are exercised.
- **No path from any trigger reaches Bedrock without crossing the prefilter.** A
  path that skips it is a cost bug, not a style problem.
- **The batch loop closes from every exit.** The first build of this workflow left
  three terminal nodes inside the loop body, which would have processed one lead
  and stopped.
- Every Bedrock call has an error output with something wired to it. Without one, a
  throttled call inside a loop means the remaining leads are never seen.
- Everything that leaves the machine retries.
- Unresolved placeholders are counted, so shipping one is a deliberate act.
- Every group has a description, within the length the UI shows.

## Still placeholders

Five values name AWS resources that do not exist yet. They are `placeholder()`
calls, which the SDK renders visibly into the JSON, and the test above fails if
their number changes:

- the knowledge base holding the evidence corpus, twice
- the model ARN to generate with
- the guardrail carrying the contextual-grounding policy, and its version

The AWS credential is referenced by name, `AWS account`, because `placeholder()`
and `newCredential()` both serialize to an empty object through `toJSON()` and a
node with no credential is worse than a node with a name to bind.

## Cost, before you build the knowledge base

A Bedrock knowledge base needs a vector store, and the default choice is the
expensive one. OpenSearch Serverless has a floor of two OCUs, roughly USD 350 a
month, on an empty collection with no traffic. S3 Vectors is the cheap path and the
corpus this is designed around is 96 KB across ten files.

Guardrails are priced per thousand text units and cost cents at this volume.

## Licence

Apache-2.0.
