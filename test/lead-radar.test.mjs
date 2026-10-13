/**
 * Structural gates on the built workflow.
 *
 * These are not unit tests of node behaviour, which would need a running n8n.
 * They are the invariants that are expensive to notice by eye in a canvas of
 * nineteen nodes, and two of them exist because the invariant was already
 * broken once while this was being written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const wf = JSON.parse(readFileSync('dist/lead-radar.json', 'utf8'))

const byName = new Map(wf.nodes.map((n) => [n.name, n]))
const TRIGGERS = wf.nodes.filter((n) => /trigger|webhook/i.test(n.type)).map((n) => n.name)
const BEDROCK = wf.nodes
  .filter((n) => n.type === '@silurt/n8n-nodes-aws-bedrock.awsBedrock')
  .map((n) => n.name)

/** Every edge as [from, to, outputIndex]. */
const edges = []
for (const [from, outputs] of Object.entries(wf.connections)) {
  for (const branches of Object.values(outputs)) {
    branches.forEach((branch, index) => {
      for (const c of branch ?? []) edges.push([from, c.node, index])
    })
  }
}

const successorsOf = (name) => edges.filter(([f]) => f === name).map(([, t]) => t)

test('every node name referenced by a connection exists', () => {
  for (const [from, to] of edges) {
    assert.ok(byName.has(from), `connection source "${from}" is not a node`)
    assert.ok(byName.has(to), `connection target "${to}" is not a node`)
  }
})

test('the community node is the published package, not a local alias', () => {
  assert.ok(BEDROCK.length > 0, 'expected at least one AWS Bedrock node')
  for (const name of BEDROCK) {
    assert.equal(
      byName.get(name).type,
      '@silurt/n8n-nodes-aws-bedrock.awsBedrock',
      `${name} must carry the scoped package name, or an import will show it as unknown`,
    )
  }
})

test('all three Bedrock operations are exercised', () => {
  const ops = BEDROCK.map((n) => {
    const p = byName.get(n).parameters
    return `${p.resource}:${p.operation}`
  }).sort()
  assert.deepEqual(ops, ['guardrail:apply', 'knowledgeBase:retrieve', 'knowledgeBase:retrieveAndGenerate'])
})

test('nothing reaches Bedrock without passing the deterministic prefilter', () => {
  // The prefilter is the only thing keeping a bad board from costing a Bedrock
  // call per posting. A path that skips it is a cost bug, not a style problem.
  const GATE = 'Worth a look?'
  assert.ok(byName.has(GATE), 'the prefilter node is missing')

  for (const start of TRIGGERS) {
    const seen = new Set()
    const stack = [start]
    while (stack.length) {
      const here = stack.pop()
      if (seen.has(here)) continue
      seen.add(here)
      if (here === GATE) continue // reached the gate, stop walking this path
      assert.ok(
        !BEDROCK.includes(here),
        `"${here}" is reachable from trigger "${start}" without crossing ${GATE}`,
      )
      for (const next of successorsOf(here)) stack.push(next)
    }
  }
})

test('the batch loop closes from every exit', () => {
  // A terminal node inside the loop body means the loop runs once and stops.
  // This was true of the first build of this workflow.
  const LOOP = 'Per lead'
  assert.ok(byName.has(LOOP), 'the loop node is missing')

  const loopBodyEntry = edges
    .filter(([f, , i]) => f === LOOP && i === 1)
    .map(([, t]) => t)
  assert.ok(loopBodyEntry.length > 0, 'the loop has no body wired to output 1')

  const body = new Set()
  const stack = [...loopBodyEntry]
  while (stack.length) {
    const here = stack.pop()
    if (body.has(here) || here === LOOP) continue
    body.add(here)
    for (const next of successorsOf(here)) stack.push(next)
  }

  const terminal = [...body].filter((n) => successorsOf(n).length === 0)
  assert.deepEqual(
    terminal,
    [],
    `these nodes are inside the loop but return to nothing: ${terminal.join(', ')}`,
  )

  for (const n of body) {
    if (successorsOf(n).length === 0) continue
  }
  const returns = edges.filter(([f, t]) => body.has(f) && t === LOOP)
  assert.ok(returns.length >= 1, 'no node in the loop body returns to the loop')
})

test('every Bedrock call has somewhere to fail to', () => {
  // Without an error output a throttled or refused call takes the run with it,
  // and inside a loop that means the remaining leads are never seen.
  for (const name of BEDROCK) {
    const n = byName.get(name)
    assert.equal(
      n.onError,
      'continueErrorOutput',
      `${name} must route failures rather than aborting the run`,
    )
    const errorEdges = edges.filter(([f, , i]) => f === name && i === 1)
    assert.ok(errorEdges.length > 0, `${name} declares an error output but nothing is wired to it`)
  }
})

test('retries are configured on everything that leaves the machine', () => {
  const remote = wf.nodes.filter(
    (n) => n.type === 'n8n-nodes-base.httpRequest' || BEDROCK.includes(n.name),
  )
  for (const n of remote) {
    assert.equal(n.retryOnFail, true, `${n.name} should retry`)
    assert.ok(n.maxTries >= 2, `${n.name} should allow more than one attempt`)
  }
})

test('unresolved placeholders are visible, not silently shipped', () => {
  // placeholder() is how the SDK marks a value the author could not fill in.
  // Shipping one is fine; shipping one quietly is not, so the count is asserted
  // and this test is the thing that fails when it changes.
  const blob = JSON.stringify(wf)
  const found = blob.match(/<[^<>"]*>/g) ?? []
  assert.equal(
    found.length,
    5,
    `placeholder count changed to ${found.length}: ${found.join(', ')}. ` +
      'Update this assertion deliberately once the real values are in.',
  )
})

test('every group names its members and says what it is for', () => {
  const ids = new Set(wf.nodes.map((n) => n.id))
  for (const g of wf.nodeGroups ?? []) {
    assert.ok(g.description?.length > 0, `group "${g.name}" has no description`)
    assert.ok(g.description.length <= 145, `group "${g.name}" description is truncated in the UI`)
    for (const id of g.nodeIds) {
      assert.ok(ids.has(id), `group "${g.name}" names a node that is not in the workflow`)
    }
  }
})

test('the grounding check is actually wired to ground against something', () => {
  // This workflow shipped once claiming a contextual grounding check it could
  // not perform: the node sent one unlabelled content block, so Bedrock ran the
  // guardrail's other policies and the grounding policy never fired. The claim
  // is only true while all of the below hold.
  const guard = wf.nodes.find(
    (n) => n.parameters?.resource === 'guardrail' && n.parameters?.operation === 'apply',
  )
  assert.ok(guard, 'no guardrail node')

  assert.equal(guard.parameters.source, 'OUTPUT', 'contextual grounding does not apply to input')

  const src = guard.parameters.groundingSource
  assert.ok(src?.length > 0, 'groundingSource is empty, so there is nothing to ground against')
  assert.match(
    src,
    /Retrieve evidence/,
    'groundingSource must read the retrieved passages, not the generated answer',
  )

  assert.ok(
    guard.parameters.groundingQuery?.length > 0,
    'groundingQuery is empty, so the relevance half of the check cannot run',
  )
})
