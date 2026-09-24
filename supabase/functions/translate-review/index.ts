// translate-review — 후기 본문·닉네임 번역 캐시 (2026-09-24 · 라이징파이터 리뷰 사이트)
// POST { ids: string[] (≤20), target: 'en' | 'ko' }
//  → 각 id 에 대해 target 번역이 비어 있으면 Claude 로 번역해 reviews.{body,nick}_{target} 에 저장.
//  → 응답 { items: [{ id, nick, body, cached }] , missing_key?: true }
// 닉네임 규칙(CEO 2026-09-24): 뜻이 있는 말이면 뜻 번역, 뜻 번역이 안 되면 로마자 표기(한→영은 국어의 로마자 표기법).
// 원문이 이미 target 언어면 원문 그대로 저장(번역 안 함). anon 호출 가능(verify_jwt) · 쓰기는 service_role.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// 언어 판별은 **본문만** 본다(2026-09-25 백필에서 닉네임 'Typhoon' + 본문 한국어가 'en' 으로 잘못 잡혀 번역이 건너뛰어짐).
//  한글이 한 글자라도 있으면 ko — 한국어 후기에 영문 게임 용어가 섞이는 경우가 그 반대보다 훨씬 흔하다.
function guessLang(s: string): 'ko' | 'en' | 'other' {
  const ko = (s.match(/[가-힣]/g) || []).length
  const en = (s.match(/[A-Za-z]/g) || []).length
  if (ko > 0) return 'ko'
  if (en > 0) return 'en'
  return 'other'
}

async function translate(nick: string, body: string, target: 'en' | 'ko', key: string) {
  const tgt = target === 'en' ? 'English' : 'Korean'
  const nickRule = target === 'en'
    ? 'If the nickname is a meaningful word or phrase, translate its meaning into natural English (e.g. 불꽃주먹 → Flame Fist). If it has no translatable meaning (a proper name, random syllables, brand), romanize it with Revised Romanization of Korean instead. Keep any Latin letters/numbers as they are. Max 24 characters.'
    : 'If the nickname is a meaningful word or phrase, translate its meaning into natural Korean. If it has no translatable meaning (a proper name, random letters, brand), transliterate it into Hangul instead. Keep numbers as they are. Max 20 characters.'
  const sys = `You translate user reviews of a mobile fighting-management game (Rising Fighter) into ${tgt}. Translate faithfully — same tone, same length, no additions, no censorship, keep emojis and line breaks. Game terms: 파이터=fighter, 체급=weight class, 명예의 전당=Hall of Fame, 전투력=power rating, 스파링=sparring, 감독모드=Director mode, 유스=youth. Nickname rule: ${nickRule} Reply with JSON only: {"nick": string, "body": string}.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: sys,
      messages: [{ role: 'user', content: JSON.stringify({ nick, body }) }],
    }),
  })
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const data = await res.json()
  const text: string = (data.content?.[0]?.text ?? '').trim()
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no json in reply')
  const out = JSON.parse(m[0])
  const n = String(out.nick ?? '').trim().slice(0, 24) || nick
  const b = String(out.body ?? '').trim().slice(0, 1000) || body
  return { nick: n, body: b }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  let payload: { ids?: unknown; target?: unknown }
  try { payload = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  const target = payload.target === 'ko' ? 'ko' : payload.target === 'en' ? 'en' : null
  const ids = Array.isArray(payload.ids) ? payload.ids.filter((x) => typeof x === 'string').slice(0, 20) : []
  if (!target || ids.length === 0) return json({ error: 'ids[] and target required' }, 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const key = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
  const sb = createClient(url, service, { auth: { persistSession: false } })

  const { data: rows, error } = await sb
    .from('reviews')
    .select('id, nickname, body, lang, body_en, nick_en, body_ko, nick_ko')
    .in('id', ids)
  if (error) return json({ error: error.message }, 500)

  const bodyCol = target === 'en' ? 'body_en' : 'body_ko'
  const nickCol = target === 'en' ? 'nick_en' : 'nick_ko'
  const items: { id: string; nick: string; body: string; cached: boolean }[] = []
  let missingKey = false

  for (const r of rows ?? []) {
    const cachedBody = (r as Record<string, string | null>)[bodyCol]
    const cachedNick = (r as Record<string, string | null>)[nickCol]
    if (cachedBody && cachedNick) { items.push({ id: r.id, nick: cachedNick, body: cachedBody, cached: true }); continue }
    const lang = r.lang ?? guessLang(r.body)
    let nick = r.nickname, body = r.body
    if (lang !== target && !(lang === 'other')) {
      if (!key) { missingKey = true; items.push({ id: r.id, nick, body, cached: false }); continue }
      try {
        const t = await translate(r.nickname, r.body, target, key)
        nick = t.nick; body = t.body
      } catch (e) {
        items.push({ id: r.id, nick, body, cached: false })
        console.error('translate fail', r.id, String(e))
        continue
      }
    }
    // 원문이 target 언어면(또는 판별 불가) 원문을 그대로 캐시 → 다음부터 API 호출 없음
    const upd: Record<string, unknown> = { [bodyCol]: body, [nickCol]: nick, translated_at: new Date().toISOString() }
    if (!r.lang) upd.lang = lang
    await sb.from('reviews').update(upd).eq('id', r.id)
    items.push({ id: r.id, nick, body, cached: false })
  }
  return json(missingKey ? { items, missing_key: true } : { items })
})
