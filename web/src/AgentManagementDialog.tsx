import * as Dialog from "@radix-ui/react-dialog";
import { Bot, X } from "lucide-react";
import { useRef, type ReactNode } from "react";

export function AgentManagementDialog({ title, description, busy, onClose, children }: {
  title: string; description?: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const returnFocus = useRef(document.activeElement);
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="agent-dialog-overlay" />
      <Dialog.Content className="agent-management-dialog"
        {...(!description ? { "aria-describedby": undefined } : {})}
        onEscapeKeyDown={event => {
          if (busy || document.activeElement?.matches('input[role="combobox"][aria-expanded="true"]')) event.preventDefault();
        }}
        onPointerDownOutside={event => event.preventDefault()}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus();
        }}>
        <header className="tw:flex tw:items-start tw:gap-3">
          <span className="agent-dialog-symbol"><Bot size={22} /></span>
          <div className="tw:min-w-0 tw:flex-1"><Dialog.Title>{title}</Dialog.Title>
            {description ? <Dialog.Description>{description}</Dialog.Description> : null}</div>
          <Dialog.Close className="agent-icon-button" disabled={busy} aria-label="关闭弹窗"><X size={18} /></Dialog.Close>
        </header>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
