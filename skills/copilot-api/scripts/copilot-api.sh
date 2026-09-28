#!/bin/sh
set -eu

url='http://127.0.0.1:4821/v1/models'
ready() {
    node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(r.status);return r.json()}).then(m=>process.exit(Array.isArray(m.data)&&m.data.length>0?0:1)).catch(()=>process.exit(1))' "$url"
}

if ready; then
    echo 'copilot-api is already running on port 4821.'
    exit 0
fi

log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/copilot-api"
mkdir -p "$log_dir"
log="$log_dir/startup.log"
echo "Log: $log"
nohup copilot-api start --port 4821 >>"$log" 2>&1 </dev/null &
pid=$!

i=0
while [ "$i" -lt 30 ]; do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "copilot-api exited. See $log" >&2
        exit 1
    fi
    if ready; then
        echo "copilot-api is ready at http://127.0.0.1:4821 (PID $pid)"
        exit 0
    fi
    i=$((i + 1))
done

echo "Startup not confirmed. See $log; complete copilot-api auth login first." >&2
exit 1
