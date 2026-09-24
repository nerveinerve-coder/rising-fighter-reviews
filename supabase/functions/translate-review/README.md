# translate-review (Edge Function · 2026-09-24)
- 배포: Supabase 프로젝트 ldyxscsnpvoifrjnlidy · verify_jwt=true(anon 키로 호출) · 쓰기는 service_role.
- 요청: `POST /functions/v1/translate-review` `{ ids: string[] (≤20), target: 'en'|'ko' }`
- 응답: `{ items: [{ id, nick, body, cached }], missing_key?: true }` — 시크릿 `ANTHROPIC_API_KEY` 가 없으면 원문을 그대로 돌려주고 `missing_key: true`.
- 캐시: `reviews.body_{en,ko}` · `nick_{en,ko}` · `lang` · `translated_at`. 원문이 이미 target 언어면 원문을 캐시(재호출 없음).
- 닉네임 규칙(CEO #51): 뜻이 있으면 뜻 번역, 없으면 로마자(한→영 국어의 로마자 표기법 / 영→한 한글 음차).
- 본문 소스: 배포 시점의 index.ts 는 Supabase 대시보드 → Edge Functions → translate-review 에서 확인(리드가 MCP 로 배포 · 동일 내용을 index.ts 로 보관).
