#!/usr/bin/env python3
"""Start isolated dev dependencies, optionally restore a private backup once."""
import argparse
import os
from pathlib import Path
import secrets
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--restore', type=Path)
args = parser.parse_args()
os.chdir(Path(__file__).resolve().parent.parent)
os.umask(0o077)
compose = ['docker', '--context', 'orbstack', 'compose', '-p', 'mediary-scout-dev', '-f', 'compose.dev.yml']
subprocess.run(compose + ['up', '-d', '--wait'], check=True)
if args.restore:
    count = subprocess.check_output(compose + ['exec', '-T', 'postgres', 'psql', '-U', 'mediatrack', '-d', 'mediatrack', '-Atc', "select count(*) from pg_tables where schemaname='public'"], text=True).strip()
    if count != '0':
        raise SystemExit('Dev database is not empty; refusing to overwrite it. Start without --restore to reuse.')
    with args.restore.open('rb') as stream:
        subprocess.run(compose + ['exec', '-T', 'postgres', 'pg_restore', '--exit-on-error', '--no-owner', '-U', 'mediatrack', '-d', 'mediatrack'], stdin=stream, check=True)
local = Path('.local')
local.mkdir(exist_ok=True, mode=0o700)
env = local / 'dev.env'
if not env.exists():
    env.write_text('\n'.join([
        'MEDIA_TRACK_POSTGRES_URL=postgres://mediatrack:mediatrack@127.0.0.1:5433/mediatrack',
        'PANSOU_BASE_URL=http://127.0.0.1:8089',
        'MEDIA_TRACK_SEARCH_PROVIDER=tmdb',
        'MEDIA_TRACK_WORKFLOW_ADAPTER=pansou',
        'MEDIA_TRACK_STORAGE_ADAPTER=115',
        'MEDIA_TRACK_AGENT_ADAPTER=vercel-ai',
        'MEDIA_TRACK_DEMO_SEED=0',
        'MEDIA_TRACK_INPROCESS_WORKER=0',
        'TELEGRAM_ENABLED=0',
        'MEDIA_TRACK_AGENT_TOKEN=' + secrets.token_hex(32),
        'TZ=Asia/Shanghai', '',
    ]))
env.chmod(0o600)
print('Dev services ready. Run npm run dev:local (http://127.0.0.1:3001). Worker and Telegram are off by default.')
