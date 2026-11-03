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


def _port_free(port: int, host="0.0.0.0") -> bool:
    s = socket.socket()
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def lan_ips() -> list[str]:
    """IPv4 addresses of this computer in the local network (Wi-Fi/Ethernet)."""
    ips = []
    try:  # the address used for outgoing traffic is the most likely Wi-Fi/LAN one
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    private = [ip for ip in ips if ip.startswith(("192.168.", "10.")) or
               (ip.startswith("172.") and 16 <= int(ip.split(".")[1]) <= 31)]
    return private or [ip for ip in ips if not ip.startswith("127.")]


def _serve(port: int, host: str = "127.0.0.1"):
    import uvicorn
    from .server import app
    config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False)
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
    ap.add_argument("--lan", action="store_true",
                    help="открыть интерфейс с телефона/планшета в той же Wi-Fi сети (по ссылке с ключом)")
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

    if args.lan:
        import secrets
        from .server import app
        port = args.port or settings().get("port") or (8765 if _port_free(8765) else _free_port())
        token = secrets.token_urlsafe(9)
        app.state.lan_token = token
        app.state.lan_urls = [f"http://{ip}:{port}/?key={token}" for ip in lan_ips()]
        server, thread = _serve(port, host="0.0.0.0")
    else:
        port = args.port or settings().get("port") or _free_port()
        server, thread = _serve(port)
    url = f"http://127.0.0.1:{port}/"
    logging.info("UI at %s  (data: %s)", url, DATA_DIR)
    if args.lan:
        from .server import app
        print("\n=== Доступ с телефона (тот же Wi-Fi) ===")
        for u in app.state.lan_urls:
            print("  " + u)
        print("Ссылку и QR-код также показывает кнопка «📱» в окне программы.")
        print("Если Windows спросит про брандмауэр — разрешите доступ для частных сетей.\n")

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
