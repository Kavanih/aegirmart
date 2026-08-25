import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Tone = "info" | "success" | "error" | "pending";
type Toast = { id: number; tone: Tone; message: string; href?: string };

type Api = {
  push: (tone: Tone, message: string, href?: string) => number;
  update: (id: number, tone: Tone, message: string, href?: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<Api | null>(null);

// Hand rolled rather than react-toastify: it is small, inherits the palette,
// and keeps a transaction's pending toast addressable so it can be updated.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, message: string, href?: string) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      setToasts((list) => [...list, { id, tone, message, href }]);
      if (tone !== "pending") window.setTimeout(() => dismiss(id), 6000);
      return id;
    },
    [dismiss],
  );

  const update = useCallback(
    (id: number, tone: Tone, message: string, href?: string) => {
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, tone, message, href } : t)));
      if (tone !== "pending") window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role="status">
            {t.tone === "pending" && <span className="toast-spin" aria-hidden="true" />}
            <span className="toast-msg">{t.message}</span>
            {t.href && (
              <a className="toast-link" href={t.href} target="_blank" rel="noreferrer noopener">
                View
              </a>
            )}
            <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              Close
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Api {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
