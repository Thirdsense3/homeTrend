// POST /sync/{op}: 관심 목록 동기화 (로드맵 5번). 규칙은 sync.mjs
//   create  { changes }               새 코드를 만들고 이 기기 목록을 올린다 → { code, rev, items }
//   push    { code, base, changes }   변경을 보내고 서버 목록을 받는다(변경이 없으면 받기만) → { rev, items, conflicts } | { stale, rev, items }
//   rotate  { code }                  코드 재발급. 이전 코드는 바로 무효 → { code, rev, items }
//   delete  { code }                  코드와 목록 삭제
// 코드는 본문으로만 받는다(주소·로그에 남지 않게). 요청 본문·IP는 로그에 남기지 않는다
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  parseRequest, newCode, pkOf, emptyDoc, apply, view, isStale, ttl, expired, BadRequest, TOUCH_EVERY,
} from './sync.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE;
const ORIGIN = process.env.ALLOWED_ORIGIN;

// IP당 분당 요청 수 (실행 환경마다 따로 센다. API Gateway 전체 제한과 함께 쓴다). 코드 만들기는 더 적게
const LIMITS = { all: 60, create: 5 };
const ipHits = new Map();
function ipLimited(ip, op, now) {
  const min = Math.floor(now / 60000);
  if (ipHits.size > 5000) ipHits.clear();
  for (const k of op === 'create' ? ['all', 'create'] : ['all']) {
    const h = ipHits.get(`${k}|${ip}`);
    if (!h || h.min !== min) ipHits.set(`${k}|${ip}`, { min, n: 1 });
    else if (++h.n > LIMITS[k]) return true;
  }
  return false;
}

const res = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
const OPS = { create, push, rotate, remove };

export const handler = async (event) => {
  const now = Date.now();
  const origin = event.headers?.origin;
  if (origin && origin !== ORIGIN) return res(403, { error: 'origin' });
  const op = event.pathParameters?.op === 'delete' ? 'remove' : event.pathParameters?.op;
  if (!Object.hasOwn(OPS, op)) return res(404, { error: 'op' });
  if (ipLimited(event.requestContext?.http?.sourceIp || '', op, now)) return res(429, { error: 'rate' });
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    return await OPS[op](parseRequest(body, { needCode: op !== 'create' }), now);
  } catch (e) {
    if (e instanceof BadRequest) return res(e.status, { error: e.message });
    console.error(op, e.name, e.message);
    return res(500, { error: 'internal' });
  }
};

const stamp = (doc, now) => ({ ...doc, updatedAt: new Date(now).toISOString(), touchedAt: now, expiresAt: ttl(now) });

async function load(code, now) {
  const item = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: pkOf(code), sk: 's' }, ConsistentRead: true }))).Item;
  return expired(item, now) ? null : item;
}

async function create({ changes }, now) {
  const { doc, conflicts } = apply(emptyDoc(), changes.map((c) => ({ ...c, from: 0 })), now);
  if (conflicts.length) throw new BadRequest('변경 형식');
  const code = newCode();
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: pkOf(code), sk: 's', ...stamp(doc, now), createdAt: new Date(now).toISOString() },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
  return res(200, { code, ...view(doc) });
}

// 읽은 리비전 그대로일 때만 쓴다(조건부 갱신). 동시에 다른 기기가 썼으면 다시 읽고 다시 판정한다
async function push({ code, base, changes }, now) {
  for (let tries = 0; tries < 4; tries++) {
    const item = await load(code, now);
    if (!item) return res(404, { error: 'code' });
    const { pk, sk, ...doc } = item;
    if (changes.length && isStale(doc, base)) return res(200, { stale: true, ...view(doc) });
    const { doc: next, conflicts, changed } = apply(doc, changes, now);
    if (!changed) {
      // 받기만: 접근 시각(만료 연장)만 하루에 한 번 쓴다
      if (now - (item.touchedAt || 0) >= TOUCH_EVERY) {
        await db.send(new UpdateCommand({
          TableName: TABLE, Key: { pk, sk },
          UpdateExpression: 'SET touchedAt = :t, expiresAt = :e',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':t': now, ':e': ttl(now) },
        })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
      }
      return res(200, { ...view(doc), conflicts });
    }
    try {
      await db.send(new PutCommand({
        TableName: TABLE,
        Item: { pk, sk, ...stamp(next, now) },
        ConditionExpression: 'rev = :rev',
        ExpressionAttributeValues: { ':rev': doc.rev },
      }));
      return res(200, { ...view(next), conflicts });
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    }
  }
  return res(409, { error: 'busy' });
}

async function rotate({ code }, now) {
  for (let tries = 0; tries < 4; tries++) {
    const item = await load(code, now);
    if (!item) return res(404, { error: 'code' });
    const { pk, sk, ...doc } = item;
    const fresh = newCode();
    try {
      await db.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: { ...item, ...stamp(doc, now), pk: pkOf(fresh) }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Delete: { TableName: TABLE, Key: { pk, sk }, ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': doc.rev } } },
        ],
      }));
      return res(200, { code: fresh, ...view(doc) });
    } catch (e) {
      if (e.name !== 'TransactionCanceledException') throw e;
    }
  }
  return res(409, { error: 'busy' });
}

async function remove({ code }) {
  const r = await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: pkOf(code), sk: 's' }, ReturnValues: 'ALL_OLD' }));
  return r.Attributes ? res(200, { deleted: true }) : res(404, { error: 'code' });
}
