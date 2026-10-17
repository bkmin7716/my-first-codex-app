# PAR 대비 점수 입력 미리보기

작업 브랜치: `feature/unified-scorecard-preview`

```sh
npm ci
npm test
npm run test:browser
npm start
```

`http://localhost:8080`에서 일반 게임 또는 후세인 게임을 생성한 뒤
‘스코어 입력하기’를 누릅니다. 기존 운영 주소와 다른 주소이므로 로컬 저장소도 분리됩니다.
운영 앱의 저장 데이터를 가져오지 않고 새 테스트 라운드로 확인하세요.

- 기본 입력: −1, 0(파), +1, +2, +3, +4, +5
- 확장 입력: 해당 PAR에서 가능한 실제 타수 1~30 범위의 추가 점수
- ‘미입력’ 버튼으로 점수를 비웁니다. 미입력은 —, 파는 0으로 표시합니다.
- 현황 탭: 홀별 PAR와 상대 점수, OUT / IN / TOTAL을 확인합니다.
- 실제 타수 저장 형식과 후세인 계산, 공동 게임 RPC 및 DB 스키마는 유지합니다.
- 공동 테스트는 `npm run test:browser`가 격리된 PGlite DB와 테스트 전송 계층으로 검증합니다.
  실제 Supabase Auth/Realtime 서비스에 대한 검증은 포함하지 않습니다.
- 기본 `shared-config.js`는 빈 설정입니다. 운영 DB 연결 없이 로컬 화면을 미리볼 수 있습니다.

배포, 운영 데이터 변경, main 브랜치 변경은 수행하지 않습니다.
