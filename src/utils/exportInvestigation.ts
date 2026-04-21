interface ExportOptions {
  element: HTMLElement;
  filename: string;
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

export async function exportAsPng({ element, filename }: ExportOptions): Promise<void> {
  const saved = expandScrollContainers(element);

  const width = element.scrollWidth;
  const height = element.scrollHeight;

  const clone = element.cloneNode(true) as HTMLElement;
  inlineStyles(element, clone);

  // Remove any iframe elements from the clone
  for (const iframe of clone.querySelectorAll('iframe')) {
    iframe.remove();
  }

  restoreScrollContainers(saved);

  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.position = 'static';
  clone.style.overflow = 'visible';
  clone.style.maxHeight = 'none';

  const xmlns = 'http://www.w3.org/1999/xhtml';
  const serializer = new XMLSerializer();
  const html = serializer.serializeToString(clone);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <foreignObject width="100%" height="100%">
      <div xmlns="${xmlns}">${html}</div>
    </foreignObject>
  </svg>`;

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const img = new Image();
  const scale = 2;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      const pngDataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.download = `${filename}.png`;
      a.href = pngDataUrl;
      a.click();
      resolve();
    };
    img.onerror = () => {
      reject(new Error('Failed to render SVG to image'));
    };
    img.src = dataUrl;
  });
}
