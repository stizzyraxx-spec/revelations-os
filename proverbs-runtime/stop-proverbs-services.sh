#!/bin/bash

PID_FILE=/tmp/litellm.pid

if [ ! -f "$PID_FILE" ]; then
  echo "No LiteLLM PID file found at $PID_FILE. Is it running?"
  exit 1
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping LiteLLM proxy (PID $PID)..."
  kill "$PID"
  rm -f "$PID_FILE"
  echo "LiteLLM proxy stopped."
else
  echo "Process $PID is not running. Cleaning up PID file."
  rm -f "$PID_FILE"
fi
