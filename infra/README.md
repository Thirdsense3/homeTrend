# AWS 기반 (로드맵 1번)

조회 화면은 지금처럼 GitHub Pages 정적 파일이고, AWS는 상태가 필요한 기능에만 쓴다 ([로드맵](../docs/roadmap.md)).
이 스택은 그 토대다.

| 리소스 | 용도 |
|---|---|
| S3 `hometrend-history-<계정>` | 거래 이력(국토부 원본 캐시) 보관. 버전 관리·암호화·공개 차단 |
| DynamoDB `hometrend` | 동기화 목록·알림 구독·측정 집계 (2번 작업부터 사용). 시점 복구, TTL `expiresAt` |
| HTTP API `GET /health` | 상태 확인. 마지막으로 확정된 빌드를 돌려준다. Pages 출처만 CORS 허용, 요청 제한 |
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
curl "$(out ApiUrl)/health"   # {"ok":true,...,"confirmed":null}
```

`HISTORY_BUCKET`이 없으면 워크플로는 예전처럼 Actions 캐시만 쓴다. 변수를 넣은 뒤 첫 실행은 S3에 확정된 이력이 없으므로 Actions 캐시에서 시작해 S3로 옮기고, 그 뒤로는 Actions 캐시를 쓰지 않는다. `/health`의 `confirmed`가 채워지면 이전이 끝난 것이다.

## 되돌리기

- 이력 되돌리기: `history/cache.tar.gz`의 이전 버전을 현재 버전으로 복사하고, `confirmed.json`의 `snapshot`이 가리키는 스냅샷을 지운다(다음 빌드는 그 스냅샷을 먼저 읽고, 없으면 장기 보관본을 읽는다).
- S3 사용 중단: 저장소 변수 `HISTORY_BUCKET`을 지우면 Actions 캐시 방식으로 돌아간다(캐시가 비어 있으면 첫 실행처럼 전체를 다시 받는다).
- 스택 삭제: `sam delete`. 버킷과 테이블은 데이터 보호를 위해 남으므로 필요하면 직접 지운다.
