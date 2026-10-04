import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useId } from "react";

export function AgentSelect({ label, value, onChange, options, disabled, placeholder = "请选择" }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; placeholder?: string;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  const id = useId();
  return <div className="agent-field">
    <label htmlFor={id}>{label}</label>
    <Select.Root value={value} onValueChange={next => { if (next) onChange(next); }} disabled={disabled}>
      <Select.Trigger id={id} className="agent-select-trigger">
        <Select.Value placeholder={placeholder} /><Select.Icon><ChevronDown size={16} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal><Select.Content className="agent-select-content" position="popper" sideOffset={6} collisionPadding={12}>
        <Select.ScrollUpButton className="agent-select-scroll"><ChevronUp size={16} /></Select.ScrollUpButton>
        <Select.Viewport>{options.map(option => <Select.Item key={option.value} value={option.value}
          disabled={option.disabled} className="agent-select-item">
          <Select.ItemText>{option.label}</Select.ItemText>
          <Select.ItemIndicator><Check size={16} /></Select.ItemIndicator>
        </Select.Item>)}</Select.Viewport>
        <Select.ScrollDownButton className="agent-select-scroll"><ChevronDown size={16} /></Select.ScrollDownButton>
      </Select.Content></Select.Portal>
    </Select.Root>
  </div>;
}
