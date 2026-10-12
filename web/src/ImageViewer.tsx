/*
 * An image, full size, over the page.
 *
 * A screenshot is read for its detail, so the viewer has to do more than fit it
 * to the window: zoom in on the part being read, drag that part into view, and
 * get back to the whole picture with one gesture. Every image in the app opens
 * here — an attachment in a message, a staged upload, a file from the project
 * tree — so there is one place where that behaviour lives and one place to fix.
 *
 * The transform is kept as one piece of state rather than three, because zoom and
 * pan are computed together: a zoom has to move the image so that the point under
 * the pointer stays there, and reading two separate states would let a frame of
 * one land without the other.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

/** How far in and out the reader can go. */
const MIN_SCALE = 0.2;
const MAX_SCALE = 12;

/** One wheel notch, as a factor. Small enough that zooming feels continuous. */
const WHEEL_STEP = 400;

interface View {
  scale: number;
  x: number;
  y: number;
}

const RESET: View = { scale: 1, x: 0, y: 0 };

export function ImageViewer({
  url,
  alt = "",
  caption,
  onClose,
}: {
  /** What to draw. */
  url: string;
  alt?: string;
  /** A line under the controls, for the file's own name and size. */
  caption?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>(RESET);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  /** The pointer's position during a drag, and where the image was when it began. */
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /**
   * Zooms about a point on the screen, keeping what is under it in place.
   *
   * The image is centred in the window, so the point's offset from that centre is
   * what has to stay proportional: the same arithmetic as a map's pinch-to-zoom,
   * with the centre standing in for the map's anchor.
   */
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      if (scale === current.scale) return current;
      const ratio = scale / current.scale;
      const centreX = window.innerWidth / 2;
      const centreY = window.innerHeight / 2;
      return {
        scale,
        x: clientX - centreX - (clientX - centreX - current.x) * ratio,
        y: clientY - centreY - (clientY - centreY - current.y) * ratio,
      };
    });
  }, []);

  const zoomBy = (factor: number) => zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);

  /*
   * A native listener rather than React's `onWheel`: React registers wheel
   * handlers as passive, and a passive handler may not stop the page from
   * scrolling behind the image — which is what a wheel does by default.
   */
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY / WHEEL_STEP));
    };
    sheet.addEventListener("wheel", onWheel, { passive: false });
    return () => sheet.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Secondary buttons are not a drag; a right-click here is a context menu.
    if (event.button !== 0) return;
    /*
     * A press on the empty space beside the image dismisses it; a press on the
     * image starts a drag. One handler decides, so a drag that wanders off the
     * image keeps working and a tap beside it still closes.
     */
    if (!(event.target instanceof HTMLImageElement)) {
      onClose();
      return;
    }
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
    // Capture keeps the drag when the pointer leaves the image. It can fail — a
    // pointer that is already gone — and that is not worth abandoning the drag
    // over: without it the pan still works while the pointer stays on the image.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The drag continues uncaptured.
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    current.x = event.clientX;
    current.y = event.clientY;
    setView((value) => ({ ...value, x: value.x + dx, y: value.y + dy }));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Nothing left to release.
      }
    }
  };

  return (
    <div
      className={`image-viewer${dragging ? " dragging" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "图片预览"}
      ref={sheetRef}
    >
      <div
        className="image-viewer__stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget) return;
          setView((value) => (value.scale === 1 ? { scale: 2, x: value.x, y: value.y } : RESET));
        }}
      >
        <img
          src={url}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        />
      </div>

      <div className="image-viewer__controls">
        <button
          type="button"
          className="ghost"
          aria-label="缩小"
          title="缩小"
          onClick={() => zoomBy(1 / 1.4)}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <span className="image-viewer__scale">{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          className="ghost"
          aria-label="放大"
          title="放大"
          onClick={() => zoomBy(1.4)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ghost"
          aria-label="重置"
          title="重置（双击图片同效）"
          onClick={() => setView(RESET)}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </button>
        <button type="button" className="ghost" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {caption ? <p className="image-viewer__caption">{caption}</p> : null}
    </div>
  );
}
