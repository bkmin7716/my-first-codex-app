# 슬롯 오류와 정책 버전 분리

이전 P0001 오류는 운영 golf_mutate에 slot 작업 분기가 없었던 문제입니다. 기존 게임 5개에도 sharedSlots=true가 이미 있으므로 그 플래그로 새 정책 여부를 판단하면 기존 참가자 13명에게 새 연결을 강제하게 됩니다.

최종 정책은 JSON 숫자 round.slotPolicyVersion=1인 게임에만 적용합니다. golf_create가 새 공동 게임 생성 시에만 버전을 추가하고 기존 행은 변경하지 않습니다. 프런트엔드와 RPC 모두 버전 기준으로 판정합니다. 기존 sharedSlots=true/null 게임은 슬롯 연결 없이 점수·Near·잠금·정산·재접속·최종 확정을 유지합니다.

사전 점검: 001-player-slots-precheck.sql
실제 적용: 001-player-slots.sql
사후 점검: 001-player-slots-postcheck.sql
상세 순서: UPGRADE.md

운영 DB에는 SQL을 직접 실행하지 않습니다. GitHub push와 Pages 배포는 운영 DB 마이그레이션을 대신하지 않습니다.
