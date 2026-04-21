import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

interface ExportOptions {
  element: HTMLElement;
  filename: string;
}

async function captureCanvas(element: HTMLElement): Promise<HTMLCanvasElement> {
  const scrollContainers = element.querySelectorAll<HTMLElement>('*');
  const overrides: Array<{ el: HTMLElement; maxHeight: string; overflow: string }> = [];

  for (const el of scrollContainers) {
    const style = getComputedStyle(el);
    if (
      (style.overflow === 'auto' || style.overflow === 'scroll' ||
       style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      style.maxHeight !== 'none'
    ) {
      overrides.push({
        el,
        maxHeight: el.style.maxHeight,
        overflow: el.style.overflow,
      });
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
    }
  }

  try {
    return await html2canvas(element, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
  } finally {
    for (const { el, maxHeight, overflow } of overrides) {
      el.style.maxHeight = maxHeight;
      el.style.overflow = overflow;
    }
  }
}

export async function exportAsPng({ element, filename }: ExportOptions): Promise<void> {
  const canvas = await captureCanvas(element);
  const link = document.createElement('a');
  link.download = `${filename}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

export async function exportAsPdf({ element, filename }: ExportOptions): Promise<void> {
  const canvas = await captureCanvas(element);
  const pxWidth = canvas.width;
  const pxHeight = canvas.height;

  const pdfWidthMm = 210; // A4
  const pdfHeightMm = 297;
  const margin = 10;
  const contentWidthMm = pdfWidthMm - margin * 2;
  const contentHeightMm = pdfHeightMm - margin * 2;

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
    ctx.drawImage(canvas, 0, srcY, pxWidth, srcH, 0, 0, pxWidth, srcH);

    const sliceData = sliceCanvas.toDataURL('image/png');
    pdf.addImage(sliceData, 'PNG', margin, margin, contentWidthMm, sliceHeightMm);

    yOffsetMm += contentHeightMm;
    page++;
  }

  pdf.save(`${filename}.pdf`);
}
