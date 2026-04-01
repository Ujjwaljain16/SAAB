export function normalizeScalerUrl(url) {
  const parsed = new URL(url);

  if (parsed.hostname === 'scaler.com') {
    parsed.hostname = 'www.scaler.com';
  }

  return parsed.toString();
}