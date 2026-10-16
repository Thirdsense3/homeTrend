// GET /health: API 동작 여부와 마지막으로 확정된 빌드 (프런트는 실패하면 서버 기능만 숨긴다)
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const handler = async () => {
  let ok = true, confirmed = null;
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: process.env.HISTORY_BUCKET, Key: 'confirmed.json' }));
    const { seq, builtAt, confirmedAt } = JSON.parse(await r.Body.transformToString());
    confirmed = { seq, builtAt, confirmedAt };
  } catch (e) {
    // 아직 확정된 빌드가 없는 건 정상
    if (e.name !== 'NoSuchKey') { ok = false; console.error(e); }
  }
  return {
    statusCode: ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ ok, time: new Date().toISOString(), confirmed }),
  };
};
