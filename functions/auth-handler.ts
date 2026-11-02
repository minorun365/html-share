import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';

const ssm = new SSMClient({});
const FLOW_SECONDS = 30 * 60;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
let privateKeyPromise: Promise<string> | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function privateKey(): Promise<string> {
  if (!privateKeyPromise) {
    privateKeyPromise = ssm.send(new GetParameterCommand({
      Name: required('PRIVATE_KEY_PARAMETER_NAME'),
      WithDecryption: true,
    })).then((result) => {
      const value = result.Parameter?.Value;
      if (!value) throw new Error('CloudFront private key is empty');
      return value;
    });
  }
  return privateKeyPromise;
}

function cookieMap(event: any): Record<string, string> {
  const result: Record<string, string> = {};
  for (const cookie of event.cookies ?? []) {
    const index = cookie.indexOf('=');
    if (index > 0) result[cookie.slice(0, index)] = cookie.slice(index + 1);
  }
  return result;
}

function hmac(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function equalHex(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left)
    && /^[a-f0-9]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function stateKey(key: string): string {
  return createHash('sha256').update(key).update('html-share-state-v1').digest('hex');
}

function createState(key: string): string {
  const payload = Buffer.from(JSON.stringify({
    expiresAt: Math.floor(Date.now() / 1000) + FLOW_SECONDS,
    nonce: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${hmac(stateKey(key), payload)}`;
}

function verifyState(value: string, key: string): void {
  const [payload, signature, extra] = String(value ?? '').split('.');
  if (!payload || !signature || extra || !equalHex(signature, hmac(stateKey(key), payload))) {
    throw new Error('Invalid OAuth state');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!Number.isInteger(decoded.expiresAt) || decoded.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('Expired OAuth state');
  }
}

function redirect(location: string, cookies: string[] = []): any {
  return {
    statusCode: 302,
    headers: { location, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
    cookies,
  };
}

function failure(statusCode: number, message: string): any {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
    body: `<!doctype html><meta charset="utf-8"><title>Login error</title><h1>Login error</h1><p>${message}</p>`,
  };
}

function cognitoUrl(pathname: string): URL {
  return new URL(pathname, required('COGNITO_ORIGIN'));
}

// 管理者が作った本人ユーザーには、Cognito がログイン後にパスキーの登録を勧めない。
// /auth/passkey は Cognito の登録ページ（/passkeys/add）へ同じ引数で送り、登録後はふつうのログインと同じ戻り口へ帰す。
async function login(cognitoPath = '/oauth2/authorize'): Promise<any> {
  const key = await privateKey();
  const verifier = randomBytes(48).toString('base64url');
  const authorize = cognitoUrl(cognitoPath);
  authorize.search = new URLSearchParams({
    client_id: required('COGNITO_CLIENT_ID'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    redirect_uri: required('CALLBACK_URL'),
    response_type: 'code',
    scope: 'openid email',
    state: createState(key),
  }).toString();
  return redirect(authorize.toString(), [
    `html_share_pkce=${verifier}; Path=/auth/; Secure; HttpOnly; SameSite=Lax; Max-Age=${FLOW_SECONDS}`,
  ]);
}

async function callback(event: any): Promise<any> {
  const key = await privateKey();
  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  // /passkeys/add は登録後、code を付けず ?result=success だけで戻す。Cognito 側のセッションは残っているので、
  // ふつうのログインへ流せば画面を挟まずに一覧アプリへ入れる。
  if (!code && event.queryStringParameters?.result === 'success') return await login();
  const verifier = cookieMap(event).html_share_pkce;
  if (!code || !state || !verifier) return failure(400, 'Authentication information is incomplete.');
  verifyState(state, key);

  const response = await fetch(cognitoUrl('/oauth2/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required('COGNITO_CLIENT_ID'),
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: required('CALLBACK_URL'),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
  const tokens = await response.json() as { access_token?: string };
  if (!tokens.access_token) throw new Error('Access token is missing');
  const userInfoResponse = await fetch(cognitoUrl('/oauth2/userInfo'), {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!userInfoResponse.ok) throw new Error(`UserInfo failed: ${userInfoResponse.status}`);
  const userInfo = await userInfoResponse.json() as { email?: string; email_verified?: boolean | string };
  if (
    String(userInfo.email ?? '').toLowerCase() !== required('OWNER_EMAIL').toLowerCase()
    || String(userInfo.email_verified) !== 'true'
  ) return failure(403, 'This account is not allowed.');

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const policy = JSON.stringify({
    Statement: [{
      Resource: `${required('CONSOLE_ORIGIN')}/*`,
      Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt } },
    }],
  });
  const signed = getSignedCookies({
    keyPairId: required('CLOUDFRONT_KEY_PAIR_ID'),
    privateKey: key,
    policy,
  });
  const cookieAttributes = `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
  return redirect('/app/index.html', [
    `CloudFront-Policy=${signed['CloudFront-Policy']}; ${cookieAttributes}`,
    `CloudFront-Signature=${signed['CloudFront-Signature']}; ${cookieAttributes}`,
    `CloudFront-Key-Pair-Id=${signed['CloudFront-Key-Pair-Id']}; ${cookieAttributes}`,
    'html_share_pkce=; Path=/auth/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
  ]);
}

function logout(): any {
  const attributes = 'Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
  const url = cognitoUrl('/logout');
  url.search = new URLSearchParams({
    client_id: required('COGNITO_CLIENT_ID'),
    logout_uri: required('CONSOLE_ORIGIN'),
  }).toString();
  return redirect(url.toString(), [
    `CloudFront-Policy=; ${attributes}`,
    `CloudFront-Signature=; ${attributes}`,
    `CloudFront-Key-Pair-Id=; ${attributes}`,
  ]);
}

export async function handler(event: any): Promise<any> {
  try {
    const pathname = event.rawPath ?? event.requestContext?.http?.path ?? '';
    if (pathname === '/auth/login') return await login();
    if (pathname === '/auth/passkey') return await login('/passkeys/add');
    if (pathname === '/auth/callback') return await callback(event);
    if (pathname === '/auth/logout') return logout();
    return failure(404, 'Not found.');
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : 'Unknown error' }));
    return failure(500, 'Please try again later.');
  }
}
