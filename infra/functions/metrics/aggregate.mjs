// 매일 집계 (EventBridge Scheduler, 05:00 KST): 기기 요약으로 활성화·재방문·날짜별 표를 다시 계산해 agg#<표>에 쓴다
// 지금 규모에선 테이블 전체를 한 번 읽는다. 읽기 비용이 커지면 기기 요약용 색인이나 내보내기로 바꾼다
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { aggregate, staleRows, aggFrom, AGG_TABLES } from './metrics.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE;

async function paged(make) {
  const items = [];
  let start;
  do {
    const r = await db.send(make(start));
    items.push(...r.Items);
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
}

async function batchWrite(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let req = { [TABLE]: requests.slice(i, i + 25) };
    for (let tries = 0; req && Object.keys(req).length; tries++) {
      if (tries > 5) throw new Error('집계 쓰기 재시도 초과');
      if (tries) await new Promise((ok) => setTimeout(ok, 100 * 2 ** tries));
      req = (await db.send(new BatchWriteCommand({ RequestItems: req }))).UnprocessedItems;
    }
  }
}

export const handler = async () => {
  const now = Date.now();
  const items = await paged((start) => new ScanCommand({
    TableName: TABLE,
    // 원본 이벤트(e#)와 이전 집계는 읽을 필요 없음
    FilterExpression: 'begins_with(pk, :dev) AND (sk = :s OR begins_with(sk, :d))',
    ExpressionAttributeValues: { ':dev': 'dev#', ':s': 's', ':d': 'd#' },
    ExclusiveStartKey: start,
  }));
  const existing = (await Promise.all(AGG_TABLES.map((t) => paged((start) => new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND sk >= :f',
    ExpressionAttributeValues: { ':p': `agg#${t}`, ':f': aggFrom(now) },
    ProjectionExpression: 'pk, sk',
    ExclusiveStartKey: start,
  }))))).flat();

  const rows = aggregate(items, now);
  const stale = staleRows(existing, rows, now);
  await batchWrite([...rows.map((Item) => ({ PutRequest: { Item } })), ...stale.map((Key) => ({ DeleteRequest: { Key } }))]);
  console.log(`기기 요약 ${items.filter((x) => x.sk === 's').length}개 → 집계 ${rows.length}행, 지운 행 ${stale.length}`);
  return { rows: rows.length, removed: stale.length };
};
