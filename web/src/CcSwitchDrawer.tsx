/*
 * The side drawer the cc-switch page edits in: the list stays where it is, and
 * creating or editing something happens beside it rather than in place, so the
 * thing being edited keeps its context.
 *
 * Closing is armed when there are unsaved changes: the first Escape, backdrop
 * tap, or ✕ explains that, and only the second one actually drops the work.
 */

import { useEffect, type ReactNode } from "react";

export function CcSwitchDrawer({
  title,
  onClose,
  armed = false,
  onDismissArmed,
  children,
}: {
  title: string;
  onClose: () => void;
  /** True when the form inside has changes a close would drop. */
  armed: boolean;
  onDismissArmed: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="ccswitch__drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="ccswitch__drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="ccswitch__drawer-head">
          <h3 className="ccswitch__drawer-title">{title}</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭" title="关闭">
            ✕
          </button>
        </header>
        {armed ? (
          <p className="ccswitch__note error ccswitch__drawer-armed" role="alert">
            有未保存的修改，再关闭一次将丢弃。
            <button type="button" className="ghost" onClick={onDismissArmed}>
              继续编辑
            </button>
          </p>
        ) : null}
        <div className="ccswitch__drawer-body">{children}</div>
      </aside>
    </>
  );
}
