# K예술영재 온라인 멘토링

`https://mentoring.kartsproject.com/` — 분야 고르기

| 폴더 | 분야 | 주소 | 안내 |
|---|---|---|---|
| `b/` | 무용 — 멘토 1 : 학생 1, 대기실·차례 입장, 학생별 녹화 | `/b/` (학생) · `/b/m.html` · `/b/o.html` | [b/docs/설치·운영안내.md](b/docs/설치·운영안내.md) |
| `a/` | 미술 — 멘토 여러 명 + 학생 10여 명, 전체 ↔ 조별 분반 | `/a/` (구축 예정) | [a/docs/구상안.md](a/docs/구상안.md) |

- 각 폴더의 `apps-script/Code.gs`는 분야별 구글 시트에 붙는 관문(비밀값은 스크립트 속성)
- 시험: `node test/mock-server.js` → `node test/e2e.js` (무용)
