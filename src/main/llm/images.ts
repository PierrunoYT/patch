import type { ImageData, ToolResult } from './types';

// The API refuses a request over 32 MB, and the base64 text of the images is most of it. A message whose images add
// up to more than this is turned down before it is sent, so it never reaches the history (#240).
export const MAX_TOTAL_IMAGE_BASE64 = 25_000_000;

// The type of an image from its first bytes, or null when they are none of the four types the APIs take. The media
// type that came with the image (from a file extension or the browser) can be wrong, and a mismatch is a 400.
export function sniffImageType(base64: string): ImageData['mediaType'] | null {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

// Checks the images of a user message and gives each its real media type. Throws a message for the user when one is
// not an image the APIs take or when together they are too large.
export function checkUserImages(images: ImageData[]): ImageData[] {
  const total = images.reduce((sum, image) => sum + image.base64.length, 0);
  if (total > MAX_TOTAL_IMAGE_BASE64) {
    throw new Error(
      'The attached images are too large to send together (about 18 MB). Attach fewer or smaller images.',
    );
  }
  return images.map((image, index) => {
    const mediaType = sniffImageType(image.base64);
    if (!mediaType) throw new Error(`Attached image ${index + 1} is not a PNG, JPEG, GIF or WebP image.`);
    return { ...image, mediaType };
  });
}

// For a model that takes no images: the images of tool results (a screenshot, an MCP image) become a line of text, so
// the request is not refused and the chat does not break on it (#240).
export function withoutImages(results: ToolResult[]): ToolResult[] {
  return results.map(({ images, ...result }) =>
    images?.length
      ? {
          ...result,
          content: `${result.content}\n\n(${images.length} image(s) not shown: this model does not accept images)`,
        }
      : result,
  );
}
