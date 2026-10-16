// POST /events: 방문 이벤트 받기. DELETE /devices/{id}: 이 기기 기록 삭제
// 규칙은 metrics.mjs. 쿠키·IP를 저장하지 않는다 (IP는 이 실행 환경 메모리에서 요청 제한 판정에만 쓴다)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, UpdateCommand, TransactWriteCommand, QueryCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  parseBatch, isDeviceId, BadRequest, kstDate, ttl, coreDay, VERSION, DAILY_MAX, ACTIVATION_WINDOW, CORE,
} from './metrics.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE;
const ORIGIN = process.env.ALLOWED_ORIGIN;

// IP당 분당 요청 수. 저장하지 않으므로 실행 환경마다 따로 센다 (API Gateway 전체 제한과 함께 쓴다)
const IP_PER_MIN = 60;
const ipHits = new Map();
function ipLimited(ip, now) {
  const min = Math.floor(now / 60000);
  if (ipHits.size > 5000) ipHits.clear();
  const h = ipHits.get(ip);
  if (!h || h.min !== min) { ipHits.set(ip, { min, n: 1 }); return false; }
  return ++h.n > IP_PER_MIN;
}

const res = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: body === undefined ? '' : JSON.stringify(body),
});

export const handler = async (event) => {
  const now = Date.now();
  const origin = event.headers?.origin;
  if (origin && origin !== ORIGIN) return res(403, { error: 'origin' });
  if (ipLimited(event.requestContext?.http?.sourceIp || '', now)) return res(429, { error: 'rate' });
  try {
    if (event.routeKey === 'DELETE /devices/{id}') return await removeDevice(event.pathParameters?.id);
    const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    return await record(parseBatch(body, now), now);
  } catch (e) {
    if (e instanceof BadRequest) return res(e.status, { error: e.message });
    console.error(e.name, e.message); // 요청 본문·IP는 남기지 않는다
    return res(500, { error: 'internal' });
  }
};

async function record({ device, firstVisit, mobile, events }, now) {
  const pk = `dev#${device}`;
  const nowIso = new Date(now).toISOString();
  const date = kstDate(now);
  const summary = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk: 's' } }))).Item;
  if (summary?.flagged) return res(429, { error: 'device' });

  let accepted = 0;
  let activatedAt = summary?.activatedAt;
  for (const e of events) {
    // 기기 요약: 첫 방문은 처음 값을 유지, 만료(TTL)는 마지막 활동 기준으로 매번 연장
    const set = ['firstSeen = if_not_exists(firstSeen, :fv)', 'lastSeen = :now', 'mobile = :m', 'v = :v', 'expiresAt = :exp'];
    const add = [];
    const vals = { ':fv': firstVisit, ':now': nowIso, ':m': mobile, ':v': VERSION, ':exp': ttl(now) };
    if (e.props.n !== undefined && /^(watch_add|watch_remove|view_watch)$/.test(e.type)) { set.push('watchCount = :n'); vals[':n'] = e.props.n; }
    if (e.type === 'watch_add') set.push('firstWatchAddAt = if_not_exists(firstWatchAddAt, :now)');
    if (e.type === 'watch_change_available' && e.props.t > 0) { set.push('hadChange = :t'); vals[':t'] = true; }
    const cd = CORE.has(e.type) ? coreDay(activatedAt, now) : null;
    if (cd !== null) { add.push('coreDays :cd'); vals[':cd'] = new Set([cd]); }
    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          // 같은 이벤트 ID는 한 번만 (재전송 중복 제거). 실패하면 나머지도 쓰지 않는다
          // 하루 상한도 같은 트랜잭션에서 검사해, 동시 요청도 넘지 못하고 중복 재전송은 건수에 들어가지 않는다
          { Put: { TableName: TABLE, Item: { pk, sk: `e#${e.id}`, type: e.type, props: e.props, receivedAt: nowIso, v: VERSION, expiresAt: ttl(now) }, ConditionExpression: 'attribute_not_exists(pk)' } },
          {
            Update: {
              TableName: TABLE, Key: { pk, sk: `d#${date}` },
              UpdateExpression: 'SET mobile = :m, expiresAt = :exp ADD n :one, acts :act',
              ConditionExpression: 'attribute_not_exists(n) OR n < :max',
              ExpressionAttributeValues: { ':m': mobile, ':exp': ttl(now), ':one': 1, ':act': new Set([e.type]), ':max': DAILY_MAX },
            },
          },
          { Update: { TableName: TABLE, Key: { pk, sk: 's' }, UpdateExpression: `SET ${set.join(', ')}${add.length ? ` ADD ${add.join(', ')}` : ''}`, ExpressionAttributeValues: vals } },
        ],
      }));
      accepted++;
    } catch (err) {
      const [dup, full] = err.name === 'TransactionCanceledException' ? err.CancellationReasons.map((r) => r?.Code === 'ConditionalCheckFailed') : [];
      if (dup) continue;
      if (full) {
        // 하루 상한 초과: 이후 요청을 거부하고 집계에서 뺀다
        await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk, sk: 's' }, UpdateExpression: 'SET flagged = :t, expiresAt = :exp', ExpressionAttributeValues: { ':t': true, ':exp': ttl(now) } }));
        return res(429, { error: 'device', accepted });
      }
      throw err;
    }
    // 활성화: 첫 방문 후 24시간 안에 관심단지를 저장하고, 그 뒤 관심단지 요약을 확인
    if (e.type === 'view_watch' && !activatedAt) {
      try {
        await db.send(new UpdateCommand({
          TableName: TABLE, Key: { pk, sk: 's' },
          UpdateExpression: 'SET activatedAt = :now',
          ConditionExpression: 'attribute_not_exists(activatedAt) AND attribute_exists(firstWatchAddAt) AND firstSeen >= :cutoff',
          ExpressionAttributeValues: { ':now': nowIso, ':cutoff': new Date(now - ACTIVATION_WINDOW).toISOString() },
        }));
        activatedAt = nowIso;
      } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  }
  return res(200, { accepted });
}

async function removeDevice(id) {
  if (!isDeviceId(id)) throw new BadRequest('기기 ID');
  const pk = `dev#${id}`;
  let deleted = 0, start;
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: 'pk, sk', ExclusiveStartKey: start,
    }));
    for (let i = 0; i < r.Items.length; i += 25) {
      let req = { [TABLE]: r.Items.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
      for (let tries = 0; req && Object.keys(req).length; tries++) {
        if (tries > 5) throw new Error('삭제 재시도 초과');
        if (tries) await new Promise((ok) => setTimeout(ok, 100 * 2 ** tries));
        req = (await db.send(new BatchWriteCommand({ RequestItems: req }))).UnprocessedItems;
      }
    }
    deleted += r.Items.length;
    start = r.LastEvaluatedKey;
  } while (start);
  return res(200, { deleted });
}
