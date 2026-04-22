interface ExportOptions {
  element: HTMLElement;
}

function inlineStyles(source: HTMLElement, target: HTMLElement) {
  const computed = getComputedStyle(source);
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    target.style.setProperty(prop, computed.getPropertyValue(prop));
  }

  const sourceChildren = source.children;
  const targetChildren = target.children;
  for (let i = 0; i < sourceChildren.length; i++) {
    if (sourceChildren[i] instanceof HTMLElement && targetChildren[i] instanceof HTMLElement) {
      inlineStyles(sourceChildren[i] as HTMLElement, targetChildren[i] as HTMLElement);
    }
  }
}

function expandScrollContainers(element: HTMLElement): Array<{ el: HTMLElement; mh: string; ov: string }> {
  const saved: Array<{ el: HTMLElement; mh: string; ov: string }> = [];
  for (const el of element.querySelectorAll<HTMLElement>('*')) {
    const s = getComputedStyle(el);
    if (
      (s.overflow === 'auto' || s.overflow === 'scroll' ||
       s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      s.maxHeight !== 'none'
    ) {
      saved.push({ el, mh: el.style.maxHeight, ov: el.style.overflow });
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
    }
  }
  return saved;
}

function restoreScrollContainers(saved: Array<{ el: HTMLElement; mh: string; ov: string }>) {
  for (const { el, mh, ov } of saved) {
    el.style.maxHeight = mh;
    el.style.overflow = ov;
  }
}

const PADDING = 32;
const BG_COLOR = '#ffffff';

export async function exportAsPng({ element }: ExportOptions): Promise<string> {
  const saved = expandScrollContainers(element);

  const innerWidth = element.scrollWidth;
  const innerHeight = element.scrollHeight;

  const clone = element.cloneNode(true) as HTMLElement;
  inlineStyles(element, clone);

  for (const iframe of clone.querySelectorAll('iframe')) {
    iframe.remove();
  }

  restoreScrollContainers(saved);

  // Use CSS padding on a wrapper instead of SVG foreignObject offset
  // so the right margin actually renders.
  const totalWidth = innerWidth + PADDING * 2;
  const totalHeight = innerHeight + PADDING * 2;

  clone.style.position = 'static';
  clone.style.overflow = 'visible';
  clone.style.maxHeight = 'none';
  clone.style.background = 'transparent';
  clone.style.margin = '0';
  clone.style.width = `${innerWidth}px`;

  const xmlns = 'http://www.w3.org/1999/xhtml';
  const serializer = new XMLSerializer();
  const html = serializer.serializeToString(clone);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}">
    <rect width="100%" height="100%" fill="${BG_COLOR}"/>
    <foreignObject width="${totalWidth}" height="${totalHeight}">
      <div xmlns="${xmlns}" style="background:${BG_COLOR};padding:${PADDING}px;box-sizing:border-box;width:${totalWidth}px;">${html}</div>
    </foreignObject>
  </svg>`;

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const img = new Image();
  const scale = 2;
  const pngDataUrl = await new Promise<string>((resolve, reject) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = totalWidth * scale;
      canvas.height = totalHeight * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to render SVG to image'));
    img.src = dataUrl;
  });

  return pngDataUrl;
}
