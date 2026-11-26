# 롤가다 · 시즌 내전 · 팀대항전 센터

https://lolgada.netlify.app

- `public/` — 사이트 (index.html, 내전 통계 games.js)
- `netlify/functions/extract.mjs` — 결과창 스크린샷을 AI(Claude Haiku)로 읽는 서버 함수
- 비밀값은 저장소에 없습니다. AI 키는 Netlify 환경변수 `ANTHROPIC_API_KEY`에만 둡니다.

이 저장소에 push하면 Netlify가 자동으로 배포합니다. 처음 연결하는 방법은 `배포_안내.md`를 보세요.
