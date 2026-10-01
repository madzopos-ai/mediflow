/**
 * Patient quick check-in codes.
 *
 * The QR payload is a namespaced patient id (`MF1:<id>`) and nothing else: no
 * name, phone, MRN or diagnosis. A patient waving this at the front desk should
 * not hand over their record to whoever happens to photograph the code, and the
 * read still resolves only inside the signed-in clinic's own Firestore scope, so
 * a leaked code yields nothing to an outsider.
 *
 * Encoding is local (jsqr renders, browser canvas decodes) with no third-party
 * QR service in the path, matching the offline-first posture of the rest of the
 * app. Patient ids are random rather than sequential, so a guessed code cannot
 * walk the list.
 */

import jsQR from 'jsqr';

const PREFIX = 'MF1:';

/** Encodes one patient id into the scan payload. */
export function patientQrPayload(patientId: string): string {
  return `${PREFIX}${patientId}`;
}

/**
 * Reads a scan result back to a patient id, or null when the text is not one of
 * ours. Tolerates whitespace and a full URL, since some scanners return the
 * page URL they were shown rather than the raw string.
 */
export function parsePatientQr(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const fromUrl = text.includes('/') ? (text.split('q=')[1] ?? text) : text;
  const decoded = (() => {
    try {
      return decodeURIComponent(fromUrl);
    } catch {
      return fromUrl;
    }
  })();

  const at = decoded.indexOf(PREFIX);
  if (at < 0) return null;
  const id = decoded.slice(at + PREFIX.length).split(/[\s&#/]+/u)[0] ?? '';
  // Patient ids are Firestore push ids: 20 lowercase alphanumerics.
  return /^[A-Za-z0-9_-]{6,64}$/u.test(id) ? id : null;
}

/**
 * Decodes a QR from image pixels.
 *
 * jsqr needs the raw RGBA buffer, so the image is drawn to a canvas first. A
 * failed decode returns null rather than throwing: "no code in this photo" is a
 * normal outcome when the shot is blurry, not an error worth surfacing.
 */
export async function decodeQrFromImage(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const found = jsQR(image.data, image.width, image.height, {
      // The payload is a short high-contrast string; the extra effort is cheap
      // and it rescues codes photographed at an angle.
      inversionAttempts: 'dontInvert',
    });
    return found?.data ?? null;
  } finally {
    bitmap.close();
  }
}
