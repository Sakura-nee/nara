# Nara Quest Agent

## Features

- **Automated Solving**: Continuously monitors the network for new quest rounds.
- **Fast Response**: Immediately triggers the AI to submit the answer without unnecessary reasoning steps formatting constraints.
- **Beautiful TUI**: Fixed-position terminal interface with live countdowns, difficulty visualization, success statistics, and an activity log built completely with ANSI escape codes.
- **Robust Error Handling**: Handles staking requirement errors, parses CLI output safely, and smartly retries only when explicitly facing a "Wrong answer" or "Empty completion".

## Requirements

- [Bun](https://bun.com) (v1.3.x or later)
- Nara CLI (`naracli`) installed and authenticated

## Installation & Setup

1. Install dependencies:
   ```bash
   bun install
   ```

2. Configuration is handled in `src/agent/config.ts`. 

## Usage

Simply start the agent with Bun:

```bash
bun run agent.ts
```

The agent will run continuously, polling for new quests and submitting answers automatically.

## Architecture

- `src/agent/runner.ts`: The main runner loop and quest observer logic.
- `src/agent/tools.ts`: Tool execution and callback handlers.
- `src/tui/renderer.ts`: Fixed-position TUI drawing engine.
- `src/quest.ts`: Wrapper for interacting with the `naracli` command-line tool.
