export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Drives pan/zoom/reset purely through the live SVG's viewBox attribute. */
export class PanZoomController {
  private viewBox: ViewBox;
  private baseViewBox: ViewBox;
  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private panStartViewBox: ViewBox = { x: 0, y: 0, width: 0, height: 0 };
  private panScale = 1;
  private animationFrameId: number | null = null;
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

  getBaseViewBox(): ViewBox {
    return { ...this.baseViewBox };
  }

  reset(): void {
    this.stopAnimation();
    this.viewBox = { ...this.baseViewBox };
    this.applyViewBox();
  }

  /**
   * Smoothly eases the viewBox to `target` over `durationMs` (ease-out cubic) -- used by
   * main.ts's click-to-highlight to fit-to-view the highlighted elements, and to animate back to
   * the default fit-all view when a highlight is cleared. Deliberately bypasses `onChange`/layout
   * persistence on every frame (and even on settling) -- this is a transient "where you're
   * currently looking because of a highlight" state, not a deliberate repositioning the user did
   * that should be remembered as the diagram's saved default view next time it's reopened.
   */
  animateTo(target: ViewBox, durationMs: number, onComplete?: () => void): void {
    this.stopAnimation();
    const start = { ...this.viewBox };
    const startTime = now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (): void => {
      const t = Math.min(1, (now() - startTime) / durationMs);
      const e = ease(t);
      this.viewBox = {
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
        width: start.width + (target.width - start.width) * e,
        height: start.height + (target.height - start.height) * e,
      };
      this.applyViewBoxSilently();
      if (t < 1) {
        this.animationFrameId = requestAnimationFrame(step);
      } else {
        this.animationFrameId = null;
        onComplete?.();
      }
    };
    this.animationFrameId = requestAnimationFrame(step);
  }

  private stopAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
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

  /** Same as applyViewBox() but skips the onChange/persistence callback -- see animateTo()'s doc comment. */
  private applyViewBoxSilently(): void {
    const { x, y, width, height } = this.viewBox;
    this.svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
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
