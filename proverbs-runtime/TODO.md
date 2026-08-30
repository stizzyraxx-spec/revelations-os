# Proverbs XPS Setup — Claude Do This

Hey Claude — please complete all of the following tasks in order. Run every command, verify each step worked, and check off as you go. The goal is to turn this Dell XPS 13 (Windows 11, i7, 32GB RAM) into a local AI inference server that the Mac running Proverbs can connect to over the local network.

---

## Task 1 — Install Ollama

1. Download Ollama for Windows from https://ollama.com/download/windows
2. Run the installer
3. Verify it installed: open PowerShell and run `ollama --version`
4. If it shows a version number, Ollama is installed ✓

---

## Task 2 — Configure Ollama for Network Access

Open PowerShell **as Administrator** (right-click Start → Terminal (Admin)) and run these commands:

```powershell
# Allow Ollama to accept connections from other devices on the network
[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "Machine")

# Open Windows Firewall for Ollama
New-NetFirewallRule -DisplayName "Ollama AI Server" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow

# Kill any running Ollama process and restart it
Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process "ollama" -WindowStyle Hidden
Start-Sleep -Seconds 3

# Verify Ollama is now listening on the network
netstat -an | findstr "11434"
```

You should see `0.0.0.0:11434` in the output — that means it's listening for connections from the Mac.

---

## Task 3 — Pull the AI Models

Run these in PowerShell (these are the models Proverbs will use):

```powershell
# Primary coding model — best quality for Next.js, Prisma, Stripe, Electron projects
# ~14GB download, takes 5-15 minutes depending on internet speed
ollama pull codestral:22b

# Fast utility model for quick questions and simple tasks (~5GB)
ollama pull llama3.1:8b

# Verify both downloaded
ollama list
```

Both models should appear in the list.

---

## Task 4 — Get the XPS IP Address

```powershell
# Get the local network IP address
ipconfig | findstr "IPv4"
```

Look for the line that says something like `IPv4 Address. . . . . . . . . . . : 192.168.1.X`

**Write that IP address here:** `___________________`

This is what the Mac needs to connect.

---

## Task 5 — Test the Server is Working

```powershell
# This should return a JSON list of installed models
curl http://localhost:11434/api/tags

# Test with a quick inference call
curl -X POST http://localhost:11434/api/generate -d "{\"model\": \"llama3.1:8b\", \"prompt\": \"say hi in one word\", \"stream\": false}"
```

If you get a JSON response with a "response" field — the server is working. ✓

---

## Task 6 — Make Ollama Start Automatically on Boot

```powershell
# Create a scheduled task so Ollama starts automatically when Windows boots
$action = New-ScheduledTaskAction -Execute "ollama" -Argument "serve"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$env_var = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName "Ollama AI Server" -Action $action -Trigger $trigger -Settings $settings -Principal $env_var -Force

Write-Host "Ollama will now start automatically on boot."
```

---

## Task 7 — Report Back

Once everything above is done, please write a short summary:
- XPS IP address
- Which models are installed
- Confirm `ollama list` shows both models
- Confirm `netstat` shows `0.0.0.0:11434` listening

Then tell the user: **"Go back to your Mac, open Proverbs, and run: `/backend auto` — it should find this XPS automatically."**

---

## What This Enables

Once connected, the Mac running Proverbs will send all AI requests to this XPS over the local network. The XPS runs Codestral 22B (a model built specifically for coding — comparable to Claude Haiku for code tasks) fully locally. No internet required, no API costs, no data leaves the building.

The Mac stays as the client (Proverbs interface, all the projects) and the XPS does all the heavy compute.
- [ ] **2026-06-26 19:31:42** `a7d2813d` — i want to ensure that proverbs has the capability of solving the issues that it runs into. there should not be any error outputs. it should be able to resolve any problem that it comes agains
- [ ] **2026-06-30 13:47:41** `0aa7965e` — i want to make the logic on the program even better. i need to really tighten up the internal fixing and self resolving to ensure that it can solve problems like claude if it runs into issues
- [ ] **2026-07-06 14:27:31** `bcd366ca` — I want a bible verse to show every single time i use proverbs at the end of every finished output
- [ ] **2026-07-16 16:12:07** `dbf7433a` — i need the proverbs chat where i type my prompt to be pinned at the bottom and never moved by code. i need to be able to enter multiple prompts at a time and it holds the prompts for me like claude does. i need to also make sure that i can use it exactly how i use OPUS 4.8 or even sonnet. i have an XPS 13 I7 32GB RAM i think i can run it internally on that processor and use claude api as a backup for usage. i want to test that set up and see how fast it runs
- [x] **2026-07-16 16:34:37** `dbf7433a` — do what you think is best and free
  - [x] Pinned prompt: replaced absolute-cursor (\x1b7/\x1b8) status line with a
        teardown/repaint output gate (`_uiWrite`). Scrolling can no longer desync it.
        Verified: old code destroyed 12/12 tool output lines, new code keeps 12/12.
  - [x] Multi-prompt queue: kept + routed through the gate; drain re-arms per turn.
  - [ ] Opus/Sonnet switching — NOT done (costs API money, needs explicit approval).
        Server is currently pinned to claude-haiku via ~/.proverbs/config.json.
  - [ ] Local inference on XPS — measured as NOT viable: CPU-only 7B did not finish
        a short prompt in 10 min vs ~3s for cloud Haiku. Needs an NVIDIA GPU box,
        not the XPS 13. cloudMode stays "auto" (cloud primary, local offline fallback).
- [ ] **2026-07-16 16:55:20** `dbf7433a` — i just want it to be able to run at that rate, but is it configured with my dell on the backend to rund there and run faster
- [ ] **2026-07-16 16:58:07** `dbf7433a` — can i run proverbs on this computer and it goes back to the dell or should i just run it on the dell
- [ ] **2026-07-16 16:58:48** `dbf7433a` — so the way i use it now is completely free
- [ ] **2026-07-16 16:59:44** `dbf7433a` — i need to ensure that it resolves the issues it runs into internally unless there is a hard limit which it will let me know
- [ ] **2026-07-21 23:03:42** `c8020f7c` — is proverbs pushed to my gh repo?
- [ ] **2026-07-21 23:04:02** `c8020f7c` — please push the latest version fully please
- [ ] **2026-07-21 23:06:57** `c8020f7c` — how much cheaper is proverbs than claude can you list all the comparisons side by side
- [ ] **2026-07-21 23:07:59** `c8020f7c` — what is it set to by default
- [ ] **2026-07-21 23:08:31** `c8020f7c` — so this is running on the dell by default? its moving fast too!
- [ ] **2026-07-21 23:40:58** `c8020f7c` — what if i try to run it oon my dell will it connect to my dell
- [ ] **2026-07-21 23:49:04** `c8020f7c` — push the latest version of proverbs to the domain and update the jargon on the site
- [ ] **2026-07-25 19:02:07** `de8c1cee` — can you find omni route on gh?
- [ ] **2026-07-25 19:04:23** `de8c1cee` — can you incorporate that into proverbs for me
- [ ] **2026-07-25 19:13:54** `de8c1cee` — <task-notification> <task-id>a8fb8755746028fda</task-id> <output-file>/private/tmp/claude-502/-Users-Stizzop-proverbs/de8c1cee-ac15-4394-8b52-8d5f0d6c2057/tasks/a8fb8755746028fda.output</output-file> <status>completed</status> <summary>Agent "Audit OmniRoute credential handling" finished</summary> <note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note> <result>Both claims verified as written. The relay does forward the credential to a non-provider host, and `ONEPROXY_ENABLED` does default to `"true"`.  Two corrections/additions to my earlier report, neither of which changes the verdict:  **Addition — an opt-in path that does hand your API key to a non-provider host.** `open-sse/utils/proxyFetch.ts:643-655` implements an "edge relay" mode. Instead of tunneling, it demotes the provider URL into headers and POSTs the whole request — body
- [ ] **2026-07-25 19:17:24** `de8c1cee` — make it the best fastest and cheapest way you think to do it
- [ ] **2026-07-25 19:53:50** `de8c1cee` — how will does proverbs work? I need you to look at it and compare it to yourself see where it is falling short in terms of functionality and see if there is anything else that can be enhanced to make it better
- [ ] **2026-08-14 21:55:09** `1fe304cf` — proverbs isnt running right
- [ ] **2026-08-14 22:05:45** `1fe304cf` — no i dont want to donthat then
- [ ] **2026-08-14 22:16:07** `1fe304cf` — what about qwen and olama
- [ ] **2026-08-16 17:22:08** `6e2052eb` — can you test this to confirm everything works the way it's supposed to on this
- [ ] **2026-08-16 17:53:01** `6e2052eb` — /fullsend
- [ ] **2026-08-16 18:47:37** `6e2052eb` — /secaudit
- [ ] **2026-08-24 18:57:23** `e679f8c4` — YOUR LOCAL AI                          │                 ┌────────▼────────┐                 │   Orchestrator  │                 │  Agent Manager   │                 └────────┬────────┘                          │         ┌────────────────┼────────────────┐         ▼                ▼                ▼    Main LLM         Planning Agent    Critic Agent         │                │                │         └────────────────┼────────────────┘                          ▼                    Tool Manager                          │        ┌─────────────────┼─────────────────┐        ▼                 ▼                 ▼     Terminal           Files            Browser        │                 │                 │        └─────────────────┼─────────────────┘                          ▼                   TESTING ENGINE                          │               ┌──────────┴──────────┐               ▼                     ▼           Unit Tests            Behavior Tests               │                     
- [ ] **2026-08-24 18:57:56** `e679f8c4` — The important part: make it test itself  This is where I think your idea gets really interesting.  Don't simply tell the LLM:  "Make sure your answer is correct."  Instead, give it an actual verification subsystem.  For every task:  Understand the task Create a plan Execute Generate tests Run the tests Inspect the results Find failures Modify its work Run the tests again Repeat until passing or the retry limit is reached Give the user the final result + verification report  For coding, for example:  User: Build a login system.  LLM: I'll build the login system.          ↓  Creates: - authentication - database schema - password hashing - sessions - API endpoints - frontend          ↓  SELF-TEST  Test: Can a new user register?         PASS  Test: Can user log in?         PASS  Test: Wrong password rejected?         PASS  Test: SQL injection attempt rejected?         FAIL          ↓  CRITIC  Identifies vulnerability.          ↓  FIX  Updates authentication code.          ↓  TEST AGAIN  SQ
- [ ] **2026-08-24 18:58:44** `e679f8c4` — I want to make these updates for proverbs on windows as well and make a package file to add to gh to download to my dell
- [ ] **2026-08-24 21:50:22** `e679f8c4` — i want to build it
