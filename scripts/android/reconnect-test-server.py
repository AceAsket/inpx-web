"""Loopback-only lifecycle controller for the generated read-only SMB fixture."""
import argparse
import json
import os
import signal
import pathlib
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser()
parser.add_argument('library', type=pathlib.Path)
args = parser.parse_args()
library = args.library.resolve()
probe = library / 'reconnect-probe.bin'
probe.write_bytes((bytes(range(251)) * ((8 * 1024 * 1024 // 251) + 1))[:8 * 1024 * 1024])
child = None
log = (library / 'smb-reconnect.log').open('ab')

def stop():
    global child
    if child is not None and child.poll() is None:
        os.kill(child.pid, signal.SIGCONT)
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    child = None

def start():
    global child
    if child is not None and child.poll() is None:
        os.kill(child.pid, signal.SIGCONT)
        return
    child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).with_name('smb-test-server.py')), str(library)], stdout=log, stderr=log)
    end = time.monotonic() + 10
    while time.monotonic() < end:
        if child.poll() is not None:
            raise RuntimeError('SMB fixture exited; inspect smb-reconnect.log')
        try:
            with socket.create_connection(('127.0.0.1', 1445), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError('SMB fixture did not start')

class Controller(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            if self.path == '/offline':
                stop()
            elif self.path == '/online':
                start()
            elif self.path == '/stall' and child is not None:
                os.kill(child.pid, signal.SIGSTOP)
            else:
                self.send_error(404)
                return
            body = json.dumps({'online': child is not None, 'pid': child.pid if child else None}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            self.send_error(500, type(error).__name__)

try:
    start()
    print('SMB reconnect fixture ready: localhost:1445; controller localhost:1446', flush=True)
    HTTPServer(('127.0.0.1', 1446), Controller).serve_forever()
finally:
    stop()
    log.close()
