/*
 * One provider, read-only: what it points at, and the two ways to change it.
 *
 * The whole settings document is shown because no two apps keep provider
 * settings the same way — a per-app rendering would only be correct for the apps
 * herdr has been taught. Secrets arrive masked as `***`; nothing here can unmask
 * them, and the editor refuses to save that mask back.
 */

import { Pencil, Trash2 } from "lucide-react";
import type { CcSwitchProviderDetail } from "./ccswitch";
import { settingsSummary } from "./providerSummary";

export function CcSwitchProviderDetailView({
  detail,
  confirming,
  busy,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  detail: CcSwitchProviderDetail;
  /** True once delete was pressed: the second press is the confirmation. */
  confirming: boolean;
  busy: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  return (
    <div className="ccswitch__detail">
      <div className="ccswitch__detail-head">
        <span className="ccswitch__name">{detail.name}</span>
        <span className="ccswitch__id">{detail.id}</span>
        {detail.website_url ? (
          <a href={detail.website_url} target="_blank" rel="noopener noreferrer">
            站点
          </a>
        ) : null}
      </div>

      <dl className="ccswitch__facts">
        {settingsSummary(detail).map(([label, value]) => (
          <div key={label} className="ccswitch__fact">
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>

      <pre className="ccswitch__json">{JSON.stringify(detail.settingsConfig ?? {}, null, 2)}</pre>
      <p className="ccswitch__hint">
        密钥在这里显示为 <code>***</code>（cc-switch 的掩码）。修改配置时若留着它，真实密钥会被覆盖，所以编辑器会拦住。
      </p>

      <div className="ccswitch__detail-actions">
        {confirming ? (
          <>
            <span className="ccswitch__hint">删除后无法恢复（正在使用的渠道 cc-switch 会拒绝删除）。</span>
            <button type="button" className="ghost" onClick={onCancelDelete} disabled={busy}>
              取消
            </button>
            <button type="button" className="agent-danger-button" onClick={onConfirmDelete} disabled={busy}>
              {busy ? "删除中…" : "确认删除"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost" onClick={onEdit} disabled={busy}>
              <Pencil size={13} aria-hidden="true" /> 编辑
            </button>
            <button type="button" className="ghost" onClick={onRequestDelete} disabled={busy}>
              <Trash2 size={13} aria-hidden="true" /> 删除
            </button>
          </>
        )}
      </div>
    </div>
  );
}
