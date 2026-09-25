# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=zcode
# HERDR_INTEGRATION_VERSION=1

param([string]$Action = "")

if ($env:HERDR_ENV -ne "1") { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:HERDR_PANE_ID)) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
try {
    $payload = if ([string]::IsNullOrWhiteSpace($inputText)) { $null } else { $inputText | ConvertFrom-Json }
} catch {
    exit 0
}

# ZCode has no argv action contract: the event arrives only as stdin JSON, and
# Herdr registers one hook per event. Derive the action from hook_event_name,
# which ZCode writes in Claude's snake_case form, so the payload handling below
# stays identical to claude's.
if ([string]::IsNullOrWhiteSpace($Action)) {
    $Action = switch ($payload.hook_event_name) {
        "SessionStart" { "session" }
        "PermissionRequest" { "permission" }
        default { "" }
    }
}

if ($Action -ne "session" -and $Action -ne "permission") { exit 0 }

# ZCode's hook event set has no SubagentStop; a subagent finishing must not
# revive an idle pane, and ZCode reports subagent work through its own events.
# (ZCode contracts/src/hooks/index.ts:7-15)
if (-not [string]::IsNullOrWhiteSpace($payload.agent_id)) { exit 0 }

$source = "herdr:zcode"
$paneId = $env:HERDR_PANE_ID

if ($Action -eq "permission") {
    $toolName = [string]$payload.tool_name
    if ([string]::IsNullOrWhiteSpace($toolName)) { $toolName = "tool" }

    # A readable rendering of what is being approved: that text is the thing the
    # reader is judging.
    $summary = ""
    foreach ($key in @("command", "cmd", "file_path", "path", "url", "pattern", "query")) {
        $value = $payload.tool_input.$key
        if ($value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)) {
            $summary = $value
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($summary) -and $null -ne $payload.tool_input) {
        try { $summary = $payload.tool_input | ConvertTo-Json -Depth 8 -Compress } catch { $summary = "" }
    }

    $waitMs = 3000
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CLAUDE_PERMISSION_WAIT_MS)) {
        $parsed = 0
        if ([int]::TryParse($env:HERDR_CLAUDE_PERMISSION_WAIT_MS, [ref]$parsed)) { $waitMs = $parsed }
    }
    if ($waitMs -lt 0) { $waitMs = 0 }
    if ($waitMs -gt 600000) { $waitMs = 600000 }

    $requestId = "$source`:$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()):$((Get-Random -Maximum 1000000).ToString('000000'))"

    # The request must not outlive the wait: once the hook exits nobody can
    # collect an answer, so a lingering panel would offer a choice that goes
    # nowhere. Option ids are ours, so the answer cannot be confused with
    # anything the agent wrote.
    $reportArgs = @(
        "pane", "report-interaction", $paneId,
        "--source", $source,
        "--request-id", $requestId,
        "--kind", "approval",
        "--title", "Allow $toolName?",
        "--summary", $summary,
        "--ttl-ms", "$($waitMs + 5000)",
        "--question", "decision=Allow $toolName to run?",
        "--option", "decision=allow=Allow",
        "--option", "decision=deny=Deny"
    )
    $reported = $false
    try {
        & herdr @reportArgs 2>$null | Out-Null
        $reported = $LASTEXITCODE -eq 0
    } catch {
        $reported = $false
    }

    $decision = $null
    if ($reported) {
        $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
        while ($null -eq $decision) {
            $taken = $null
            try {
                $taken = & herdr pane take-interaction-answer $paneId --source $source --request-id $requestId 2>$null
            } catch {
                $taken = $null
            }
            if (-not [string]::IsNullOrWhiteSpace($taken)) {
                try { $state = $taken | ConvertFrom-Json } catch { $state = $null }
                if ($null -ne $state) {
                    foreach ($answer in $state.answers) {
                        if ($answer.question_id -ne "decision") { continue }
                        foreach ($optionId in $answer.option_ids) {
                            if ($optionId -eq "allow" -or $optionId -eq "deny") { $decision = $optionId; break }
                        }
                        if ($null -ne $decision) { break }
                    }
                    # No answer this poll. `pending` distinguishes "not decided
                    # yet" from "the question is gone", and only the latter ends
                    # the wait early.
                    if ($null -eq $decision -and -not $state.pending) { break }
                }
            }
            if ([DateTime]::UtcNow -ge $deadline) { break }
            if ($null -eq $decision) { Start-Sleep -Milliseconds 50 }
        }
    }

    # Withdraw either way: on success taking the answer already cleared it, and
    # on timeout this stops a panel outliving the hook.
    try {
        & herdr pane clear-interaction $paneId --source $source --request-id $requestId 2>$null | Out-Null
    } catch {
    }

    if ($null -eq $decision) {
        # No decision: exit with no output so Claude draws its own prompt.
        exit 0
    }
    # The decision must be nested under hookSpecificOutput as decision.behavior.
    # Claude validates this shape explicitly: a top-level decision is its legacy
    # approve/block field, and a behavior outside decision is rejected without
    # taking effect.
    $decisionBody = @{ behavior = $decision }
    if ($decision -eq "deny") { $decisionBody.message = "Denied in the Herdr web UI." }
    $out = @{ hookSpecificOutput = @{ hookEventName = "PermissionRequest"; decision = $decisionBody } }
    Write-Output ($out | ConvertTo-Json -Depth 6 -Compress)
    exit 0
}

$sessionId = $payload.session_id
if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }

$seq = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    $args = @(
        "pane",
        "report-agent-session",
        $paneId,
        "--source",
        $source,
        "--agent",
        "zcode",
        "--seq",
        "$seq",
        "--agent-session-id",
        "$sessionId"
    )
    # ZCode does expose transcript_path, but it is a throwaway file holding only
    # the current message and it is deleted when the hook returns
    # (configured-runner-input.ts:25-29,63-66). Reporting it would persist a path
    # that is gone by the next read, so only the session id is reported.
    if ($payload.hook_event_name -eq "SessionStart" -and $payload.source -is [string] -and -not [string]::IsNullOrWhiteSpace($payload.source)) {
        $args += @("--session-start-source", "$($payload.source)")
    }
    & herdr @args 2>$null | Out-Null
} catch {
}
