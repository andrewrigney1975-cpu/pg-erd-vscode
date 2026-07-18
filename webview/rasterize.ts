/**
 * Rasterizes an SVG string to a PNG data URL via the browser's own Canvas/Image APIs --
 * the webview already runs in a full Chromium context, so this needs no extra rasterization
 * dependency (avoids pulling in a native-binary image library just for "Export as PNG").
 */
/** Chromium's practical per-dimension canvas limit; exceeding it silently yields a blank canvas. */
const MAX_CANVAS_DIMENSION = 16384;

export async function rasterizeSvgToPngDataUrl(
  svgString: string,
  width: number,
  height: number,
  scale: number
): Promise<string> {
  const targetWidth = Math.round(width * scale);
  const targetHeight = Math.round(height * scale);
  if (targetWidth > MAX_CANVAS_DIMENSION || targetHeight > MAX_CANVAS_DIMENSION) {
    throw new Error(
      `Diagram is too large to export at ${scale}x (would be ${targetWidth}x${targetHeight}px, ` +
        `limit is ${MAX_CANVAS_DIMENSION}px per side). Try "Export SVG" instead, or collapse some schemas first.`
    );
  }

  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context is unavailable in this webview');
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to rasterize the diagram (image failed to load)'));
    image.src = url;
  });
}
