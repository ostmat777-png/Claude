"""Entry point.

    python -m zabroshki                 # desktop window (WebView2 on Windows)
    python -m zabroshki --browser       # open UI in the default browser instead
    python -m zabroshki --server-only   # just the local server (for tests)
    python -m zabroshki scan --bbox S,W,N,E [--name NAME]   # headless search
    python -m zabroshki evaluate [--run RUN_ID]             # quality on examples/positives.csv
"""
from __future__ import annotations

import argparse
import logging
import socket
import sys
import threading
import time
import webbrowser

from .config import DATA_DIR, settings


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _setup_logging(verbose=False):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    handlers = [logging.StreamHandler(sys.stdout),
                logging.FileHandler(DATA_DIR / "zabroshki.log", encoding="utf-8")]
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=handlers)
    for noisy in ("urllib3", "httpx", "PIL", "uvicorn.access", "filelock", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _serve(port: int):
    import uvicorn
    from .server import app
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True, name="uvicorn")
    t.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    return server, t


def main(argv=None):
    ap = argparse.ArgumentParser(prog="zabroshki")
    ap.add_argument("command", nargs="?", default="gui", choices=["gui", "scan", "evaluate", "prefetch-models"])
    ap.add_argument("--browser", action="store_true")
    ap.add_argument("--server-only", action="store_true")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--bbox", help="S,W,N,E for headless scan")
    ap.add_argument("--name", default=None)
    ap.add_argument("--run", type=int, default=None)
    ap.add_argument("--options", default=None, help="JSON with pipeline option overrides")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    _setup_logging(args.verbose)

    if args.command == "scan":
        from .cli import headless_scan
        return headless_scan(args.bbox, args.name, args.options)
    if args.command == "evaluate":
        from .evaluate import main as ev
        return ev(args.run)
    if args.command == "prefetch-models":
        from .models import prefetch_models
        return prefetch_models()

    port = args.port or settings().get("port") or _free_port()
    server, thread = _serve(port)
    url = f"http://127.0.0.1:{port}/"
    logging.info("UI at %s  (data: %s)", url, DATA_DIR)

    if args.server_only:
        try:
            while thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        return 0

    if not args.browser:
        try:
            import webview  # pywebview
            webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
            try:
                webview.settings["ALLOW_DOWNLOADS"] = True
            except Exception:
                pass
            webview.create_window("Заброшки — поиск заброшенных объектов", url,
                                  width=1500, height=950, min_size=(1000, 650))
            webview.start(private_mode=False)
            server.should_exit = True
            return 0
        except Exception as e:  # no WebView2 / GUI backend -> browser fallback
            logging.warning("Окно WebView недоступно (%s), открываю в браузере", e)
    webbrowser.open(url)
    print(f"\nПрограмма открыта в браузере: {url}\nЗакройте это окно (Ctrl+C) для выхода.\n")
    try:
        while thread.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
