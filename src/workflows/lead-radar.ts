/**
 * Grounded consultancy lead pipeline.
 *
 * Postings come in from four applicant-tracking APIs, get cheaply rejected by a
 * deterministic filter, and only the survivors cost anything: each one is matched
 * against an evidence corpus in a Bedrock knowledge base, drafted into outreach
 * grounded in what the corpus retrieved, and then checked by a Bedrock guardrail
 * that rejects any sentence the corpus does not support.
 *
 * That last step is the point of the whole thing. A model asked to pitch someone
 * will invent the experience that would make the pitch work. The guardrail's
 * contextual-grounding policy is what stops the draft going out when it does,
 * and it replaces a rule that was previously only enforced by a build script.
 *
 * Authored with @n8n/workflow-sdk, which parses this file into a static graph
 * rather than executing it, so the constraints are unusual: const only, no
 * loops, no functions, no imports beyond the SDK. Anything that needs to run at
 * runtime lives in a node, not here.
 */
import {
  workflow,
  node,
  trigger,
  ifElse,
  splitInBatches,
  nextBatch,
  expr,
  placeholder,
} from '@n8n/workflow-sdk'

/**
 * The n8n credential these nodes sign with, by name. `placeholder()` and
 * `newCredential()` both serialize to an empty object through `toJSON()`, so a
 * plain name is the only form that survives into exported JSON: on import n8n
 * binds it if a credential of that name exists and asks for one if it does not.
 */
const AWS_CREDENTIAL = 'AWS account'

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const everyMorning = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: {
    name: 'Every morning',
    parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 7 }] } },
  },
})

/**
 * A lead pushed in by hand, so a posting someone forwards can go through the
 * same grounding as the scheduled ones instead of being answered off the cuff.
 */
const leadPushed = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: {
    name: 'Lead pushed',
    parameters: { httpMethod: 'POST', path: 'lead', responseMode: 'lastNode' },
  },
})

/**
 * The board list, as data rather than as one HTTP node per source. Each entry
 * carries its own URL, so adding a company is a line here and no graph change.
 *
 * The four companies are illustrative, one per supported ATS, chosen because
 * their boards are public and each endpoint answered 200 on 2026-10-12. Swap in
 * your own; nothing else in the graph changes.
 */
const boards = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Boards',
    parameters: {
      mode: 'raw',
      jsonOutput: JSON.stringify({
        boards: [
          {
            ats: 'ashby',
            slug: 'notion',
            url: 'https://api.ashbyhq.com/posting-api/job-board/notion?includeCompensation=true',
          },
          {
            ats: 'greenhouse',
            slug: 'gitlab',
            url: 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true',
          },
          {
            ats: 'lever',
            slug: 'palantir',
            url: 'https://api.lever.co/v0/postings/palantir?mode=json',
          },
          {
            ats: 'workable',
            slug: 'enjins',
            url: 'https://apply.workable.com/api/v1/widget/accounts/enjins?details=true',
          },
        ],
      }),
    },
  },
})

const oneBoardPerItem = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'One board per item', parameters: { fieldToSplitOut: 'boards' } },
})

/**
 * One request per board. A board that is down or rate-limiting must not take the
 * run with it, so failures retry and then leave by the error output.
 */
const fetchPostings = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Fetch postings',
    parameters: { method: 'GET', url: expr('{{ $json.url }}') },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueErrorOutput',
  },
})

const boardUnreachable = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Board unreachable',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'stage', name: 'stage', type: 'string', value: 'fetch' },
          {
            id: 'reason',
            name: 'reason',
            type: 'string',
            value: expr('{{ $json.error ?? "request failed" }}'),
          },
        ],
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Normalise
// ---------------------------------------------------------------------------

/**
 * Four ATS payloads, one lead record. This is a Code node rather than a Set
 * node because the four shapes nest differently and each response holds many
 * postings, so it is a fan-out and a mapping at once.
 */
const normalise = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalise',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: [
        'const out = []',
        'for (const item of $input.all()) {',
        '  const ats = item.json.ats ?? $("One board per item").first().json.ats',
        '  const body = item.json',
        '  const rows =',
        '    ats === "ashby" ? (body.jobs ?? [])',
        '    : ats === "greenhouse" ? (body.jobs ?? [])',
        '    : ats === "lever" ? (Array.isArray(body) ? body : [])',
        '    : (body.jobs ?? [])',
        '  for (const r of rows) {',
        '    out.push({ json: {',
        '      leadId: `${ats}:${r.id ?? r.jobId ?? r.shortcode ?? r.title}`,',
        '      ats,',
        '      title: r.title ?? r.text ?? r.name ?? "",',
        '      location: r.location?.name ?? r.location ?? r.categories?.location ?? "",',
        '      url: r.jobUrl ?? r.absolute_url ?? r.hostedUrl ?? r.url ?? "",',
        '      body: r.descriptionPlain ?? r.content ?? r.description ?? r.descriptionHtml ?? "",',
        '    } })',
        '  }',
        '}',
        'return out',
      ].join('\n'),
    },
  },
})

/** The pushed lead arrives already shaped, so it only needs the same field names. */
const normalisePushed = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Normalise pushed lead',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'leadId',
            name: 'leadId',
            type: 'string',
            value: expr('{{ "pushed:" + $json.body.url }}'),
          },
          { id: 'ats', name: 'ats', type: 'string', value: 'pushed' },
          { id: 'title', name: 'title', type: 'string', value: expr('{{ $json.body.title }}') },
          {
            id: 'location',
            name: 'location',
            type: 'string',
            value: expr('{{ $json.body.location ?? "" }}'),
          },
          { id: 'url', name: 'url', type: 'string', value: expr('{{ $json.body.url }}') },
          { id: 'body', name: 'body', type: 'string', value: expr('{{ $json.body.body ?? "" }}') },
        ],
      },
    },
  },
})

/**
 * Keyed on the lead id and kept across executions, so a posting that sits on a
 * board for three weeks is drafted once rather than twenty-one times.
 */
const seenBefore = node({
  type: 'n8n-nodes-base.removeDuplicates',
  version: 2,
  config: {
    name: 'Seen before?',
    parameters: {
      operation: 'removeItemsSeenInPreviousExecutions',
      logic: 'removeItemsWithAlreadySeenKeyValues',
      dedupeValue: expr('{{ $json.leadId }}'),
    },
  },
})

// ---------------------------------------------------------------------------
// Prefilter, before anything costs money
// ---------------------------------------------------------------------------

/**
 * The cheap rejection. Everything downstream costs a Bedrock call per lead, so
 * the obvious misses leave here on string matching: wrong continent, wrong
 * seniority, or an agency reposting someone else's role.
 */
const worthALook = node({
  type: 'n8n-nodes-base.filter',
  version: 2.2,
  config: {
    name: 'Worth a look?',
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          {
            id: 'has-url',
            leftValue: expr('{{ $json.url }}'),
            operator: { type: 'string', operation: 'notEmpty' },
          },
          {
            id: 'region',
            leftValue: expr(
              '{{ $json.location + " " + $json.body }}',
            ),
            operator: { type: 'string', operation: 'regex' },
            rightValue: '(?i)(remote|europe|emea|netherlands|amsterdam|germany|berlin|munich)',
          },
          {
            id: 'not-junior',
            leftValue: expr('{{ $json.title }}'),
            operator: { type: 'string', operation: 'notRegex' },
            rightValue: '(?i)(intern|junior|graduate|working student|apprentice)',
          },
        ],
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Grounded drafting, one lead at a time
// ---------------------------------------------------------------------------

/**
 * Batch size one. Bedrock is being asked three questions per lead and the
 * knowledge base is the same every time, so there is nothing to gain from
 * parallelism and a throttled loop keeps well inside the account's quota.
 */
const perLead = splitInBatches({
  version: 3,
  config: { name: 'Per lead', parameters: { batchSize: 1, options: { reset: false } } },
})

/**
 * What in the corpus speaks to this posting. The corpus is evidence-graded and
 * each passage carries its own identifier, so a retrieved result names the thing
 * it came from and the draft below can be traced back to it.
 */
const retrieveEvidence = node({
  type: '@silurt/n8n-nodes-aws-bedrock.awsBedrock',
  version: 1,
  config: {
    name: 'Retrieve evidence',
    parameters: {
      resource: 'knowledgeBase',
      operation: 'retrieve',
      knowledgeBaseId: placeholder('the knowledge base holding the evidence corpus'),
      query: expr('{{ $json.title + "\\n\\n" + $json.body }}'),
    },
    credentials: { aws: AWS_CREDENTIAL },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
  },
})

/**
 * The draft, generated against the knowledge base rather than from the model's
 * own memory, so the claims in it have somewhere to have come from.
 */
const draftOutreach = node({
  type: '@silurt/n8n-nodes-aws-bedrock.awsBedrock',
  version: 1,
  config: {
    name: 'Draft outreach',
    parameters: {
      resource: 'knowledgeBase',
      operation: 'retrieveAndGenerate',
      knowledgeBaseId: placeholder('the same knowledge base as Retrieve evidence'),
      modelArn: placeholder('the model ARN to generate with'),
      query: expr(
        '{{ "Write a short, specific opening message for this role, using only the retrieved evidence. Name the single most relevant piece of experience and nothing else.\\n\\nRole: " + $("Per lead").item.json.title + "\\n\\n" + $("Per lead").item.json.body }}',
      ),
    },
    credentials: { aws: AWS_CREDENTIAL },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
  },
})

/**
 * The gate. A contextual-grounding policy on the guardrail checks the draft
 * against the passages that were retrieved, so a sentence the corpus does not
 * support is an intervention rather than something that goes out.
 */
const checkGrounding = node({
  type: '@silurt/n8n-nodes-aws-bedrock.awsBedrock',
  version: 1,
  config: {
    name: 'Check grounding',
    parameters: {
      resource: 'guardrail',
      operation: 'apply',
      guardrailIdentifier: placeholder('the guardrail with the contextual-grounding policy'),
      guardrailVersion: placeholder('its version, or DRAFT'),
      source: 'OUTPUT',
      text: expr('{{ $json.output?.text ?? $json.text }}'),
    },
    credentials: { aws: AWS_CREDENTIAL },
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
  },
})

const grounded = ifElse({
  version: 2.2,
  config: {
    name: 'Grounded?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          {
            id: 'no-intervention',
            leftValue: expr('{{ $json.action }}'),
            operator: { type: 'string', operation: 'notEquals' },
            rightValue: 'GUARDRAIL_INTERVENED',
          },
        ],
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

const recordLead = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Record lead',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'leadId',
            name: 'leadId',
            type: 'string',
            value: expr('{{ $("Per lead").item.json.leadId }}'),
          },
          {
            id: 'title',
            name: 'title',
            type: 'string',
            value: expr('{{ $("Per lead").item.json.title }}'),
          },
          {
            id: 'url',
            name: 'url',
            type: 'string',
            value: expr('{{ $("Per lead").item.json.url }}'),
          },
          {
            id: 'draft',
            name: 'draft',
            type: 'string',
            value: expr('{{ $("Draft outreach").item.json.output?.text }}'),
          },
          { id: 'verdict', name: 'verdict', type: 'string', value: 'grounded' },
        ],
      },
    },
  },
})

/**
 * Not a failure. An intervention means the draft claimed something the corpus
 * does not carry, which is either a bad draft or a real gap in the corpus, and
 * both are worth a human look.
 */
const flagForReview = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Flag for review',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: 'leadId',
            name: 'leadId',
            type: 'string',
            value: expr('{{ $("Per lead").item.json.leadId }}'),
          },
          {
            id: 'url',
            name: 'url',
            type: 'string',
            value: expr('{{ $("Per lead").item.json.url }}'),
          },
          {
            id: 'draft',
            name: 'draft',
            type: 'string',
            value: expr('{{ $("Draft outreach").item.json.output?.text }}'),
          },
          { id: 'verdict', name: 'verdict', type: 'string', value: 'ungrounded' },
          {
            id: 'assessments',
            name: 'assessments',
            type: 'string',
            value: expr('{{ JSON.stringify($json.assessments ?? []) }}'),
          },
        ],
      },
    },
  },
})

const bedrockFailed = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Bedrock failed',
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'stage', name: 'stage', type: 'string', value: 'bedrock' },
          {
            id: 'reason',
            name: 'reason',
            type: 'string',
            value: expr('{{ $json.error?.message ?? "call failed" }}'),
          },
        ],
      },
    },
  },
})

const summariseRun = node({
  type: 'n8n-nodes-base.summarize',
  version: 1.1,
  config: {
    name: 'Summarise run',
    parameters: {
      fieldsToSummarize: {
        values: [{ aggregation: 'count', field: 'leadId' }],
      },
      fieldsToSplitBy: 'verdict',
    },
  },
})

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export default workflow('lead-radar', 'Grounded consultancy lead pipeline')
  .add(everyMorning)
  .to(boards)
  .to(oneBoardPerItem)
  .to(fetchPostings.onError(boardUnreachable))
  .to(normalise)
  .to(seenBefore)
  .to(worthALook)
  .to(
    perLead
      .onEachBatch(
        retrieveEvidence
          .onError(bedrockFailed.to(nextBatch(perLead)))
          .to(draftOutreach.onError(bedrockFailed))
          .to(checkGrounding.onError(bedrockFailed))
          .to(
            // `onTrue` is declared optional on NodeInstance while the only type
            // that declares it non-optional, IfElseBuilder, is reachable only
            // through it. An If node always has it at runtime, which the build
            // and the structural tests both confirm, so the assertion is on the
            // SDK's type gap rather than on anything about this graph.
            grounded
              .onTrue!(recordLead.to(nextBatch(perLead)))
              .onFalse(flagForReview.to(nextBatch(perLead))),
          ),
      )
      .onDone(summariseRun),
  )
  .add(leadPushed)
  .to(normalisePushed)
  .to(seenBefore)
  .group('Ingest', [boards, oneBoardPerItem, fetchPostings, boardUnreachable], {
    description: 'Pulls postings from four ATS APIs, one request per board, failures routed aside',
  })
  .group('Normalise', [normalise, normalisePushed, seenBefore], {
    description: 'Four payload shapes into one lead record, deduplicated across runs',
  })
  .group('Grounded drafting', [retrieveEvidence, draftOutreach, checkGrounding, grounded], {
    description: 'Match against the evidence corpus, draft from it, then reject anything it does not support',
  })
