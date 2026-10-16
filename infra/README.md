# AWS 기반 (로드맵 1·2번)

조회 화면은 지금처럼 GitHub Pages 정적 파일이고, AWS는 상태가 필요한 기능에만 쓴다 ([로드맵](../docs/roadmap.md)).
이 스택은 그 토대다.

| 리소스 | 용도 |
|---|---|
| S3 `hometrend-history-<계정>` | 거래 이력(국토부 원본 캐시) 보관. 버전 관리·암호화·공개 차단 |
| DynamoDB `hometrend` | 방문 측정(2번), 이후 동기화 목록·알림 구독. 시점 복구, TTL `expiresAt` |
| HTTP API `GET /health` | 상태 확인. 마지막으로 확정된 빌드를 돌려준다. Pages 출처만 CORS 허용, 요청 제한 |
| HTTP API `POST /events`, `DELETE /devices/{id}` | 방문 이벤트 받기, 이 기기 기록 삭제 (아래 방문 측정) |
| 집계 Lambda | 매일 05:00 KST 활성화·재방문·날짜별 표 계산 (EventBridge Scheduler) |
| IAM 역할 2개 | Actions OIDC. build job(main 브랜치)용, deploy job(`github-pages` 환경)용. 장기 키 없음 |
| 예산 알림 | 계정 전체 월 비용이 기준(기본 $20)의 80%에 도달하거나 초과가 예상되면 메일 |

## 이력 보관 방식

빌드는 Actions 캐시 대신 S3에서 마지막으로 **확정된** 빌드의 이력을 받아 이어 받고, 끝나면 이 빌드의 스냅샷을 올린다. Pages 배포가 성공해야 확정되므로, 실패한 배포의 이력은 다음 빌드가 읽지 않는다. 규칙과 경로는 `lib/history.js`에 있다.

- 빌드 순번: (`run_number`, `run_attempt`). 빌드 job이 `meta.json`의 `build`에 기록하고, deploy job은 배포 아티팩트에서 이 값을 읽는다. 배포 job만 재실행하면 같은 순번, 전체 재실행하면 새 순번이다.
- 배포 전 확인: 더 큰 순번이 이미 확정돼 있거나(과거 실행 재실행) 포인터를 읽지 못하면 job이 실패해 Pages와 S3 모두 그대로 둔다. 실패 알림이 알람 역할을 한다.
- 확정: `confirmed.json`을 조건부 쓰기(If-Match)로 더 큰 순번일 때만 올리고, `history/cache.tar.gz`(장기 보관본)와 `confirmed/<순번>.json`(확정 마커)을 쓴다. 같은 순번으로 다시 실행하면 빠진 단계만 다시 한다.
- 수명 주기: `builds/` 스냅샷은 30일, 장기 보관본의 이전 버전은 최근 10개를 남기고 30일 뒤 삭제. 잘못 쓴 이력은 `history/cache.tar.gz`의 이전 버전으로 되돌린다.
- 이력을 읽지 못하면 빌드를 멈춘다. 빈 이력으로 새로 받거나 덮어쓰지 않는다.
- 빌드가 실패하면(실패 5% 초과) 그 실행에서 받은 데이터는 저장하지 않는다. 다음 실행은 마지막 확정 이력에서 다시 받는다.

## 방문 측정

사이트가 무작위 기기 ID와 행동 종류만 `POST /events`로 보낸다. 지표 정의는 [로드맵 세부 사항 2](../docs/roadmap.md), 항목 구조·허용 이벤트·집계 규칙은 `functions/metrics/metrics.mjs`, 사용자에게 밝히는 내용은 사이트의 개인정보처리방침(`#/privacy`)에 있다. 셋 중 하나를 바꾸면 나머지도 맞춘다.

- 보내는 것: 기기 ID, 첫 방문 시각, 모바일 여부, 이벤트 ID·종류와 종류별로 허용한 숫자(관심단지 수, 새 거래 건수, 데이터 빌드 순번). 검색어·단지 이름·관심 목록·쿠키는 없다.
- IP는 Lambda 메모리에서 분당 요청 수 판정에만 쓴다. 로그에 본문·IP를 남기지 않고, API Gateway 접근 로그도 켜지 않는다.
- 중복 제거: 이벤트 ID 조건부 쓰기. 기기 하루 500건을 넘으면 거부하고 그 기기를 집계에서 뺀다.
- 보관: 원본 이벤트·날짜별 요약 90일, 기기 요약은 마지막 활동 기준 90일(TTL). 집계 행(`agg#daily`·`agg#activation`·`agg#retention`)은 기기를 식별할 수 없는 숫자만 있고 장기 보관한다.
- 측정 이전부터 관심단지·좋아요·테마를 저장해 둔 브라우저는 기존 사용자로 표시해 신규 활성화 분모에 넣지 않는다.
- 저장소 변수 `API_URL`이 없으면 사이트는 아무것도 보내지 않는다. 로컬 서버(`npm start`)도 보내지 않는다.

집계 보기 (기준선: `API_URL`을 넣은 뒤 2주):

```bash
node scripts/metrics.js 28   # 날짜별 방문·행동, 첫 방문일별 활성화, 활성화일별 1주·4주 재방문
```

집계는 매일 최근 60일을 다시 계산해 덮어쓴다. 바로 다시 만들려면 `aws lambda invoke --function-name <MetricsAggregateFunction 이름> /dev/stdout`.

## 처음 설정

필요한 도구: [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), 관리자 권한 AWS 자격 증명, `gh`.

```bash
cd infra
sam build
sam deploy --parameter-overrides BudgetEmail=<메일>
# 계정에 GitHub OIDC 공급자가 이미 있으면: GitHubOidcProviderArn=arn:aws:iam::<계정>:oidc-provider/token.actions.githubusercontent.com 추가
```

배포 출력값을 저장소 변수로 넣는다.

```bash
out() { aws cloudformation describe-stacks --region ap-northeast-2 --stack-name hometrend \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
gh variable set HISTORY_BUCKET --body "$(out HistoryBucketName)"
gh variable set AWS_BUILD_ROLE_ARN --body "$(out BuildRoleArn)"
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(out DeployRoleArn)"
gh variable set API_URL --body "$(out ApiUrl)"   # 방문 측정. 다음 배포부터 사이트가 이벤트를 보낸다
curl "$(out ApiUrl)/health"   # {"ok":true,...,"confirmed":null}
```

`HISTORY_BUCKET`이 없으면 워크플로는 예전처럼 Actions 캐시만 쓴다. 변수를 넣은 뒤 첫 실행은 S3에 확정된 이력이 없으므로 Actions 캐시에서 시작해 S3로 옮기고, 그 뒤로는 Actions 캐시를 쓰지 않는다. `/health`의 `confirmed`가 채워지면 이전이 끝난 것이다.

## 되돌리기

- 이력 되돌리기: `history/cache.tar.gz`의 이전 버전을 현재 버전으로 복사하고, `confirmed.json`의 `snapshot`이 가리키는 스냅샷을 지운다(다음 빌드는 그 스냅샷을 먼저 읽고, 없으면 장기 보관본을 읽는다).
- 측정 중단: 저장소 변수 `API_URL`을 지우고 다시 배포하면 사이트가 이벤트를 보내지 않는다. 남은 기록은 TTL로 90일 안에 지워진다.
- S3 사용 중단: 저장소 변수 `HISTORY_BUCKET`을 지우면 Actions 캐시 방식으로 돌아간다(캐시가 비어 있으면 첫 실행처럼 전체를 다시 받는다).
- 스택 삭제: `sam delete`. 버킷과 테이블은 데이터 보호를 위해 남으므로 필요하면 직접 지운다.
