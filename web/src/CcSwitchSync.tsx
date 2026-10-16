/*
 * The cloud-sync view: the whole cc-switch state, pushed to and restored from
 * one WebDAV remote.
 *
 * A snapshot is the entire database plus the skills tree — every app's
 * providers, prompts, MCP servers, skills and settings — so upload is the
 * backup direction and download is a full restore that overwrites what runs
 * here. Those two calls are the whole HTTP surface: whether WebDAV is
 * configured, when it last synced and what last failed are not readable over
 * HTTP, so this view reports the outcome of the action just taken and points
 * at the CLI for everything the API cannot say.
 */

import { useState } from "react";
import { CloudDownload, CloudUpload } from "lucide-react";
import {
  ccswitchWebdavDownload,
  ccswitchWebdavUpload,
  type CcSwitchSettings,
  type CcSwitchSyncResult,
} from "./ccswitch";

/** Keeps the two interesting 409 causes apart from everything else. */
function syncErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/not (yet )?configured/i.test(text)) {
    return `${text}。先在服务器上配置：cc-switch config webdav set（坚果云可用 jianguoyun 预设）。`;
  }
  if (/remote.*(empty|missing)/i.test(text)) {
    return `${text}。云端还没有可用的快照，先上传一次。`;
  }
  return text;
}

/** The server's decision word, as a short line the reader can act on. */
function decisionLine(result: CcSwitchSyncResult): string {
  switch (result.decision) {
    case "Upload":
      return "已上传：本机当前配置成为云端快照。";
    case "Download":
      return "已恢复：本机现在运行的是云端快照，渠道列表会重新读取。";
    case "V1MigrationNeeded":
      return "远端还是旧 V1 格式；再执行一次同步即可完成迁移。";
    default:
      return result.message?.trim() || "完成。";
  }
}

export function CcSwitchSync({
  settings,
  onChanged,
}: {
  settings: CcSwitchSettings;
  /** Bumped after a restore so the provider and prompt lists re-read. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"upload" | "download" | null>(null);
  const [result, setResult] = useState<CcSwitchSyncResult | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  const run = async (kind: "upload" | "download") => {
    if (busy) return;
    setBusy(kind);
    setError("");
    setResult(null);
    try {
      const outcome =
        kind === "upload" ? await ccswitchWebdavUpload(settings) : await ccswitchWebdavDownload(settings);
      setResult(outcome);
      setConfirming(false);
      if (kind === "download") onChanged();
    } catch (err) {
      setError(syncErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ccswitch__sync">
      <p className="ccswitch__hint">
        快照是整份 cc-switch 数据库加技能目录 —— 所有 app 的渠道、提示词、MCP、技能与设置。
        上传 = 备份到 WebDAV；恢复 = 用云端快照<b>整份覆盖本机</b>。
      </p>
      <p className="ccswitch__hint">
        接口读不到配置状态（是否启用、上次同步时间）；在服务器上用 <code>cc-switch config webdav show</code> 查看。
      </p>

      <div className="ccswitch__sync-actions">
        <button
          type="button"
          className="agent-primary-button"
          disabled={busy !== null}
          onClick={() => void run("upload")}
        >
          <CloudUpload size={14} aria-hidden="true" />
          {busy === "upload" ? "上传中…" : "上传到云端"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy !== null || confirming}
          onClick={() => setConfirming(true)}
        >
          <CloudDownload size={14} aria-hidden="true" />
          从云端恢复…
        </button>
      </div>

      {confirming ? (
        <div className="ccswitch__danger-zone" role="alertdialog" aria-label="确认恢复">
          <p className="ccswitch__hint">
            将用云端快照覆盖本机全部渠道、提示词、MCP、技能和设置，不可撤销，也没有预览可看。
            正在运行的 agent 要重启才会读到新配置。
          </p>
          <div className="ccswitch__sync-actions">
            <button type="button" className="ghost" onClick={() => setConfirming(false)} disabled={busy !== null}>
              取消
            </button>
            <button
              type="button"
              className="agent-danger-button"
              disabled={busy !== null}
              onClick={() => void run("download")}
            >
              {busy === "download" ? "恢复中…" : "确认覆盖本机"}
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <p className="ccswitch__note ok" role="status">
          {decisionLine(result)}
          {result.message ? <span className="ccswitch__sync-raw">{result.message}</span> : null}
        </p>
      ) : null}
      {error ? (
        <p className="ccswitch__note error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
