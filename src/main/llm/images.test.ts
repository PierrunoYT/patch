import { describe, expect, it } from 'vitest';
import { checkUserImages, MAX_TOTAL_IMAGE_BASE64, sniffImageType, withoutImages } from './images';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a\0\0\0\0').toString('base64');
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1').toString('base64');

describe('sniffImageType', () => {
  it('names the four image types by their first bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses anything else', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))).toBeNull();
    expect(sniffImageType('AAAA')).toBeNull();
    expect(sniffImageType('')).toBeNull();
  });
});

describe('checkUserImages (#240)', () => {
  it('corrects a media type that does not match the bytes', () => {
    const [image] = checkUserImages([{ mediaType: 'image/png', base64: JPEG }]);
    expect(image!.mediaType).toBe('image/jpeg');
  });

  it('turns down a file that is not an image, and images that are too large together', () => {
    expect(() =>
      checkUserImages([
        { mediaType: 'image/png', base64: PNG },
        { mediaType: 'image/png', base64: 'AAAA' },
      ]),
    ).toThrow('Attached image 2 is not');
    const big = PNG + 'A'.repeat(MAX_TOTAL_IMAGE_BASE64 / 2);
    expect(() =>
      checkUserImages([
        { mediaType: 'image/png', base64: big },
        { mediaType: 'image/png', base64: big },
      ]),
    ).toThrow('too large');
  });
});

describe('withoutImages', () => {
  it('replaces tool-result images with a line of text and leaves other results alone', () => {
    const out = withoutImages([
      { id: 'a', content: 'screenshot taken', images: [{ mediaType: 'image/png', base64: PNG }] },
      { id: 'b', content: 'plain' },
    ]);
    expect(out[0]).not.toHaveProperty('images');
    expect(out[0]!.content).toContain('1 image(s) not shown');
    expect(out[1]).toEqual({ id: 'b', content: 'plain' });
  });
});
