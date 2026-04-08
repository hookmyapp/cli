export interface FakeJwtClaims {
  role: 'admin' | 'member';
  orgId: string;
  sub?: string;
  exp?: number;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function buildFakeJwt(claims: FakeJwtClaims): string {
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    role: claims.role,
    org_id: claims.orgId,
    sub: claims.sub ?? 'user_test',
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.test`;
}
