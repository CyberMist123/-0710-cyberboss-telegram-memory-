#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT))
os.environ["CYBERBOSS_DASHBOARD_KEYS_FILE"] = str(Path(tempfile.mkdtemp(prefix="dashboard-freeze-")) / "keys.local.json")
spec = importlib.util.spec_from_file_location("dashboard_write_freeze", KIT / "dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


def main():
    server = HTTPServer(("127.0.0.1", 0), dashboard.H)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for endpoint in sorted(dashboard.FROZEN_WRITE_ENDPOINTS):
            payload = request_frozen_endpoint(server.server_port, endpoint)
            assert payload["error"] == "write_frozen", payload
        print(f"dashboard write freeze: {len(dashboard.FROZEN_WRITE_ENDPOINTS)} endpoints -> 403")
    finally:
        server.shutdown()
        server.server_close()


def request_frozen_endpoint(port, endpoint):
    last_error = None
    for _ in range(3):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{endpoint}",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json", "X-Api-Token": "fixture"},
        )
        try:
            urllib.request.urlopen(request, timeout=2)
            raise AssertionError(f"{endpoint} did not return 403")
        except urllib.error.HTTPError as error:
            assert error.code == 403, (endpoint, error.code)
            return json.loads(error.read().decode("utf-8"))
        except (ConnectionResetError, TimeoutError, OSError) as error:
            last_error = error
            time.sleep(0.05)
    raise last_error


if __name__ == "__main__":
    main()
