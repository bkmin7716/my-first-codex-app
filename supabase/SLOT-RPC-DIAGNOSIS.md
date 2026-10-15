# 슬롯 연결 오류와 최종 정책

운영 함수에 slot 분기가 없다는 사용자의 조회 결과로 이전 P0001 원인이 확인되었습니다. 최신 정책은 골프 선수 이름과 계정 표시 이름을 분리합니다. 프런트엔드는 golf_mutate에 p_action='slot', p_detail={"value":0}을 전송합니다. 생성자도 직접 선택합니다. slot 작업은 회원의 slot만 변경하고 round.players를 변경하지 않습니다.

적용 전에는 001-player-slots-precheck.sql, 실제 적용에는 001-player-slots.sql, 적용 후에는 001-player-slots-postcheck.sql을 사용하세요. UPGRADE.md에 전환 순서와 RPC 계약이 있습니다. 기존 schema.sql은 재실행하지 않습니다.
