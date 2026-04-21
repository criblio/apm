import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';

interface ExportOptions {
  element: HTMLElement;
  filename: string;
}

function expandScrollContainers(element: HTMLElement): Array<{ el: HTMLElement; maxHeight: string; overflow: string }> {
  const overrides: Array<{ el: HTMLElement; maxHeight: string; overflow: string }> = [];
  for (const el of element.querySelectorAll<HTMLElement>('*')) {
    const style = getComputedStyle(el);
    if (
      (style.overflow === 'auto' || style.overflow === 'scroll' ||
       style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      style.maxHeight !== 'none'
    ) {
      overrides.push({ el, maxHeight: el.style.maxHeight, overflow: el.style.overflow });
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
    }
  }
  return overrides;
}

function restoreScrollContainers(overrides: Array<{ el: HTMLElement; maxHeight: string; overflow: string }>) {
  for (const { el, maxHeight, overflow } of overrides) {
    el.style.maxHeight = maxHeight;
    el.style.overflow = overflow;
  }
}

async function captureDataUrl(element: HTMLElement): Promise<string> {
  const overrides = expandScrollContainers(element);
  try {
    return await toPng(element, {
      backgroundColor: '#ffffff',
      pixelRatio: 2,
      filter: (node: HTMLElement) => {
        if (node.tagName === 'IFRAME') return false;
        return true;
      },
    });
  } finally {
    restoreScrollContainers(overrides);
  }
}

export async function exportAsPng({ element, filename }: ExportOptions): Promise<void> {
  const dataUrl = await captureDataUrl(element);
  const link = document.createElement('a');
  link.download = `${filename}.png`;
  link.href = dataUrl;
  link.click();
}

export async function exportAsPdf({ element, filename }: ExportOptions): Promise<void> {
  const dataUrl = await captureDataUrl(element);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  const pxWidth = img.naturalWidth;
  const pxHeight = img.naturalHeight;

  const pdfWidthMm = 210; // A4
  const margin = 10;
  const contentWidthMm = pdfWidthMm - margin * 2;
  const contentHeightMm = 297 - margin * 2;

  const imgAspect = pxHeight / pxWidth;
  const totalImgHeightMm = contentWidthMm * imgAspect;

  const pdf = new jsPDF('p', 'mm', 'a4');
  let yOffsetMm = 0;
  let page = 0;

  while (yOffsetMm < totalImgHeightMm) {
    if (page > 0) pdf.addPage();

    const sliceHeightMm = Math.min(contentHeightMm, totalImgHeightMm - yOffsetMm);
    const srcY = (yOffsetMm / totalImgHeightMm) * pxHeight;
    const srcH = (sliceHeightMm / totalImgHeightMm) * pxHeight;

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = pxWidth;
    sliceCanvas.height = Math.ceil(srcH);
    const ctx = sliceCanvas.getContext('2d')!;
    ctx.drawImage(img, 0, srcY, pxWidth, srcH, 0, 0, pxWidth, Math.ceil(srcH));

    const sliceData = sliceCanvas.toDataURL('image/png');
    pdf.addImage(sliceData, 'PNG', margin, margin, contentWidthMm, sliceHeightMm);

    yOffsetMm += contentHeightMm;
    page++;
  }

  pdf.save(`${filename}.pdf`);
}
