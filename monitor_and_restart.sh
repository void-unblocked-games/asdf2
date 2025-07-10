#!/bin/bash

SERVER_PID=""

start_server() {
    echo "Starting server..."
    node server.js &
    SERVER_PID=$!
    echo "Server started with PID: $SERVER_PID"
}

stop_server() {
    if [ -n "$SERVER_PID" ]; then
        echo "Stopping server (PID: $SERVER_PID)..."
        kill $SERVER_PID
        wait $SERVER_PID 2>/dev/null
        echo "Server stopped."
    fi
}

# Trap SIGINT (Ctrl+C) to stop the server gracefully
trap "stop_server; exit" SIGINT

start_server

while true; do
    # Check for changes in the git repository
    if ! git diff --quiet HEAD; then
        echo "Changes detected. Restarting server..."
        stop_server
        start_server
    fi
    sleep 2 # Check every 2 seconds
done
