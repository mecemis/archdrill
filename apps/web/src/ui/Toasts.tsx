import { X } from "lucide-react";
import { useToasts } from "../state/toasts";

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-md px-3 py-2 text-sm shadow-lg ${
            toast.tone === "error" ? "bg-bad text-on-accent" : "bg-inverse text-on-inverse"
          }`}
        >
          <span className="flex-1">{toast.message}</span>
          <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
