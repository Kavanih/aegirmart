import { useCallback, useEffect, useRef, useState } from "react";

export type Direction = "up" | "down" | "skip";

const COMMIT_DISTANCE = 110;
const COMMIT_VELOCITY = 0.6;
const SKIP_DISTANCE = 130;
const ROTATION_PER_PX = 0.05;
const MAX_ROTATION = 14;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export type SwipeState = {
  dx: number;
  dy: number;
  rotation: number;
  dragging: boolean;
  intent: Direction | null;
  progress: number;
  leaving: Direction | null;
};

const IDLE: SwipeState = { dx: 0, dy: 0, rotation: 0, dragging: false, intent: null, progress: 0, leaving: null };

export function useSwipe(onCommit: (direction: Direction) => void, enabled: boolean) {
  const [state, setState] = useState<SwipeState>(IDLE);
  const origin = useRef<{ x: number; y: number; t: number } | null>(null);
  const reduced = useReducedMotion();

  // Distance and velocity both commit, so a short flick works like a long drag.
  const settle = useCallback(
    (dx: number, dy: number, elapsed: number) => {
      const vx = Math.abs(dx) / Math.max(elapsed, 1);
      const vy = Math.abs(dy) / Math.max(elapsed, 1);

      if (-dy > SKIP_DISTANCE || (-dy > 40 && vy > COMMIT_VELOCITY && Math.abs(dy) > Math.abs(dx))) {
        setState({ ...IDLE, leaving: "skip" });
        onCommit("skip");
        return;
      }
      if (Math.abs(dx) > COMMIT_DISTANCE || vx > COMMIT_VELOCITY) {
        const direction: Direction = dx > 0 ? "up" : "down";
        setState({ ...IDLE, leaving: direction });
        onCommit(direction);
        return;
      }
      setState(IDLE);
    },
    [onCommit],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      origin.current = { x: e.clientX, y: e.clientY, t: performance.now() };
      setState({ ...IDLE, dragging: true });
    },
    [enabled],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const start = origin.current;
    if (!start) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const vertical = -dy > Math.abs(dx) && -dy > 30;

    const intent: Direction | null = vertical ? "skip" : Math.abs(dx) > 12 ? (dx > 0 ? "up" : "down") : null;
    const reference = vertical ? -dy / SKIP_DISTANCE : Math.abs(dx) / COMMIT_DISTANCE;

    setState({
      dx,
      dy,
      rotation: Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, dx * ROTATION_PER_PX)),
      dragging: true,
      intent,
      progress: Math.min(1, Math.max(0, reference)),
      leaving: null,
    });
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const start = origin.current;
      if (!start) return;
      origin.current = null;
      settle(e.clientX - start.x, e.clientY - start.y, performance.now() - start.t);
    },
    [settle],
  );

  // Keyboard parity. Arrow keys drive the same commit path as a drag.
  const commitByKey = useCallback(
    (direction: Direction) => {
      if (!enabled) return;
      setState({ ...IDLE, leaving: direction });
      onCommit(direction);
    },
    [enabled, onCommit],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); commitByKey("up"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); commitByKey("down"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); commitByKey("skip"); }
    },
    [commitByKey],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return {
    state,
    reduced,
    reset,
    commitByKey,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown },
  };
}
