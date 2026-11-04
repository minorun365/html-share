import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_SCOPE, cognitoApiEndpoint, passkeyAddUrl } from '../functions/auth-handler.ts';

test('login asks for the scope that can list passkeys', () => {
  assert.ok(LOGIN_SCOPE.split(' ').includes('aws.cognito.signin.user.admin'));
});

test('user pool API endpoint comes from the managed login domain', () => {
  assert.equal(
    cognitoApiEndpoint('https://example-prefix.auth.us-west-2.amazoncognito.com'),
    'https://cognito-idp.us-west-2.amazonaws.com/',
  );
  assert.throws(() => cognitoApiEndpoint('https://example.com'));
});

test('passkey registration page returns to the registered callback', () => {
  const url = new URL(passkeyAddUrl('https://p.auth.us-west-2.amazoncognito.com', 'client', 'https://share.example/auth/callback'));
  assert.equal(url.pathname, '/passkeys/add');
  assert.equal(url.searchParams.get('client_id'), 'client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://share.example/auth/callback');
});
