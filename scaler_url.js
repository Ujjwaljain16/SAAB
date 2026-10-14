export function normalizeScalerUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  const full = trimmed.startsWith('http')
    ? trimmed
    : `https://www.scaler.com${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;

  try {
    const parsed = new URL(full);
    if (parsed.hostname === 'scaler.com') {
      parsed.hostname = 'www.scaler.com';
    }
    return parsed.toString();
  } catch {
    return full;
  }
}