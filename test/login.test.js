import test from 'node:test';
import assert from 'node:assert/strict';
import { isGoogleUrl, isScalerUrl, isLoginUrl, buildAccountSelector } from '../scaler_login.js';

test('isGoogleUrl covers regional Google domains (the SetSID hop)', () => {
  assert.equal(isGoogleUrl('https://accounts.google.com/v3/signin/identifier'), true);
  assert.equal(isGoogleUrl('https://accounts.google.co.in/accounts/SetSID'), true);
  assert.equal(isGoogleUrl('https://www.scaler.com/users/auth/google_oauth2/callback'), false);
  assert.equal(isGoogleUrl('https://evil.example/?next=accounts.google.com'), false);
  assert.equal(isGoogleUrl('not a url'), false);
});

test('isScalerUrl compares the host, not the whole string', () => {
  assert.equal(isScalerUrl('https://www.scaler.com/academy/x'), true);
  assert.equal(isScalerUrl('https://scaler.com/'), true);
  // Regression: Google's sign-in URL carries scaler.com in its redirect_uri and was mistaken for "back on Scaler".
  assert.equal(isScalerUrl('https://accounts.google.com/v3/signin/identifier?redirect_uri=https%3A%2F%2Fwww.scaler.com%2Fusers%2Fauth%2Fgoogle_oauth2%2Fcallback'), false);
  assert.equal(isScalerUrl('https://notscaler.com/'), false);
  assert.equal(isScalerUrl('https://scaler.com.evil.example/'), false);
});

test('isLoginUrl', () => {
  assert.equal(isLoginUrl('https://www.scaler.com/users/sign_in/'), true);
  assert.equal(isLoginUrl('https://www.scaler.com/login'), true);
  assert.equal(isLoginUrl('https://www.scaler.com/academy/mentee-dashboard/core-curriculum/'), false);
  assert.equal(isLoginUrl(''), false);
});

test('buildAccountSelector escapes quotes and backslashes', () => {
  assert.equal(buildAccountSelector('a@b.com'), '[data-identifier="a@b.com" i], [data-email="a@b.com" i]');
  assert.ok(buildAccountSelector('we"ird@x.com').includes('we\\"ird@x.com'));
  assert.ok(!buildAccountSelector('a@b.com').includes('has-text'));
});
