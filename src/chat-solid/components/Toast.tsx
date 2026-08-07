import { type JSX } from "solid-js";
import { Toaster, toast as sonnerToast } from "solid-sonner";

export function ToastContainer(): JSX.Element {
  return <Toaster position="bottom-right" toastOptions={{ class: "peyt-toast", duration: 4000 }} />;
}

export const toaster = {
  show(render: (p: { toastId: number | string }) => JSX.Element, opts?: { persistent?: boolean }): string | number {
    return sonnerToast.custom((id) => render({ toastId: id }), {
      duration: opts?.persistent ? Infinity : 4000,
      className: "peyt-toast",
      unstyled: true,
    });
  },
  dismiss(id: string | number): void {
    sonnerToast.dismiss(id);
  },
};
