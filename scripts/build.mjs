/**
 * Turn every workflow in `src/workflows` into importable n8n JSON.
 *
 *   npm run build
 *
 * The SDK's own `validate()` runs first and a workflow that fails it is not
 * written. That is the whole point of authoring these as code: the failure
 * happens here, with a message, rather than in the n8n UI after an import that
 * half worked.
 */
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const SRC = 'src/workflows'
const OUT = 'dist'

/**
 * Node and group ids are fresh UUIDs on every build, which makes the committed
 * output differ from a rebuild of the same source and every diff unreadable.
 *
 * The SDK takes name-keyed id maps for this, so the previous output is read back
 * and its ids carried forward: a node that kept its name keeps its id, and only
 * a genuinely new node gets a new one. That is what makes `check:generated` a
 * meaningful gate rather than one that can never pass.
 */
function existingIds(path) {
  if (!existsSync(path)) return { nodes: undefined, groups: undefined }
  const prev = JSON.parse(readFileSync(path, 'utf8'))
  const nodes = new Map((prev.nodes ?? []).map((n) => [n.name, n.id]))
  const groups = new Map((prev.nodeGroups ?? []).map((g) => [g.name, g.id]))
  return { nodes, groups }
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))
if (files.length === 0) {
  console.error(`\n✗ no workflows found in ${SRC}\n`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

let failed = 0

for (const file of files) {
  const name = basename(file, '.ts')
  const mod = await import(new URL(`../${SRC}/${file}`, import.meta.url).href)
  const wf = mod.default

  if (!wf || typeof wf.toJSON !== 'function') {
    console.error(`✗ ${file}: default export is not a workflow builder`)
    failed++
    continue
  }

  const result = wf.validate()
  for (const w of result.warnings ?? []) {
    console.warn(`  ! ${name}: ${w.message ?? JSON.stringify(w)}`)
  }
  if (!result.valid) {
    console.error(`✗ ${name} failed validation, not written:`)
    for (const e of result.errors ?? []) {
      console.error(`    ${e.message ?? JSON.stringify(e)}`)
    }
    failed++
    continue
  }

  const out = join(OUT, `${name}.json`)
  const prior = existingIds(out)
  wf.regenerateNodeIds(prior.nodes)

  const json = wf.toJSON({ existingGroupIdsByName: prior.groups })
  writeFileSync(out, JSON.stringify(json, null, 2) + '\n')

  const nodes = json.nodes.length
  const community = json.nodes.filter((n) => !n.type.startsWith('n8n-nodes-base.')).length
  console.log(`✓ ${out}  ${nodes} nodes (${community} from community packages)`)
}

if (failed) {
  console.error(`\n✗ ${failed} workflow(s) did not build\n`)
  process.exit(1)
}
