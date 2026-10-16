// 매일 집계 (EventBridge Scheduler, 05:00 KST): 기기 요약으로 활성화·재방문·날짜별 표를 다시 계산해 agg#<표>에 쓴다
// 지금 규모에선 테이블 전체를 한 번 읽는다. 읽기 비용이 커지면 기기 요약용 색인이나 내보내기로 바꾼다
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { aggregate } from './metrics.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE;

export const handler = async () => {
  const items = [];
  let start;
  do {
    const r = await db.send(new ScanCommand({
      TableName: TABLE,
      // 원본 이벤트(e#)와 이전 집계는 읽을 필요 없음
      FilterExpression: 'begins_with(pk, :dev) AND (sk = :s OR begins_with(sk, :d))',
      ExpressionAttributeValues: { ':dev': 'dev#', ':s': 's', ':d': 'd#' },
      ExclusiveStartKey: start,
    }));
    items.push(...r.Items);
    start = r.LastEvaluatedKey;
  } while (start);

  const rows = aggregate(items);
  for (let i = 0; i < rows.length; i += 25) {
    let req = { [TABLE]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
    for (let tries = 0; req && Object.keys(req).length; tries++) {
      if (tries > 5) throw new Error('집계 쓰기 재시도 초과');
      if (tries) await new Promise((ok) => setTimeout(ok, 100 * 2 ** tries));
      req = (await db.send(new BatchWriteCommand({ RequestItems: req }))).UnprocessedItems;
    }
  }
  console.log(`기기 요약 ${items.filter((x) => x.sk === 's').length}개 → 집계 ${rows.length}행`);
  return { rows: rows.length };
};
