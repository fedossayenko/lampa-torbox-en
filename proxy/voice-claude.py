#!/usr/bin/env python3
"""Voice search's understanding on the old MacBook: Claude Code, signed in with the user's own Claude plan.

The stick posts what was heard (POST /understand, its X-Play-Token, {"text": ...}) and gets voice-prompt.json's
answer back: what was asked and the films it may be, each with its confidence; the stick passes that to the worker's
/voice/find. One `claude -p` is always started ahead, waiting for its request (stream-json on stdin): an answer takes
~2 s instead of ~7 s. Each answers once (no conversation builds up) and the next starts meanwhile; one left waiting is
replaced every 30 minutes (today's date in the prompt, the sign-in fresh). Not answering (502: the plan's limit, a
timeout) is fine: the worker then reads the text with a free model.

launchd runs it in the user's session (voice-claude.plist): Claude Code's sign-in is in the login keychain, which
SSH sessions can't open. Python 3.9, standard library only. Port 8790, the home network.
Files in ~/lampa-intros: this, voice-prompt.json; ~/.lampa-intros: play_token (the stick's, never printed), voice.log.
"""
import hmac
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = os.path.expanduser('~/.lampa-intros/play_token')
CLAUDE = os.path.expanduser('~/.local/bin/claude')
MODEL = 'sonnet'  # 12/12 in the test of 2026-10-31 as Opus, ~2 s warm against Opus's 4.5 s
FRESH_S = 1800
WAIT_S = 25  # then the stick's fallback


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def prompt():
    with open(os.path.join(HERE, 'voice-prompt.json'), encoding='utf-8') as f:
        return '\n'.join(json.load(f)['system']).replace('{today}', time.strftime('%Y-%m-%d'))


def start():
    p = subprocess.Popen([CLAUDE, '-p', '--model', MODEL, '--input-format', 'stream-json', '--output-format',
                          'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
                          '--no-session-persistence', '--system-prompt', prompt()],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                         cwd='/tmp')
    return p, time.time()


def stop(p):
    p.kill()
    p.wait()


lock = threading.Lock()
spare = None  # (process, started)


def take():
    """The waiting process, and the next one started."""
    global spare
    with lock:
        if spare is None or spare[0].poll() is not None:
            spare = start()  # it died (or the first request): this one answers cold
        p, spare = spare[0], start()
    return p


def refresh():
    global spare
    while True:
        time.sleep(60)
        with lock:
            if spare and time.time() - spare[1] > FRESH_S:
                stop(spare[0])
                spare = start()


def understand(text):
    p = take()
    timer = threading.Timer(WAIT_S, p.kill)
    timer.start()
    try:
        p.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n')
        p.stdin.flush()
        for line in p.stdout:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get('type') == 'result':
                r = o.get('result') or ''
                if o.get('is_error') or '{' not in r:
                    log('claude:', r[:200])
                    return None
                return json.loads(r[r.index('{'):r.rindex('}') + 1])
        return None  # killed: too slow
    finally:
        timer.cancel()
        stop(p)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            with open(TOKEN, encoding='utf-8') as f:
                token = f.read().strip()
            if self.path != '/understand' or not hmac.compare_digest(
                    self.headers.get('X-Play-Token', '').encode(), token.encode()):
                return self.answer(403, {'error': 'Forbidden.'})
            n = min(int(self.headers.get('Content-Length') or 0), 4096)
            text = str(json.loads(self.rfile.read(n) or b'{}').get('text', '')).strip()[:300]
            if not text:
                return self.answer(400, {'error': 'No text.'})
            t = time.time()
            got = understand(text)
            log(f'{time.time() - t:.1f} s', repr(text), '->', json.dumps(got, ensure_ascii=False)[:300])
            self.answer(200 if got else 502, got or {'error': 'Not understood.'})
        except Exception as e:  # the stick falls back to the worker's model
            log('failed:', e)
            self.answer(502, {'error': 'Failed.'})

    def answer(self, code, o):
        body = json.dumps(o, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    spare = start()
    threading.Thread(target=refresh, daemon=True).start()
    log('listening on 8790,', MODEL)
    ThreadingHTTPServer(('0.0.0.0', 8790), Handler).serve_forever()
