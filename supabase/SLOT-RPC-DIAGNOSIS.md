# 슬롯 RPC 대조 및 운영 확인

최신 main 프런트엔드는 `golf_mutate(p_game, p_revision, p_action, p_detail)`에
`p_action = 'slot'`, `p_detail = {"value": 1}`을 보냅니다. 화면 슬롯 2는 0 기반 인덱스 1입니다.
`claim`은 화면 버튼 이름이며 RPC 작업 이름이 아닙니다.

- 이전 함수 (`tests/fixtures/legacy-schema.sql`): score, near, lock, finalize, rate, paid, settled, cash 지원. slot 요청은 생성자의 경우 P0001 / 지원하지 않는 변경입니다.
- 현재 schema 및 001 마이그레이션: 위 작업에 name, slot, initial 추가.
- slot은 미연결 회원만 빈 슬롯에 최초 연결합니다. 이미 슬롯 1에 연결된 회원의 슬롯 2 이동은 의도적으로 거부합니다. 점수 소유권을 이름이나 참가 순서로 추정하지 않습니다.

테스트는 이전 함수를 실제 PostgreSQL 엔진(PGlite)에서 실행해 오류를 재현한 뒤 001을 두 번 적용해 데이터 보존과 정상 연결을 확인합니다. 이는 운영 DB 정의 확인을 대신하지 않습니다. 운영 Supabase 자격 증명은 작업 환경에 없으므로 마이그레이션 미적용을 운영 원인으로 확정할 수 없습니다. 보고된 문구 '지정하지 않은 변경입니다'와 저장소의 '지원하지 않는 변경입니다'도 다르므로 실제 정의를 확인해야 합니다.

운영 SQL Editor에서 아래 읽기 전용 쿼리를 실행해 실제 분기와 서명을 확인하세요.

```sql
select pg_get_functiondef('public.golf_mutate(uuid,bigint,text,jsonb)'::regprocedure);
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='golf_members' and column_name='slot';
```

slot 분기가 없다면 백업 확인 후 `001-player-slots.sql` 전체를 실행합니다. 기존 `schema.sql`은 재실행하지 않습니다. 001은 기존 라운드·점수·정산·회원·이력을 삭제하지 않으며 기존 연결을 재배정하지 않습니다. 함수 교체 및 nullable slot 컬럼/고유 인덱스 추가만 수행합니다. 운영 데이터에는 이번 작업에서 SQL을 적용하지 않았습니다.

서버는 게임 행 잠금, revision 검증, 회원 확인, 이미 연결된 사용자/점유 슬롯/최종 확정 차단, 고유 인덱스로 슬롯 충돌을 방지합니다. 슬롯 연결은 선택한 선수 표시 이름만 갱신하며 점수·Near·지급·정산·초기 순위는 유지합니다. 사용자의 실제 기록 소유 여부는 자동 판정할 수 없어 화면에서 본인 기록 확인을 요구합니다.
