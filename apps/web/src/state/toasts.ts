import { create } from "zustand";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "info" | "error";
}

interface ToastState {
  readonly toasts: readonly Toast[];
  notify: (message: string, tone?: Toast["tone"]) => void;
  dismiss: (id: number) => void;
}

const TOAST_LIFETIME_MS = 5000;
let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  notify(message, tone = "info") {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, tone }] });
    setTimeout(() => get().dismiss(id), TOAST_LIFETIME_MS);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
