export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Drives pan/zoom/reset purely through the live SVG's viewBox attribute. */
export class PanZoomController {
  private viewBox: ViewBox;
  private baseViewBox: ViewBox;
  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private panStartViewBox: ViewBox = { x: 0, y: 0, width: 0, height: 0 };
  private panScale = 1;
  suspended = false;

  constructor(
    private readonly svg: SVGSVGElement,
    initial: ViewBox,
    private readonly onChange?: (vb: ViewBox) => void
  ) {
    this.viewBox = { ...initial };
    this.baseViewBox = { ...initial };
    this.applyViewBox();
    this.attachHandlers();
  }

  setBaseViewBox(vb: ViewBox, resetView: boolean): void {
    this.baseViewBox = { ...vb };
    if (resetView) {
      this.viewBox = { ...vb };
      this.applyViewBox();
    }
  }

  reset(): void {
    this.viewBox = { ...this.baseViewBox };
    this.applyViewBox();
  }

  zoomAt(clientX: number, clientY: number, factor: number): void {
    const pt = this.screenToSvgPoint(clientX, clientY);
    const minWidth = this.baseViewBox.width * 0.08;
    const maxWidth = this.baseViewBox.width * 8;
    const newWidth = clamp(this.viewBox.width * factor, minWidth, maxWidth);
    const actualFactor = newWidth / this.viewBox.width;
    const newHeight = this.viewBox.height * actualFactor;
    const newX = pt.x - (pt.x - this.viewBox.x) * actualFactor;
    const newY = pt.y - (pt.y - this.viewBox.y) * actualFactor;
    this.viewBox = { x: newX, y: newY, width: newWidth, height: newHeight };
    this.applyViewBox();
  }

  zoomAtCenter(factor: number): void {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  screenToSvgPoint(clientX: number, clientY: number): { x: number; y: number } {
    const pt = this.svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = this.svg.getScreenCTM();
    if (!ctm) {
      return { x: 0, y: 0 };
    }
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  getViewBox(): ViewBox {
    return { ...this.viewBox };
  }

  private applyViewBox(): void {
    const { x, y, width, height } = this.viewBox;
    this.svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    this.onChange?.(this.getViewBox());
  }

  private attachHandlers(): void {
    this.svg.addEventListener('wheel', (e) => {
      if (this.suspended) {
        return;
      }
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    this.svg.addEventListener('pointerdown', (e) => {
      if (this.suspended) {
        return;
      }
      const target = e.target as Element;
      if (target.closest('.pgerd-table-header') || target.closest('.pgerd-group-header')) {
        return;
      }
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY };
      this.panStartViewBox = { ...this.viewBox };
      const rect = this.svg.getBoundingClientRect();
      this.panScale = this.viewBox.width / rect.width;
      this.svg.setPointerCapture(e.pointerId);
      this.svg.style.cursor = 'grabbing';
    });

    this.svg.addEventListener('pointermove', (e) => {
      if (!this.isPanning) {
        return;
      }
      const dx = (e.clientX - this.panStart.x) * this.panScale;
      const dy = (e.clientY - this.panStart.y) * this.panScale;
      this.viewBox = {
        ...this.viewBox,
        x: this.panStartViewBox.x - dx,
        y: this.panStartViewBox.y - dy,
      };
      this.applyViewBox();
    });

    const endPan = (e: PointerEvent) => {
      if (this.isPanning) {
        this.isPanning = false;
        this.svg.style.cursor = '';
        try {
          this.svg.releasePointerCapture(e.pointerId);
        } catch {
          // pointer capture may already be released
        }
      }
    };
    this.svg.addEventListener('pointerup', endPan);
    this.svg.addEventListener('pointercancel', endPan);
  }
}
