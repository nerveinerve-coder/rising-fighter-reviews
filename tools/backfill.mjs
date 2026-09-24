// 리뷰 번역 백필 — translate-review 를 20개 단위로 호출해 비어 있는 번역을 채운다.
// 사용: node tools/backfill.mjs [--target en|ko] [--dry]
// SUPABASE_URL / anon key 는 index.html 에서 읽는다(공개 키). 시크릿은 다루지 않는다.
// ANTHROPIC_API_KEY 가 Edge Function Secrets 에 없으면 첫 배치에서 missing_key 로 멈춘다.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, '..', 'index.html'), 'utf8')
const URL_ = html.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1]
const ANON = html.match(/(eyJ[A-Za-z0-9._-]{40,})/)?.[1]
if (!URL_ || !ANON) { console.error('index.html 에서 SUPABASE_URL/anon key 를 못 찾음'); process.exit(2) }

const args = process.argv.slice(2)
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'en'
const dry = args.includes('--dry')
if (target !== 'en' && target !== 'ko') { console.error('--target en|ko'); process.exit(2) }
const col = target === 'en' ? 'body_en' : 'body_ko'
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON }

const rows = await (await fetch(`${URL_}/rest/v1/reviews?select=id,${col}&order=created_at.asc&limit=5000`, { headers: H })).json()
if (!Array.isArray(rows)) { console.error('rows 조회 실패', rows); process.exit(1) }
const todo = rows.filter((r) => !r[col]).map((r) => r.id)
console.log(`전체 ${rows.length} · ${col} 비어 있음 ${todo.length} · target=${target}${dry ? ' · dry' : ''}`)
if (dry || todo.length === 0) process.exit(0)

let done = 0, fail = 0
for (let i = 0; i < todo.length; i += 20) {
  const ids = todo.slice(i, i + 20)
  const res = await fetch(`${URL_}/functions/v1/translate-review`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, target }),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) { console.error('HTTP', res.status, out); fail += ids.length; continue }
  if (out.missing_key) { console.error('ANTHROPIC_API_KEY 미등록 — 중단'); process.exit(3) }
  done += (out.items ?? []).length
  console.log(`${i + ids.length}/${todo.length} · 응답 ${(out.items ?? []).length}`)
}
// 재확인: 아직 비어 있는 행 수
const after = await (await fetch(`${URL_}/rest/v1/reviews?select=id&${col}=is.null&limit=5000`, { headers: H })).json()
console.log(`완료 ${done} · 실패 ${fail} · 남은 빈 행 ${Array.isArray(after) ? after.length : '?'}`)
