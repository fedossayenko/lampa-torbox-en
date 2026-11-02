#!/usr/bin/env python3
"""Voice search's understanding on the old MacBook: Claude Code, signed in with the user's own Claude plan.

The stick posts what was heard (POST /understand, its X-Play-Token, {"text": ...}) and gets voice-prompt.json's
answer back: what was asked and the films it may be, each with its confidence; the stick passes that to the worker's
/voice/find. One `claude -p` is always started ahead, waiting for its request (stream-json on stdin): an answer takes
~2 s instead of ~7 s. Each answers once (no conversation builds up) and the next starts meanwhile; one left waiting is
replaced every 30 minutes (today's date in the prompt, the sign-in fresh). Not answering (502: the plan's limit, a
timeout) is fine: the worker then reads the text with a free model.

POST /recap (lampa-native's Story so far): {key, series, year, upto, episodes: [[label, name, overview]]} -> {text},
Claude's "previously on" up to that episode, written once by Opus (a one-off `claude -p`, ~20-40 s) and kept in
~/.lampa-intros/recaps.json under its key ("tv_1396 S2E8").

launchd runs it in the user's session (voice-claude.plist): Claude Code's sign-in is in the login keychain, which
SSH sessions can't open. Python 3.9, standard library only. Port 8790, the home network.
Files in ~/lampa-intros: this, voice-prompt.json; ~/.lampa-intros: play_token (the stick's, never printed), voice.log.
"""
import hmac
import json
import os
import re
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
RECAPS = os.path.expanduser('~/.lampa-intros/recaps.json')
RECAP_MODEL = 'opus'  # user 2026-11-02: Sonnet or Opus; written once per episode, so the better one
RECAP_S = 140
RECAP_PROMPT = (
    'You write a "previously on" recap for a viewer coming back to a TV series after a break. Write it in {lang}, '
    '120-180 words, plain prose in two or three short paragraphs: no title, no lists, no markdown. The viewer watches '
    'the series in {lang}: give character and place names the way the {lang} dub or translation usually does. Cover '
    'the story up to and including the episode named: the main characters, where each one stands, the open threads; '
    'the latest episodes in the most detail. Never mention or hint at anything that happens after that episode, even '
    'if you know the series well: when unsure whether something has happened by then, leave it out. Use the episode '
    'summaries given (some may be in another language) and your own knowledge of the series up to that episode.')


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


recap_lock = threading.Lock()


def recaps():
    try:
        with open(RECAPS, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def recap(o):
    """Claude's recap up to o['upto'], from the file when written before; None when Claude didn't answer. Kept for
    good, so only from a real key and TMDB's episodes (a TMDB hiccup sends none: Claude would write from memory)."""
    if not re.fullmatch(r'(tv|movie)_\d+ S\d+E\d+', str(o.get('key', ''))) or not o.get('episodes'):
        return None
    # the language the viewer listens in (lampa-native's audio setting): "Russian"; English recaps keep their old keys
    lang = str(o.get('language') or 'English')
    if not re.fullmatch(r'[A-Za-z]{2,20}', lang):
        lang = 'English'
    key = str(o.get('key', ''))[:80] + ('' if lang == 'English' else ' ' + lang)
    with recap_lock:
        kept = recaps().get(key)
    if kept:
        return kept
    lines = [f'{e[0]} "{e[1]}": {e[2]}' for e in o.get('episodes', [])[-60:] if len(e) == 3]
    msg = (f'Series: {str(o.get("series", ""))[:120]} ({str(o.get("year", ""))[:4]}). The viewer has watched up to '
           f'{str(o.get("upto", ""))[:40]}.\n\nEpisode summaries (TMDB), oldest first:\n' + '\n'.join(lines)[:20000])
    r = subprocess.run([CLAUDE, '-p', '--model', RECAP_MODEL, '--output-format', 'json', '--tools', '',
                        '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
                        '--system-prompt', RECAP_PROMPT.format(lang=lang)], input=msg, capture_output=True, text=True,
                       timeout=RECAP_S, cwd='/tmp')
    out = json.loads(r.stdout or '{}')
    text = (out.get('result') or '').strip()
    if out.get('is_error') or len(text) < 300:  # 120-180 words; shorter is Claude saying it can't
        log('recap:', text[:200] or r.stderr[:200])
        return None
    with recap_lock:
        kept_all = recaps()
        kept_all[key] = text
        with open(RECAPS + '.tmp', 'w', encoding='utf-8') as f:
            json.dump(kept_all, f, ensure_ascii=False)
        os.replace(RECAPS + '.tmp', RECAPS)
    return text


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            with open(TOKEN, encoding='utf-8') as f:
                token = f.read().strip()
            if self.path not in ('/understand', '/recap') or not hmac.compare_digest(
                    self.headers.get('X-Play-Token', '').encode(), token.encode()):
                return self.answer(403, {'error': 'Forbidden.'})
            if self.path == '/recap':
                n = min(int(self.headers.get('Content-Length') or 0), 65536)
                t = time.time()
                o = json.loads(self.rfile.read(n) or b'{}')
                text = recap(o)
                log(f'{time.time() - t:.1f} s recap', repr(o.get('key')), '->', (text or '')[:80])
                return self.answer(200 if text else 502, {'text': text} if text else {'error': 'No recap.'})
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
