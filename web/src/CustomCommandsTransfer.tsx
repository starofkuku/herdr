import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Download, Upload } from "lucide-react";

import {
  MAX_COMMAND_BACKUP_BYTES,
  parseCustomCommandsBackup,
  serializeCustomCommands,
  type CustomCommand,
} from "./customCommands";
import "./customCommandsTransfer.css";

export interface CommandTransferFeedback {
  text: string;
  error?: boolean;
}

interface TransferProps {
  commands: readonly CustomCommand[];
  onImport: (commands: CustomCommand[]) => void;
  onFeedback: (feedback: CommandTransferFeedback) => void;
}

function downloadCommands(commands: readonly CustomCommand[]): void {
  const blob = new Blob([serializeCustomCommands(commands)], { type: "application/json;charset=utf-8" });
  if (blob.size > MAX_COMMAND_BACKUP_BYTES) throw new Error("命令文件超过 5 MB，无法导出。");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `herdr-custom-commands-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function useCommandTransfer({ commands, onImport, onFeedback }: TransferProps) {
  const [reading, setReading] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const reportError = (err: unknown) => onFeedback({
    error: true,
    text: err instanceof Error ? err.message : "操作失败，请重试。",
  });
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || reading) return;
    setReading(true);
    try {
      if (file.size > MAX_COMMAND_BACKUP_BYTES) throw new Error("请选择不超过 5 MB 的命令文件。");
      const text = await file.text();
      if (active.current) onImport(parseCustomCommandsBackup(text));
    } catch (err) {
      if (active.current) reportError(err);
    } finally {
      if (active.current) setReading(false);
    }
  };
  const exportFile = () => {
    try {
      downloadCommands(commands);
      onFeedback({ text: `已导出 ${commands.length} 条命令。` });
    } catch (err) {
      reportError(err);
    }
  };
  return { reading, importFile, exportFile };
}

/** File transfer stays in the browser, alongside the existing command storage. */
export function CustomCommandsTransfer(props: TransferProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const { reading, importFile, exportFile } = useCommandTransfer(props);
  return (
    <div className="command-transfer">
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={importFile} />
      <button
        type="button"
        className="ghost command-transfer__button"
        disabled={reading}
        onClick={() => input.current?.click()}
        title="导入快捷命令；同名命令保留现有内容"
      >
        <Upload size={15} aria-hidden="true" />{reading ? "导入中…" : "导入"}
      </button>
      <button
        type="button"
        className="ghost command-transfer__button"
        disabled={reading || props.commands.length === 0}
        onClick={exportFile}
        title="导出全部快捷命令为 JSON 文件"
      >
        <Download size={15} aria-hidden="true" />导出
      </button>
    </div>
  );
}
